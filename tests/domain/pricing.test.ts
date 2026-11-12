import { describe, expect, it } from 'vitest';
import {
  normalizeAnnualMinor,
  normalizeMonthlyMinor,
  resolvePriceForDate,
  summarizeCostsByCurrency,
} from '@domain/pricing';
import type { Service, ServicePrice } from '@domain/types';

const ts = '2026-01-01T00:00:00Z';

function makeService(overrides: Partial<Service>): Service {
  return {
    id: 'svc-1',
    name: 'Service',
    kind: 'subscription',
    categoryId: null,
    paymentMethodId: null,
    status: 'active',
    intervalUnit: 'month',
    intervalCount: 1,
    billingAnchorDate: '2026-01-01',
    trialEndsAt: null,
    paidUntil: null,
    notes: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

function makePrice(overrides: Partial<ServicePrice>): ServicePrice {
  return {
    id: 'price-1',
    serviceId: 'svc-1',
    amountMinor: 4999,
    currency: 'PLN',
    validFrom: '2026-01-01',
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

describe('pricing domain logic', () => {
  it('resolves latest non-deleted price with validFrom <= date', () => {
    const prices: ServicePrice[] = [
      makePrice({ id: 'p1', amountMinor: 2900, validFrom: '2026-01-01' }),
      makePrice({ id: 'p2', amountMinor: 3900, validFrom: '2026-03-01' }),
      makePrice({ id: 'p3', amountMinor: 9900, validFrom: '2026-03-01', deletedAt: ts }),
      makePrice({ id: 'p4', amountMinor: 4900, validFrom: '2026-06-01' }),
    ];

    expect(resolvePriceForDate(prices, 'svc-1', '2025-12-31')).toBeNull();
    expect(resolvePriceForDate(prices, 'svc-1', '2026-02-15')?.amountMinor).toBe(2900);
    expect(resolvePriceForDate(prices, 'svc-1', '2026-03-01')?.amountMinor).toBe(3900);
    expect(resolvePriceForDate(prices, 'svc-1', '2026-06-01')?.amountMinor).toBe(4900);
  });

  it('normalizes monthly and annual costs for week/month/year cycles', () => {
    // 100.00 PLN every 2 months -> 50.00/mo, 600.00/yr
    expect(normalizeMonthlyMinor(10000, 'month', 2)).toBe(5000);
    expect(normalizeAnnualMinor(10000, 'month', 2)).toBe(60000);

    // 120.00 EUR yearly -> 10.00/mo, 120.00/yr
    expect(normalizeMonthlyMinor(12000, 'year', 1)).toBe(1000);
    expect(normalizeAnnualMinor(12000, 'year', 1)).toBe(12000);

    // 10.00 PLN every 2 weeks -> 260.00/yr, 21.67/mo
    expect(normalizeAnnualMinor(1000, 'week', 2)).toBe(26000);
    expect(normalizeMonthlyMinor(1000, 'week', 2)).toBe(2167);
  });

  it('summarizes costs separately per currency and separates active vs trial', () => {
    const services: Service[] = [
      makeService({ id: 's-pln', name: 'Netflix', status: 'active' }),
      makeService({
        id: 's-eur',
        name: 'iCloud',
        status: 'active',
        intervalUnit: 'year',
        intervalCount: 1,
      }),
      makeService({
        id: 's-trial',
        name: 'Trial App',
        status: 'trial',
        billingAnchorDate: '2026-05-10',
        trialEndsAt: '2026-05-10',
      }),
      makeService({ id: 's-paused', name: 'Paused', status: 'paused' }),
      makeService({ id: 's-cancelled', name: 'Cancelled', status: 'cancelled', paidUntil: '2026-05-20' }),
      makeService({
        id: 's-ondemand',
        name: 'Uber',
        kind: 'on_demand',
        intervalUnit: null,
        intervalCount: null,
        billingAnchorDate: null,
      }),
    ];

    const prices: ServicePrice[] = [
      makePrice({ id: 'p1', serviceId: 's-pln', amountMinor: 4300, currency: 'PLN' }),
      makePrice({ id: 'p2', serviceId: 's-eur', amountMinor: 12000, currency: 'EUR' }),
      makePrice({ id: 'p3', serviceId: 's-trial', amountMinor: 2000, currency: 'PLN', validFrom: '2026-05-01' }),
      makePrice({ id: 'p4', serviceId: 's-paused', amountMinor: 9999, currency: 'PLN' }),
      makePrice({ id: 'p5', serviceId: 's-cancelled', amountMinor: 9999, currency: 'PLN' }),
    ];

    const summary = summarizeCostsByCurrency(services, prices, '2026-05-05');
    expect(summary).toEqual([
      {
        currency: 'EUR',
        activeMonthlyMinor: 1000,
        activeAnnualMinor: 12000,
        trialMonthlyMinor: 0,
        trialAnnualMinor: 0,
        activeCount: 1,
        trialCount: 0,
      },
      {
        currency: 'PLN',
        activeMonthlyMinor: 4300,
        activeAnnualMinor: 51600,
        trialMonthlyMinor: 2000,
        trialAnnualMinor: 24000,
        activeCount: 1,
        trialCount: 1,
      },
    ]);
  });
});

