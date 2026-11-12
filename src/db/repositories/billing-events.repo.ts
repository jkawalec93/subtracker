import { desc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { getTodayInTimeZone } from '@domain/dates';
import { planBillingEvents, type SchedulerWarning } from '@domain/scheduler';
import type { BillingEvent, IsoDate } from '@domain/types';
import type { SubtrackDatabase } from '../client';
import { mapBillingEvent, mapService, mapServicePrice } from '../mappers';
import { billingEvents, servicePrices, services, settings } from '../schema';

export interface SchedulerRunResult {
  today: IsoDate;
  createdCount: number;
  transitionedServiceIds: string[];
  warnings: SchedulerWarning[];
}

export class BillingEventsRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  listAll(): BillingEvent[] {
    return this.db
      .select()
      .from(billingEvents)
      .orderBy(desc(billingEvents.periodStart))
      .all()
      .map(mapBillingEvent);
  }

  listByService(serviceId: string): BillingEvent[] {
    return this.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.serviceId, serviceId))
      .orderBy(desc(billingEvents.periodStart))
      .all()
      .map(mapBillingEvent);
  }

  /**
   * Executes the pure catch-up scheduler inside a transaction and persists new billing events
   * idempotently via UNIQUE(service_id, period_start).
   */
  runCatchUpScheduler(explicitToday?: IsoDate): SchedulerRunResult {
    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
      let today = explicitToday;
      if (!today) {
        const tzRow = tx
          .select()
          .from(settings)
          .where(eq(settings.key, 'timeZone'))
          .get();
        today = getTodayInTimeZone(tzRow?.value ?? 'Europe/Warsaw');
      }

      const allServices = tx
        .select()
        .from(services)
        .where(isNull(services.deletedAt))
        .all()
        .map(mapService);

      const allPrices = tx
        .select()
        .from(servicePrices)
        .where(isNull(servicePrices.deletedAt))
        .all()
        .map(mapServicePrice);

      const existingEvents = tx
        .select()
        .from(billingEvents)
        .where(isNull(billingEvents.deletedAt))
        .all()
        .map(mapBillingEvent);

      const plan = planBillingEvents({
        services: allServices,
        prices: allPrices,
        existingEvents,
        today,
      });

      let createdCount = 0;
      for (const ev of plan.eventsToCreate) {
        const result = tx
          .insert(billingEvents)
          .values({
            id: uuidv7(),
            serviceId: ev.serviceId,
            periodStart: ev.periodStart,
            amountMinor: ev.amountMinor,
            currency: ev.currency,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoNothing()
          .run();
        createdCount += result.changes;
      }

      const transitionedServiceIds: string[] = [];
      for (const transition of plan.statusTransitions) {
        tx.update(services)
          .set({ status: transition.toStatus, updatedAt: now })
          .where(eq(services.id, transition.serviceId))
          .run();
        transitionedServiceIds.push(transition.serviceId);
      }

      return {
        today,
        createdCount,
        transitionedServiceIds,
        warnings: plan.warnings,
      };
    });
  }
}

