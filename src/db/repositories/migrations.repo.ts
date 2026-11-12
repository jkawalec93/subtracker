import { and, desc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  buildCardMigrationPlan,
  validateFundingChain,
} from '@domain/payment-methods';
import type {
  CardMigration,
  CardMigrationItem,
  PaymentMethod,
  Service,
} from '@domain/types';
import type { SubtrackDatabase } from '../client';
import {
  mapCardMigration,
  mapCardMigrationItem,
  mapPaymentMethod,
  mapService,
} from '../mappers';
import {
  cardMigrationItems,
  cardMigrations,
  paymentMethods,
  services,
} from '../schema';

export interface CardMigrationDetail {
  migration: CardMigration;
  oldMethod: PaymentMethod | null;
  newMethod: PaymentMethod | null;
  items: Array<{
    item: CardMigrationItem;
    service: Service | null;
    intermediary: PaymentMethod | null;
    dependentServices: Service[];
  }>;
}

export class MigrationsRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  list(): CardMigration[] {
    return this.db
      .select()
      .from(cardMigrations)
      .where(isNull(cardMigrations.deletedAt))
      .orderBy(desc(cardMigrations.createdAt))
      .all()
      .map(mapCardMigration);
  }

  getDetail(migrationId: string): CardMigrationDetail | null {
    const migrationRow = this.db
      .select()
      .from(cardMigrations)
      .where(
        and(eq(cardMigrations.id, migrationId), isNull(cardMigrations.deletedAt)),
      )
      .get();

    if (!migrationRow) {
      return null;
    }

    const migration = mapCardMigration(migrationRow);
    const allMethods = this.db.select().from(paymentMethods).all().map(mapPaymentMethod);
    const allServices = this.db.select().from(services).all().map(mapService);
    const methodsById = new Map(allMethods.map((m) => [m.id, m]));
    const servicesById = new Map(allServices.map((s) => [s.id, s]));

    const itemRows = this.db
      .select()
      .from(cardMigrationItems)
      .where(
        and(
          eq(cardMigrationItems.migrationId, migrationId),
          isNull(cardMigrationItems.deletedAt),
        ),
      )
      .all()
      .map(mapCardMigrationItem);

    const activeMethods = allMethods.filter((m) => m.deletedAt === null);
    const activeServices = allServices.filter((s) => s.deletedAt === null);

    const items = itemRows.map((item) => {
      const service = item.serviceId ? (servicesById.get(item.serviceId) ?? null) : null;
      const intermediary = item.paymentMethodId
        ? (methodsById.get(item.paymentMethodId) ?? null)
        : null;

      let dependentServices: Service[] = [];
      if (intermediary) {
        const subtree = collectSubtreeIds(activeMethods, intermediary.id);
        dependentServices = activeServices
          .filter(
            (s) =>
              s.status !== 'cancelled' &&
              s.paymentMethodId !== null &&
              subtree.has(s.paymentMethodId),
          )
          .sort((a, b) => a.name.localeCompare(b.name));
      }

      return {
        item,
        service,
        intermediary,
        dependentServices,
      };
    });

    return {
      migration,
      oldMethod: methodsById.get(migration.oldMethodId) ?? null,
      newMethod: migration.newMethodId
        ? (methodsById.get(migration.newMethodId) ?? null)
        : null,
      items,
    };
  }

  startMigration(oldMethodId: string, newMethodId: string | null = null): CardMigration {
    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
      const existingOpen = tx
        .select()
        .from(cardMigrations)
        .where(
          and(
            eq(cardMigrations.oldMethodId, oldMethodId),
            isNull(cardMigrations.completedAt),
            isNull(cardMigrations.deletedAt),
          ),
        )
        .get();

      if (existingOpen) {
        throw new Error('An open migration already exists for this payment method.');
      }

      const activeMethods = tx
        .select()
        .from(paymentMethods)
        .where(isNull(paymentMethods.deletedAt))
        .all()
        .map(mapPaymentMethod);

      if (newMethodId !== null && !activeMethods.some((m) => m.id === newMethodId)) {
        throw new Error('Replacement payment method not found.');
      }

      const activeServices = tx
        .select()
        .from(services)
        .where(isNull(services.deletedAt))
        .all()
        .map(mapService);

      const plan = buildCardMigrationPlan(oldMethodId, activeMethods, activeServices);
      const migrationId = uuidv7();

      const [inserted] = tx
        .insert(cardMigrations)
        .values({
          id: migrationId,
          oldMethodId,
          newMethodId,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .all();

      if (!inserted) {
        throw new Error('Failed to create card migration.');
      }

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

      return mapCardMigration(inserted);
    });
  }

  toggleItem(itemId: string, done: boolean): CardMigrationDetail {
    const now = new Date().toISOString();

    const migrationId = this.db.transaction((tx) => {
      const itemRow = tx
        .select()
        .from(cardMigrationItems)
        .where(
          and(
            eq(cardMigrationItems.id, itemId),
            isNull(cardMigrationItems.deletedAt),
          ),
        )
        .get();

      if (!itemRow) {
        throw new Error('Migration item not found.');
      }

      const migrationRow = tx
        .select()
        .from(cardMigrations)
        .where(
          and(
            eq(cardMigrations.id, itemRow.migrationId),
            isNull(cardMigrations.deletedAt),
          ),
        )
        .get();

      if (!migrationRow) {
        throw new Error('Migration not found.');
      }

      tx.update(cardMigrationItems)
        .set({ doneAt: done ? now : null, updatedAt: now })
        .where(eq(cardMigrationItems.id, itemId))
        .run();

      if (done && migrationRow.newMethodId !== null) {
        if (itemRow.serviceId !== null) {
          tx.update(services)
            .set({ paymentMethodId: migrationRow.newMethodId, updatedAt: now })
            .where(eq(services.id, itemRow.serviceId))
            .run();
        } else if (itemRow.paymentMethodId !== null) {
          const allActiveMethods = tx
            .select()
            .from(paymentMethods)
            .where(isNull(paymentMethods.deletedAt))
            .all()
            .map(mapPaymentMethod);
          const targetMethod = allActiveMethods.find(
            (m) => m.id === itemRow.paymentMethodId,
          );
          if (targetMethod) {
            const chainCheck = validateFundingChain(
              allActiveMethods,
              targetMethod.id,
              targetMethod.kind,
              migrationRow.newMethodId,
            );
            if (!chainCheck.valid) {
              throw new Error(
                `Cannot relink intermediary during migration: ${chainCheck.reason}`,
              );
            }
            tx.update(paymentMethods)
              .set({ fundedById: migrationRow.newMethodId, updatedAt: now })
              .where(eq(paymentMethods.id, targetMethod.id))
              .run();
          }
        }
      }

      const itemsAfter = tx
        .select()
        .from(cardMigrationItems)
        .where(
          and(
            eq(cardMigrationItems.migrationId, migrationRow.id),
            isNull(cardMigrationItems.deletedAt),
          ),
        )
        .all();

      const allDone = itemsAfter.every((i) => i.doneAt !== null);

      if (allDone) {
        tx.update(cardMigrations)
          .set({ completedAt: now, updatedAt: now })
          .where(eq(cardMigrations.id, migrationRow.id))
          .run();

        if (migrationRow.newMethodId !== null) {
          tx.update(paymentMethods)
            .set({ archivedAt: now, updatedAt: now })
            .where(
              and(
                eq(paymentMethods.id, migrationRow.oldMethodId),
                isNull(paymentMethods.archivedAt),
              ),
            )
            .run();
        }
      } else if (migrationRow.completedAt !== null) {
        tx.update(cardMigrations)
          .set({ completedAt: null, updatedAt: now })
          .where(eq(cardMigrations.id, migrationRow.id))
          .run();
      }

      return migrationRow.id;
    });

    const detail = this.getDetail(migrationId);
    if (!detail) {
      throw new Error('Failed to load migration detail.');
    }
    return detail;
  }
}

function collectSubtreeIds(
  methods: readonly PaymentMethod[],
  rootId: string,
): Set<string> {
  const result = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const m of methods) {
      if (m.archivedAt === null && m.fundedById === current && !result.has(m.id)) {
        result.add(m.id);
        queue.push(m.id);
      }
    }
  }
  return result;
}

