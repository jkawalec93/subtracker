import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  buildCardMigrationPlan,
  validateFundingChain,
} from '@domain/payment-methods';
import type {
  CardBrand,
  PaymentMethod,
  PaymentMethodKind,
} from '@domain/types';
import type { SubtrackDatabase } from '../client';
import { mapPaymentMethod, mapService } from '../mappers';
import {
  cardMigrationItems,
  cardMigrations,
  paymentMethods,
  services,
} from '../schema';

export interface CreatePaymentMethodInput {
  name: string;
  kind: PaymentMethodKind;
  cardBrand?: CardBrand | null;
  last4?: string | null;
  expiryMonth?: number | null;
  expiryYear?: number | null;
  fundedById?: string | null;
  replacesId?: string | null;
}

export interface UpdatePaymentMethodInput {
  name?: string;
  kind?: PaymentMethodKind;
  cardBrand?: CardBrand | null;
  last4?: string | null;
  expiryMonth?: number | null;
  expiryYear?: number | null;
  fundedById?: string | null;
}

function normalizeCardFields(
  kind: PaymentMethodKind,
  input: {
    cardBrand?: CardBrand | null;
    last4?: string | null;
    expiryMonth?: number | null;
    expiryYear?: number | null;
  },
) {
  if (kind !== 'card') {
    return {
      cardBrand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    };
  }

  const last4 =
    input.last4 !== undefined && input.last4 !== null && input.last4.trim() !== ''
      ? input.last4.trim()
      : null;
  if (last4 !== null && !/^\d{4}$/.test(last4)) {
    throw new Error('last4 must be exactly 4 digits.');
  }

  const expiryMonth = input.expiryMonth ?? null;
  const expiryYear = input.expiryYear ?? null;
  if (
    (expiryMonth !== null && (expiryMonth < 1 || expiryMonth > 12)) ||
    (expiryYear !== null && expiryYear < 2000)
  ) {
    throw new Error('Invalid card expiry month or year.');
  }

  return {
    cardBrand: input.cardBrand ?? 'other',
    last4,
    expiryMonth,
    expiryYear,
  };
}

export class PaymentMethodsRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  list(includeDeleted = false): PaymentMethod[] {
    const rows = includeDeleted
      ? this.db.select().from(paymentMethods).all()
      : this.db
          .select()
          .from(paymentMethods)
          .where(isNull(paymentMethods.deletedAt))
          .all();
    return rows.map(mapPaymentMethod);
  }

  getById(id: string): PaymentMethod | null {
    const row = this.db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.deletedAt)))
      .get();
    return row ? mapPaymentMethod(row) : null;
  }

  create(input: CreatePaymentMethodInput): PaymentMethod {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Payment method name is required.');
    }

    const now = new Date().toISOString();
    const id = uuidv7();
    const cardFields = normalizeCardFields(input.kind, input);
    const fundedById = input.fundedById ?? null;
    const replacesId = input.kind === 'card' ? (input.replacesId ?? null) : null;

    return this.db.transaction((tx) => {
      const existingMethods = tx
        .select()
        .from(paymentMethods)
        .where(isNull(paymentMethods.deletedAt))
        .all()
        .map(mapPaymentMethod);

      const chainCheck = validateFundingChain(
        existingMethods,
        id,
        input.kind,
        fundedById,
      );
      if (!chainCheck.valid) {
        throw new Error(`Invalid funding chain: ${chainCheck.reason}`);
      }

      if (replacesId !== null) {
        const replaced = existingMethods.find((m) => m.id === replacesId);
        if (!replaced) {
          throw new Error('Replaced payment method not found.');
        }
      }

      const [inserted] = tx
        .insert(paymentMethods)
        .values({
          id,
          name,
          kind: input.kind,
          ...cardFields,
          fundedById,
          replacesId,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .all();

      if (!inserted) {
        throw new Error('Failed to create payment method.');
      }

      const createdMethod = mapPaymentMethod(inserted);

      if (replacesId !== null) {
        const openWithoutReplacement = tx
          .select()
          .from(cardMigrations)
          .where(
            and(
              eq(cardMigrations.oldMethodId, replacesId),
              isNull(cardMigrations.newMethodId),
              isNull(cardMigrations.completedAt),
              isNull(cardMigrations.deletedAt),
            ),
          )
          .get();

        if (openWithoutReplacement) {
          tx.update(cardMigrations)
            .set({ newMethodId: createdMethod.id, updatedAt: now })
            .where(eq(cardMigrations.id, openWithoutReplacement.id))
            .run();
        } else {
          const allServices = tx
            .select()
            .from(services)
            .where(isNull(services.deletedAt))
            .all()
            .map(mapService);
          const plan = buildCardMigrationPlan(
            replacesId,
            [...existingMethods, createdMethod],
            allServices,
          );
          const migrationId = uuidv7();
          tx.insert(cardMigrations)
            .values({
              id: migrationId,
              oldMethodId: replacesId,
              newMethodId: createdMethod.id,
              completedAt: null,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            })
            .run();

          for (const svc of plan.directServices) {
            tx.insert(cardMigrationItems)
              .values({
                id: uuidv7(),
                migrationId,
                serviceId: svc.id,
                paymentMethodId: null,
                doneAt: null,
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              })
              .run();
          }

          for (const group of plan.intermediaries) {
            tx.insert(cardMigrationItems)
              .values({
                id: uuidv7(),
                migrationId,
                serviceId: null,
                paymentMethodId: group.intermediary.id,
                doneAt: null,
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              })
              .run();
          }
        }
      }

      return createdMethod;
    });
  }

  update(id: string, patch: UpdatePaymentMethodInput): PaymentMethod {
    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
      const existingMethods = tx
        .select()
        .from(paymentMethods)
        .where(isNull(paymentMethods.deletedAt))
        .all()
        .map(mapPaymentMethod);

      const current = existingMethods.find((m) => m.id === id);
      if (!current) {
        throw new Error('Payment method not found.');
      }

      const nextKind = patch.kind ?? current.kind;
      const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
      if (!nextName) {
        throw new Error('Payment method name is required.');
      }

      const nextFundedById =
        patch.fundedById !== undefined ? patch.fundedById : current.fundedById;

      const chainCheck = validateFundingChain(
        existingMethods,
        id,
        nextKind,
        nextFundedById,
      );
      if (!chainCheck.valid) {
        throw new Error(`Invalid funding chain: ${chainCheck.reason}`);
      }

      const cardFields = normalizeCardFields(nextKind, {
        cardBrand: patch.cardBrand !== undefined ? patch.cardBrand : current.cardBrand,
        last4: patch.last4 !== undefined ? patch.last4 : current.last4,
        expiryMonth:
          patch.expiryMonth !== undefined ? patch.expiryMonth : current.expiryMonth,
        expiryYear:
          patch.expiryYear !== undefined ? patch.expiryYear : current.expiryYear,
      });

      const [updated] = tx
        .update(paymentMethods)
        .set({
          name: nextName,
          kind: nextKind,
          ...cardFields,
          fundedById: nextFundedById,
          updatedAt: now,
        })
        .where(eq(paymentMethods.id, id))
        .returning()
        .all();

      if (!updated) {
        throw new Error('Failed to update payment method.');
      }
      return mapPaymentMethod(updated);
    });
  }

  setArchived(id: string, archived: boolean): PaymentMethod {
    const now = new Date().toISOString();
    const [updated] = this.db
      .update(paymentMethods)
      .set({
        archivedAt: archived ? now : null,
        updatedAt: now,
      })
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.deletedAt)))
      .returning()
      .all();

    if (!updated) {
      throw new Error('Payment method not found.');
    }
    return mapPaymentMethod(updated);
  }

  softDelete(id: string): void {
    const now = new Date().toISOString();
    const result = this.db
      .update(paymentMethods)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.deletedAt)))
      .run();
    if (result.changes === 0) {
      throw new Error('Payment method not found.');
    }
  }
}

