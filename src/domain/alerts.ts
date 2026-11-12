import { addCalendarDays, daysBetween, getNextBillingDate } from './dates';
import {
  evaluateCardExpiryAlerts,
  resolvePaymentMethodHealth,
  type CardExpiryAlert,
  type PaymentMethodHealth,
} from './payment-methods';
import {
  resolvePriceForDate,
  summarizeCostsByCurrency,
  type CurrencyCostSummary,
} from './pricing';
import {
  DEFAULT_ALERT_SETTINGS,
  type AlertSettings,
  type CardMigration,
  type IsoDate,
  type PaymentMethod,
  type Service,
  type ServicePrice,
} from './types';

export interface UnhealthyServiceAlert {
  service: Service;
  health: PaymentMethodHealth;
}

export interface EndingTrialAlert {
  service: Service;
  trialEndsAt: IsoDate;
  daysRemaining: number;
  amountMinor: number | null;
  currency: string | null;
}

export interface UpcomingPaymentAlert {
  service: Service;
  dueDate: IsoDate;
  daysRemaining: number;
  amountMinor: number | null;
  currency: string | null;
}

export interface DashboardAttentionSummary {
  today: IsoDate;
  cardExpiryAlerts: CardExpiryAlert[];
  openMigrations: CardMigration[];
  unhealthyServices: UnhealthyServiceAlert[];
  endingTrials: EndingTrialAlert[];
  upcomingPayments: UpcomingPaymentAlert[];
  costSummaries: CurrencyCostSummary[];
}

export interface BuildDashboardSummaryInput {
  methods: readonly PaymentMethod[];
  services: readonly Service[];
  prices: readonly ServicePrice[];
  migrations: readonly CardMigration[];
  today: IsoDate;
  settings?: Partial<AlertSettings>;
}

/**
 * Aggregates everything needed for the "Wymaga uwagi" home screen.
 */
export function buildDashboardAttentionSummary({
  methods,
  services,
  prices,
  migrations,
  today,
  settings: partialSettings,
}: BuildDashboardSummaryInput): DashboardAttentionSummary {
  const settings: AlertSettings = {
    ...DEFAULT_ALERT_SETTINGS,
    ...partialSettings,
  };

  const cardExpiryAlerts = evaluateCardExpiryAlerts(
    methods,
    today,
    settings.cardExpiryThresholdsDays,
  );

  const openMigrations = migrations.filter(
    (m) => m.deletedAt === null && m.completedAt === null,
  );

  const unhealthyServices: UnhealthyServiceAlert[] = [];
  const endingTrials: EndingTrialAlert[] = [];
  const upcomingPayments: UpcomingPaymentAlert[] = [];

  const upcomingWindowEnd = addCalendarDays(today, settings.upcomingPaymentsDays);

  for (const service of services) {
    if (service.deletedAt !== null) {
      continue;
    }

    // Check payment method health for all non-cancelled services (including on_demand).
    if (service.status !== 'cancelled') {
      const health = resolvePaymentMethodHealth(methods, service.paymentMethodId, today);
      if (!health.healthy) {
        unhealthyServices.push({ service, health });
      }
    }

    if (service.kind !== 'subscription') {
      continue;
    }

    if (service.status === 'trial' && service.trialEndsAt !== null) {
      const daysRemaining = daysBetween(today, service.trialEndsAt);
      if (daysRemaining <= settings.trialAlertDays) {
        const price = resolvePriceForDate(prices, service.id, service.trialEndsAt);
        endingTrials.push({
          service,
          trialEndsAt: service.trialEndsAt,
          daysRemaining,
          amountMinor: price?.amountMinor ?? null,
          currency: price?.currency ?? null,
        });
      }
    }

    const dueDate = findUpcomingDueDate(service, today, upcomingWindowEnd);
    if (dueDate !== null) {
      const price = resolvePriceForDate(prices, service.id, dueDate);
      upcomingPayments.push({
        service,
        dueDate,
        daysRemaining: daysBetween(today, dueDate),
        amountMinor: price?.amountMinor ?? null,
        currency: price?.currency ?? null,
      });
    }
  }

  endingTrials.sort((a, b) => a.daysRemaining - b.daysRemaining);
  upcomingPayments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const costSummaries = summarizeCostsByCurrency(services, prices, today);

  return {
    today,
    cardExpiryAlerts,
    openMigrations,
    unhealthyServices,
    endingTrials,
    upcomingPayments,
    costSummaries,
  };
}

function findUpcomingDueDate(
  service: Service,
  today: IsoDate,
  windowEnd: IsoDate,
): IsoDate | null {
  if (service.status === 'paused') {
    return null;
  }
  if (service.status === 'trial') {
    if (
      service.trialEndsAt !== null &&
      service.trialEndsAt >= today &&
      service.trialEndsAt <= windowEnd
    ) {
      return service.trialEndsAt;
    }
    return null;
  }
  if (
    service.billingAnchorDate === null ||
    service.intervalUnit === null ||
    service.intervalCount === null
  ) {
    return null;
  }
  const candidate = getNextBillingDate(
    service.billingAnchorDate,
    service.intervalUnit,
    service.intervalCount,
    today,
    true,
  );
  if (candidate > windowEnd) {
    return null;
  }
  if (
    service.status === 'cancelled' &&
    (service.paidUntil === null || candidate > service.paidUntil)
  ) {
    return null;
  }
  return candidate;
}

