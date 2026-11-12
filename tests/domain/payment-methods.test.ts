import { describe, expect, it } from 'vitest';
import {
  buildCardMigrationPlan,
  evaluateCardExpiryAlerts,
  resolvePaymentMethodHealth,
  validateFundingChain,
} from '@domain/payment-methods';
import type { PaymentMethod, Service } from '@domain/types';

const ts = '2026-01-01T00:00:00Z';

function makeMethod(overrides: Partial<PaymentMethod>): PaymentMethod {
  return {
    id: 'm-1',
    name: 'Method',
    kind: 'card',
    cardBrand: 'visa',
    last4: '1234',
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

describe('payment methods domain logic', () => {
  it('enforces card funding restrictions, cycle detection, and max depth 5', () => {
    const card = makeMethod({ id: 'card', kind: 'card' });
    const w2 = makeMethod({ id: 'w2', kind: 'wallet', fundedById: 'card', cardBrand: null, expiryMonth: null, expiryYear: null, last4: null });
    const w3 = makeMethod({ id: 'w3', kind: 'wallet', fundedById: 'w2', cardBrand: null, expiryMonth: null, expiryYear: null, last4: null });
    const w4 = makeMethod({ id: 'w4', kind: 'wallet', fundedById: 'w3', cardBrand: null, expiryMonth: null, expiryYear: null, last4: null });
    const w5 = makeMethod({ id: 'w5', kind: 'store_account', fundedById: 'w4', cardBrand: null, expiryMonth: null, expiryYear: null, last4: null });
    const all = [card, w2, w3, w4, w5];

    expect(validateFundingChain(all, 'card', 'card', 'w2')).toEqual({
      valid: false,
      reason: 'card_cannot_be_funded',
    });
    expect(validateFundingChain(all, 'w2', 'wallet', 'w2')).toEqual({
      valid: false,
      reason: 'self_reference',
    });
    // Cycle: card <- w2 <- w3 <- w4 <- w5, pointing w2 -> w5 creates a cycle.
    expect(validateFundingChain(all, 'w2', 'wallet', 'w5')).toEqual({
      valid: false,
      reason: 'cycle_detected',
    });

    // Chain depth 5 (w5 -> w4 -> w3 -> w2 -> card) is valid.
    expect(validateFundingChain([card, w2, w3, w4], 'w5', 'store_account', 'w4')).toEqual({
      valid: true,
      depth: 5,
    });

    // Adding level 6 (w6 -> w5 -> w4 -> w3 -> w2 -> card) exceeds depth 5.
    expect(validateFundingChain(all, 'w6', 'wallet', 'w5')).toEqual({
      valid: false,
      reason: 'max_depth_exceeded',
    });
  });

  it('detects expired or archived cards through funding chains', () => {
    const expiredCard = makeMethod({ id: 'c-exp', expiryMonth: 3, expiryYear: 2026 });
    const paypal = makeMethod({
      id: 'paypal',
      kind: 'wallet',
      fundedById: 'c-exp',
      cardBrand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    });
    const archivedWallet = makeMethod({
      id: 'w-arch',
      kind: 'wallet',
      archivedAt: '2026-04-01T00:00:00Z',
      fundedById: null,
      cardBrand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    });

    // Valid on last day of expiry month (2026-03-31).
    expect(resolvePaymentMethodHealth([expiredCard, paypal], 'paypal', '2026-03-31').healthy).toBe(true);

    // Expired starting 2026-04-01.
    const expiredHealth = resolvePaymentMethodHealth([expiredCard, paypal], 'paypal', '2026-04-01');
    expect(expiredHealth.healthy).toBe(false);
    expect(expiredHealth.issue).toBe('expired_card');
    expect(expiredHealth.affectedMethod?.id).toBe('c-exp');

    const archivedHealth = resolvePaymentMethodHealth([archivedWallet], 'w-arch', '2026-04-01');
    expect(archivedHealth.healthy).toBe(false);
    expect(archivedHealth.issue).toBe('archived_method');
  });

  it('evaluates card expiry thresholds (60, 30, 7 days and expired)', () => {
    const methods = [
      makeMethod({ id: 'c-ok', expiryMonth: 12, expiryYear: 2026 }),
      makeMethod({ id: 'c-45d', expiryMonth: 5, expiryYear: 2026 }), // 2026-05-31 -> 46 days from 2026-04-15
      makeMethod({ id: 'c-15d', expiryMonth: 4, expiryYear: 2026 }), // 2026-04-30 -> 15 days from 2026-04-15
      makeMethod({ id: 'c-exp', expiryMonth: 3, expiryYear: 2026 }), // 2026-03-31 -> -15 days
      makeMethod({ id: 'c-arch', expiryMonth: 3, expiryYear: 2026, archivedAt: ts }),
    ];

    const alerts = evaluateCardExpiryAlerts(methods, '2026-04-15', [60, 30, 7]);
    expect(alerts.map((a) => [a.method.id, a.isExpired, a.matchedThresholdDays])).toEqual([
      ['c-exp', true, null],
      ['c-15d', false, 30],
      ['c-45d', false, 60],
    ]);
  });

  it('builds card migration plan with direct services and intermediaries (including on_demand)', () => {
    const oldCard = makeMethod({ id: 'old-card', name: 'Old Visa' });
    const paypal = makeMethod({
      id: 'paypal',
      name: 'PayPal',
      kind: 'wallet',
      fundedById: 'old-card',
      cardBrand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    });
    const applePay = makeMethod({
      id: 'apple-pay',
      name: 'Apple Pay',
      kind: 'wallet',
      fundedById: 'paypal',
      cardBrand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    });

    const services = [
      makeService({ id: 's1', name: 'Netflix', paymentMethodId: 'old-card' }),
      makeService({
        id: 's2',
        name: 'Uber',
        kind: 'on_demand',
        paymentMethodId: 'old-card',
        intervalUnit: null,
        intervalCount: null,
        billingAnchorDate: null,
      }),
      makeService({ id: 's3', name: 'Spotify', paymentMethodId: 'paypal' }),
      makeService({ id: 's4', name: 'iCloud', paymentMethodId: 'apple-pay' }),
      makeService({ id: 's5', name: 'Cancelled App', status: 'cancelled', paymentMethodId: 'old-card' }),
      makeService({ id: 's6', name: 'Deleted App', deletedAt: ts, paymentMethodId: 'old-card' }),
    ];

    const plan = buildCardMigrationPlan('old-card', [oldCard, paypal, applePay], services);
    expect(plan.directServices.map((s) => s.name)).toEqual(['Netflix', 'Uber']);
    expect(plan.intermediaries).toHaveLength(1);
    expect(plan.intermediaries[0]?.intermediary.name).toBe('PayPal');
    expect(plan.intermediaries[0]?.dependentServices.map((s) => s.name)).toEqual([
      'iCloud',
      'Spotify',
    ]);
  });
});
