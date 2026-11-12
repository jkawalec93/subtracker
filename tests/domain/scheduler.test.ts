import { describe, expect, it } from 'vitest';
import { planBillingEvents } from '@domain/scheduler';
import type { BillingEvent, Service, ServicePrice } from '@domain/types';

const ts = '2026-01-01T00:00:00Z';

function makeService(overrides: Partial<Service>): Service {
  return {
    id: 'svc-1',
    name: 'Netflix',
    kind: 'subscription',
    categoryId: null,
    paymentMethodId: null,
    status: 'active',
    intervalUnit: 'month',
    intervalCount: 1,
    billingAnchorDate: '2026-01-31',
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
    amountMinor: 4300,
    currency: 'PLN',
    validFrom: '2026-01-01',
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    ...overrides,
  };
}

describe('scheduler billing-event planner', () => {
  it('catches up missed cycles, applies historical price changes, and is idempotent', () => {
    const services = [makeService({ id: 'svc-1', billingAnchorDate: '2026-01-31' })];
    const prices = [
      makePrice({ id: 'p1', amountMinor: 4300, validFrom: '2026-01-01' }),
      makePrice({ id: 'p2', amountMinor: 4900, validFrom: '2026-03-01' }),
    ];

    const firstRun = planBillingEvents({
      services,
      prices,
      existingEvents: [],
      today: '2026-04-05',
    });

    expect(firstRun.eventsToCreate).toEqual([
      { serviceId: 'svc-1', periodStart: '2026-01-31', amountMinor: 4300, currency: 'PLN' },
      { serviceId: 'svc-1', periodStart: '2026-02-28', amountMinor: 4300, currency: 'PLN' },
      { serviceId: 'svc-1', periodStart: '2026-03-31', amountMinor: 4900, currency: 'PLN' },
    ]);
    expect(firstRun.statusTransitions).toEqual([]);

    const persisted: BillingEvent[] = firstRun.eventsToCreate.map((e, idx) => ({
      id: `ev-${idx}`,
      ...e,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    }));

    const secondRun = planBillingEvents({
      services,
      prices,
      existingEvents: persisted,
      today: '2026-04-05',
    });

    expect(secondRun.eventsToCreate).toEqual([]);
    expect(secondRun.warnings).toEqual([]);
  });

  it('handles trial start, automatic transition to active, paused, and cancelled paidUntil', () => {
    const services: Service[] = [
      makeService({
        id: 'trial-future',
        status: 'trial',
        billingAnchorDate: '2026-05-20',
        trialEndsAt: '2026-05-20',
      }),
      makeService({
        id: 'trial-due',
        status: 'trial',
        billingAnchorDate: '2026-05-10',
        trialEndsAt: '2026-05-10',
      }),
      makeService({
        id: 'paused',
        status: 'paused',
        billingAnchorDate: '2026-01-10',
      }),
      makeService({
        id: 'cancelled',
        status: 'cancelled',
        billingAnchorDate: '2026-01-15',
        paidUntil: '2026-03-15',
      }),
    ];

    const prices: ServicePrice[] = [
      makePrice({ id: 'p1', serviceId: 'trial-future', amountMinor: 1999 }),
      makePrice({ id: 'p2', serviceId: 'trial-due', amountMinor: 2999 }),
      makePrice({ id: 'p3', serviceId: 'paused', amountMinor: 5000 }),
      makePrice({ id: 'p4', serviceId: 'cancelled', amountMinor: 3500 }),
    ];

    const plan = planBillingEvents({
      services,
      prices,
      existingEvents: [],
      today: '2026-05-12',
    });

    expect(plan.statusTransitions).toEqual([
      { serviceId: 'trial-due', fromStatus: 'trial', toStatus: 'active' },
    ]);

    expect(plan.eventsToCreate).toEqual([
      { serviceId: 'trial-due', periodStart: '2026-05-10', amountMinor: 2999, currency: 'PLN' },
      { serviceId: 'cancelled', periodStart: '2026-01-15', amountMinor: 3500, currency: 'PLN' },
      { serviceId: 'cancelled', periodStart: '2026-02-15', amountMinor: 3500, currency: 'PLN' },
      { serviceId: 'cancelled', periodStart: '2026-03-15', amountMinor: 3500, currency: 'PLN' },
    ]);
  });
});

