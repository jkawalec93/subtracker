import type { IntervalUnit, IsoDate, Service, ServicePrice } from './types';

export interface CurrencyCostSummary {
  currency: string;
  activeMonthlyMinor: number;
  activeAnnualMinor: number;
  trialMonthlyMinor: number;
  trialAnnualMinor: number;
  activeCount: number;
  trialCount: number;
}

/**
 * Resolves the effective price for a service on a given date:
 * the non-deleted record with the largest validFrom <= date.
 */
export function resolvePriceForDate(
  prices: readonly ServicePrice[],
  serviceId: string,
  date: IsoDate,
): ServicePrice | null {
  let best: ServicePrice | null = null;
  for (const price of prices) {
    if (price.deletedAt !== null || price.serviceId !== serviceId) {
      continue;
    }
    if (price.validFrom > date) {
      continue;
    }
    if (
      best === null ||
      price.validFrom > best.validFrom ||
      (price.validFrom === best.validFrom && price.createdAt > best.createdAt)
    ) {
      best = price;
    }
  }
  return best;
}

/**
 * Normalizes a subscription price in minor units to its monthly equivalent.
 */
export function normalizeMonthlyMinor(
  amountMinor: number,
  unit: IntervalUnit,
  intervalCount: number,
): number {
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new Error(`intervalCount must be a positive integer, got ${intervalCount}.`);
  }
  switch (unit) {
    case 'month':
      return Math.round(amountMinor / intervalCount);
    case 'year':
      return Math.round(amountMinor / (12 * intervalCount));
    case 'week':
      return Math.round(((amountMinor * 52) / intervalCount) / 12);
  }
}

/**
 * Normalizes a subscription price in minor units to its annual equivalent.
 */
export function normalizeAnnualMinor(
  amountMinor: number,
  unit: IntervalUnit,
  intervalCount: number,
): number {
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new Error(`intervalCount must be a positive integer, got ${intervalCount}.`);
  }
  switch (unit) {
    case 'month':
      return Math.round((amountMinor * 12) / intervalCount);
    case 'year':
      return Math.round(amountMinor / intervalCount);
    case 'week':
      return Math.round((amountMinor * 52) / intervalCount);
  }
}

/**
 * Aggregates monthly and annual recurring costs separately per currency.
 * Active subscriptions contribute to active totals; trial subscriptions are summarized
 * separately as upcoming info; paused, cancelled, on-demand, and deleted services are excluded.
 */
export function summarizeCostsByCurrency(
  services: readonly Service[],
  prices: readonly ServicePrice[],
  today: IsoDate,
): CurrencyCostSummary[] {
  const byCurrency = new Map<string, CurrencyCostSummary>();

  const getOrCreate = (currency: string): CurrencyCostSummary => {
    const existing = byCurrency.get(currency);
    if (existing) {
      return existing;
    }
    const created: CurrencyCostSummary = {
      currency,
      activeMonthlyMinor: 0,
      activeAnnualMinor: 0,
      trialMonthlyMinor: 0,
      trialAnnualMinor: 0,
      activeCount: 0,
      trialCount: 0,
    };
    byCurrency.set(currency, created);
    return created;
  };

  for (const service of services) {
    if (
      service.deletedAt !== null ||
      service.kind !== 'subscription' ||
      (service.status !== 'active' && service.status !== 'trial')
    ) {
      continue;
    }
    if (service.intervalUnit === null || service.intervalCount === null) {
      continue;
    }

    const priceDate =
      service.status === 'trial' && service.trialEndsAt !== null && service.trialEndsAt > today
        ? service.trialEndsAt
        : today;

    const price = resolvePriceForDate(prices, service.id, priceDate);
    if (!price) {
      continue;
    }

    const monthly = normalizeMonthlyMinor(
      price.amountMinor,
      service.intervalUnit,
      service.intervalCount,
    );
    const annual = normalizeAnnualMinor(
      price.amountMinor,
      service.intervalUnit,
      service.intervalCount,
    );
    const summary = getOrCreate(price.currency);

    if (service.status === 'active') {
      summary.activeMonthlyMinor += monthly;
      summary.activeAnnualMinor += annual;
      summary.activeCount += 1;
    } else {
      summary.trialMonthlyMinor += monthly;
      summary.trialAnnualMinor += annual;
      summary.trialCount += 1;
    }
  }

  return Array.from(byCurrency.values()).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

