import { generateDueDates } from './dates';
import { resolvePriceForDate } from './pricing';
import type { BillingEvent, IsoDate, Service, ServicePrice, ServiceStatus } from './types';

export interface PlannedBillingEvent {
  serviceId: string;
  periodStart: IsoDate;
  amountMinor: number;
  currency: string;
}

export interface PlannedStatusTransition {
  serviceId: string;
  fromStatus: ServiceStatus;
  toStatus: ServiceStatus;
}

export interface SchedulerWarning {
  serviceId: string;
  reason: 'missing_cycle_config' | 'missing_trial_end_date' | 'missing_price';
  periodStart?: IsoDate;
}

export interface SchedulerPlan {
  eventsToCreate: PlannedBillingEvent[];
  statusTransitions: PlannedStatusTransition[];
  warnings: SchedulerWarning[];
}

export interface PlanBillingEventsInput {
  services: readonly Service[];
  prices: readonly ServicePrice[];
  existingEvents: readonly BillingEvent[];
  today: IsoDate;
}

/**
 * Pure catch-up, idempotent billing-event planner.
 * - `trial`: generates starting from `trialEndsAt` once `today >= trialEndsAt` and marks transition to `active`.
 * - `active`: generates from `billingAnchorDate` up to `today`.
 * - `paused`: generates nothing.
 * - `cancelled`: generates only up to `min(today, paidUntil)` inclusive.
 * Already recorded `(serviceId, periodStart)` pairs are skipped.
 */
export function planBillingEvents({
  services,
  prices,
  existingEvents,
  today,
}: PlanBillingEventsInput): SchedulerPlan {
  const existingKeys = new Set<string>();
  for (const event of existingEvents) {
    if (event.deletedAt === null) {
      existingKeys.add(`${event.serviceId}::${event.periodStart}`);
    }
  }

  const eventsToCreate: PlannedBillingEvent[] = [];
  const statusTransitions: PlannedStatusTransition[] = [];
  const warnings: SchedulerWarning[] = [];

  for (const service of services) {
    if (service.deletedAt !== null || service.kind !== 'subscription') {
      continue;
    }
    if (service.status === 'paused') {
      continue;
    }
    if (service.intervalUnit === null || service.intervalCount === null) {
      warnings.push({ serviceId: service.id, reason: 'missing_cycle_config' });
      continue;
    }

    let anchorDate: IsoDate | null = service.billingAnchorDate;
    let upperBound: IsoDate = today;

    if (service.status === 'trial') {
      if (service.trialEndsAt === null) {
        warnings.push({ serviceId: service.id, reason: 'missing_trial_end_date' });
        continue;
      }
      if (today < service.trialEndsAt) {
        continue;
      }
      // Trial starts billing on trialEndsAt and transitions to active.
      anchorDate = service.trialEndsAt;
      statusTransitions.push({
        serviceId: service.id,
        fromStatus: 'trial',
        toStatus: 'active',
      });
    } else if (service.status === 'cancelled') {
      if (service.paidUntil === null) {
        continue;
      }
      upperBound = service.paidUntil < today ? service.paidUntil : today;
    }

    if (anchorDate === null) {
      warnings.push({ serviceId: service.id, reason: 'missing_cycle_config' });
      continue;
    }
    if (anchorDate > upperBound) {
      continue;
    }

    const dueDates = generateDueDates(
      anchorDate,
      service.intervalUnit,
      service.intervalCount,
      upperBound,
    );

    for (const periodStart of dueDates) {
      const key = `${service.id}::${periodStart}`;
      if (existingKeys.has(key)) {
        continue;
      }

      const price = resolvePriceForDate(prices, service.id, periodStart);
      if (!price) {
        warnings.push({
          serviceId: service.id,
          reason: 'missing_price',
          periodStart,
        });
        continue;
      }

      existingKeys.add(key);
      eventsToCreate.push({
        serviceId: service.id,
        periodStart,
        amountMinor: price.amountMinor,
        currency: price.currency,
      });
    }
  }

  return {
    eventsToCreate,
    statusTransitions,
    warnings,
  };
}

