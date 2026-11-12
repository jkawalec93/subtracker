import { and, asc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { isValidIsoDate } from '@domain/dates';
import type {
  IntervalUnit,
  IsoDate,
  Service,
  ServiceKind,
  ServicePrice,
  ServiceStatus,
} from '@domain/types';
import type { SubtrackDatabase } from '../client';
import { mapService, mapServicePrice } from '../mappers';
import { servicePrices, services } from '../schema';

export interface CreateServiceInput {
  name: string;
  kind: ServiceKind;
  categoryId?: string | null;
  paymentMethodId?: string | null;
  status?: ServiceStatus;
  intervalUnit?: IntervalUnit | null;
  intervalCount?: number | null;
  billingAnchorDate?: IsoDate | null;
  trialEndsAt?: IsoDate | null;
  paidUntil?: IsoDate | null;
  notes?: string | null;
  initialPrice?: {
    amountMinor: number;
    currency: string;
    validFrom: IsoDate;
  } | null;
}

export interface UpdateServiceInput {
  name?: string;
  categoryId?: string | null;
  paymentMethodId?: string | null;
  status?: ServiceStatus;
  intervalUnit?: IntervalUnit | null;
  intervalCount?: number | null;
  billingAnchorDate?: IsoDate | null;
  trialEndsAt?: IsoDate | null;
  paidUntil?: IsoDate | null;
  notes?: string | null;
}

export interface UpsertPriceInput {
  amountMinor: number;
  currency: string;
  validFrom: IsoDate;
}

function validateCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid ISO 4217 currency code: "${currency}".`);
  }
  return normalized;
}

export class ServicesRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  list(includeDeleted = false): Service[] {
    const rows = includeDeleted
      ? this.db.select().from(services).orderBy(asc(services.name)).all()
      : this.db
          .select()
          .from(services)
          .where(isNull(services.deletedAt))
          .orderBy(asc(services.name))
          .all();
    return rows.map(mapService);
  }

  getById(id: string): Service | null {
    const row = this.db
      .select()
      .from(services)
      .where(and(eq(services.id, id), isNull(services.deletedAt)))
      .get();
    return row ? mapService(row) : null;
  }

  listPrices(serviceId?: string): ServicePrice[] {
    const rows = serviceId
      ? this.db
          .select()
          .from(servicePrices)
          .where(
            and(
              eq(servicePrices.serviceId, serviceId),
              isNull(servicePrices.deletedAt),
            ),
          )
          .orderBy(asc(servicePrices.validFrom))
          .all()
      : this.db
          .select()
          .from(servicePrices)
          .where(isNull(servicePrices.deletedAt))
          .orderBy(asc(servicePrices.validFrom))
          .all();
    return rows.map(mapServicePrice);
  }

  create(input: CreateServiceInput): Service {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Service name is required.');
    }

    const now = new Date().toISOString();
    const id = uuidv7();
    const status: ServiceStatus = input.status ?? 'active';

    if (input.kind === 'on_demand') {
      if (status !== 'active' && status !== 'cancelled') {
        throw new Error('On-demand service can only have status active or cancelled.');
      }
      const [inserted] = this.db
        .insert(services)
        .values({
          id,
          name,
          kind: 'on_demand',
          categoryId: input.categoryId ?? null,
          paymentMethodId: input.paymentMethodId ?? null,
          status,
          intervalUnit: null,
          intervalCount: null,
          billingAnchorDate: null,
          trialEndsAt: null,
          paidUntil: input.paidUntil ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .all();

      if (!inserted) {
        throw new Error('Failed to create on-demand service.');
      }
      return mapService(inserted);
    }

    // Subscription validation
    const intervalUnit = input.intervalUnit ?? null;
    const intervalCount = input.intervalCount ?? null;
    if (!intervalUnit || !intervalCount || !Number.isInteger(intervalCount) || intervalCount < 1) {
      throw new Error('Subscription requires a valid intervalUnit and positive intervalCount.');
    }

    let trialEndsAt = input.trialEndsAt ?? null;
    let billingAnchorDate = input.billingAnchorDate ?? null;

    if (status === 'trial') {
      if (!trialEndsAt || !isValidIsoDate(trialEndsAt)) {
        throw new Error('Trial subscription requires a valid trialEndsAt date.');
      }
      billingAnchorDate = trialEndsAt;
    } else {
      if (!billingAnchorDate || !isValidIsoDate(billingAnchorDate)) {
        throw new Error('Subscription requires a valid billingAnchorDate.');
      }
      trialEndsAt = null;
    }

    if (!input.initialPrice) {
      throw new Error('Subscription requires an initial price.');
    }
    if (!Number.isInteger(input.initialPrice.amountMinor) || input.initialPrice.amountMinor < 0) {
      throw new Error('Price amountMinor must be a non-negative integer.');
    }
    if (!isValidIsoDate(input.initialPrice.validFrom)) {
      throw new Error('Price validFrom must be a valid YYYY-MM-DD date.');
    }
    const currency = validateCurrency(input.initialPrice.currency);

    return this.db.transaction((tx) => {
      const [inserted] = tx
        .insert(services)
        .values({
          id,
          name,
          kind: 'subscription',
          categoryId: input.categoryId ?? null,
          paymentMethodId: input.paymentMethodId ?? null,
          status,
          intervalUnit,
          intervalCount,
          billingAnchorDate,
          trialEndsAt,
          paidUntil: status === 'cancelled' ? (input.paidUntil ?? null) : null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .all();

      if (!inserted) {
        throw new Error('Failed to create subscription.');
      }

      tx.insert(servicePrices)
        .values({
          id: uuidv7(),
          serviceId: id,
          amountMinor: input.initialPrice!.amountMinor,
          currency,
          validFrom: input.initialPrice!.validFrom,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();

      return mapService(inserted);
    });
  }

  update(id: string, patch: UpdateServiceInput): Service {
    const current = this.getById(id);
    if (!current) {
      throw new Error('Service not found.');
    }

    const now = new Date().toISOString();
    const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!nextName) {
      throw new Error('Service name is required.');
    }

    const nextStatus = patch.status ?? current.status;
    let nextBillingAnchor =
      patch.billingAnchorDate !== undefined
        ? patch.billingAnchorDate
        : current.billingAnchorDate;
    let nextTrialEndsAt =
      patch.trialEndsAt !== undefined ? patch.trialEndsAt : current.trialEndsAt;

    if (current.kind === 'subscription') {
      if (current.status === 'paused' && nextStatus === 'active') {
        if (!patch.billingAnchorDate || !isValidIsoDate(patch.billingAnchorDate)) {
          throw new Error('Resuming a paused subscription requires a new billingAnchorDate.');
        }
        nextBillingAnchor = patch.billingAnchorDate;
      }
      if (nextStatus === 'trial') {
        if (!nextTrialEndsAt || !isValidIsoDate(nextTrialEndsAt)) {
          throw new Error('Trial subscription requires a valid trialEndsAt date.');
        }
        nextBillingAnchor = nextTrialEndsAt;
      }
    } else {
      nextBillingAnchor = null;
      nextTrialEndsAt = null;
    }

    const [updated] = this.db
      .update(services)
      .set({
        name: nextName,
        categoryId:
          patch.categoryId !== undefined ? patch.categoryId : current.categoryId,
        paymentMethodId:
          patch.paymentMethodId !== undefined
            ? patch.paymentMethodId
            : current.paymentMethodId,
        status: nextStatus,
        intervalUnit:
          current.kind === 'subscription'
            ? (patch.intervalUnit !== undefined ? patch.intervalUnit : current.intervalUnit)
            : null,
        intervalCount:
          current.kind === 'subscription'
            ? (patch.intervalCount !== undefined ? patch.intervalCount : current.intervalCount)
            : null,
        billingAnchorDate: nextBillingAnchor,
        trialEndsAt: nextTrialEndsAt,
        paidUntil:
          patch.paidUntil !== undefined ? patch.paidUntil : current.paidUntil,
        notes: patch.notes !== undefined ? patch.notes : current.notes,
        updatedAt: now,
      })
      .where(eq(services.id, id))
      .returning()
      .all();

    if (!updated) {
      throw new Error('Failed to update service.');
    }
    return mapService(updated);
  }

  /**
   * Upserts the price for (serviceId, validFrom). Overwrites any active entry on the same day.
   */
  upsertPrice(serviceId: string, input: UpsertPriceInput): ServicePrice {
    const svc = this.getById(serviceId);
    if (!svc) {
      throw new Error('Service not found.');
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new Error('Price amountMinor must be a non-negative integer.');
    }
    if (!isValidIsoDate(input.validFrom)) {
      throw new Error('Price validFrom must be a valid YYYY-MM-DD date.');
    }
    const currency = validateCurrency(input.currency);
    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(servicePrices)
        .where(
          and(
            eq(servicePrices.serviceId, serviceId),
            eq(servicePrices.validFrom, input.validFrom),
            isNull(servicePrices.deletedAt),
          ),
        )
        .get();

      if (existing) {
        const [updated] = tx
          .update(servicePrices)
          .set({
            amountMinor: input.amountMinor,
            currency,
            updatedAt: now,
          })
          .where(eq(servicePrices.id, existing.id))
          .returning()
          .all();
        if (!updated) {
          throw new Error('Failed to update service price.');
        }
        return mapServicePrice(updated);
      }

      const [inserted] = tx
        .insert(servicePrices)
        .values({
          id: uuidv7(),
          serviceId,
          amountMinor: input.amountMinor,
          currency,
          validFrom: input.validFrom,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returning()
        .all();

      if (!inserted) {
        throw new Error('Failed to insert service price.');
      }
      return mapServicePrice(inserted);
    });
  }

  /** Soft-deletes a service while preserving all financial billing_events permanently. */
  softDelete(id: string): void {
    const now = new Date().toISOString();
    const result = this.db
      .update(services)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(services.id, id), isNull(services.deletedAt)))
      .run();
    if (result.changes === 0) {
      throw new Error('Service not found.');
    }
  }
}

