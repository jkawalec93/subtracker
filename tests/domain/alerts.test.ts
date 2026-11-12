import { describe, expect, it } from 'vitest';
import { buildDashboardAttentionSummary } from '@domain/alerts';
import type { CardMigration, PaymentMethod, Service, ServicePrice } from '@domain/types';

const ts = '2026-01-01T00:00:00Z';

function makeMethod(overrides: Partial<PaymentMethod>): PaymentMethod {
  return {
    id: 'm-1',
    name: 'Card',
    kind: 'card',
    cardBrand: 'visa',
    last4: '4242',
    expiryMonth: 12,
    expiryYear: 2027,
    fundedById: null,
    replacesId: null,
    archivedAt: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

function makeService(overrides: Partial<Service>): Service {
  return {
    id: 'svc-1',
    name: 'Service',
    kind: 'subscription',
    categoryId: null,
    paymentMethodId: 'm-1',
    status: 'active',
    intervalUnit: 'month',
    intervalCount: 1,
    billingAnchorDate: '2026-04-10',
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
    amountMinor: 2999,
    currency: 'PLN',
    validFrom: '2026-01-01',
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

describe('dashboard attention summary', () => {
  it('aggregates expiring cards, open migrations, broken chains, ending trials, upcoming payments, and currency totals', () => {
    const methods: PaymentMethod[] = [
      makeMethod({ id: 'c-expiring', name: 'mBank', expiryMonth: 5, expiryYear: 2026 }),
      makeMethod({ id: 'c-expired', name: 'ING Old', expiryMonth: 3, expiryYear: 2026 }),
      makeMethod({
        id: 'wallet-broken',
        name: 'PayPal',
        kind: 'wallet',
        fundedById: 'c-expired',
        cardBrand: null,
        last4: null,
        expiryMonth: null,
        expiryYear: null,
      }),
    ];

    const services: Service[] = [
      makeService({
        id: 's-upcoming',
        name: 'Spotify',
        paymentMethodId: 'c-expiring',
        billingAnchorDate: '2026-01-20',
      }),
      makeService({
        id: 's-trial',
        name: 'Linear',
        status: 'trial',
        paymentMethodId: 'c-expiring',
        billingAnchorDate: '2026-04-17',
        trialEndsAt: '2026-04-17',
      }),
      makeService({
        id: 's-broken-ondemand',
        name: 'Uber',
        kind: 'on_demand',
        paymentMethodId: 'wallet-broken',
        intervalUnit: null,
        intervalCount: null,
        billingAnchorDate: null,
      }),
    ];

    const prices: ServicePrice[] = [
      makePrice({ id: 'p1', serviceId: 's-upcoming', amountMinor: 2399, currency: 'PLN' }),
      makePrice({ id: 'p2', serviceId: 's-trial', amountMinor: 1000, currency: 'USD' }),
    ];

    const migrations: CardMigration[] = [
      {
        id: 'mig-1',
        oldMethodId: 'c-expired',
        newMethodId: null,
        completedAt: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      },
    ];

    const summary = buildDashboardAttentionSummary({
      methods,
      services,
      prices,
      migrations,
      today: '2026-04-15',
    });

    expect(summary.cardExpiryAlerts.map((a) => a.method.id)).toEqual([
      'c-expired',
      'c-expiring',
    ]);
    expect(summary.openMigrations.map((m) => m.id)).toEqual(['mig-1']);
    expect(summary.unhealthyServices.map((u) => [u.service.id, u.health.issue])).toEqual([
      ['s-broken-ondemand', 'expired_card'],
    ]);
    expect(summary.endingTrials.map((t) => [t.service.id, t.daysRemaining])).toEqual([
      ['s-trial', 2],
    ]);
    expect(summary.upcomingPayments.map((p) => [p.service.id, p.dueDate])).toEqual([
      ['s-trial', '2026-04-17'],
      ['s-upcoming', '2026-04-20'],
    ]);
    expect(summary.costSummaries).toEqual([
      {
        currency: 'PLN',
        activeMonthlyMinor: 2399,
        activeAnnualMinor: 28788,
        trialMonthlyMinor: 0,
        trialAnnualMinor: 0,
        activeCount: 1,
        trialCount: 0,
      },
      {
        currency: 'USD',
        activeMonthlyMinor: 0,
        activeAnnualMinor: 0,
        trialMonthlyMinor: 1000,
        trialAnnualMinor: 12000,
        activeCount: 0,
        trialCount: 1,
      },
    ]);
  });
});

