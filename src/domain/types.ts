/** Calendar date string in YYYY-MM-DD format (no time component). */
export type IsoDate = string;

export type PaymentMethodKind =
  | 'card'
  | 'wallet'
  | 'store_account'
  | 'bank_account'
  | 'carrier_billing'
  | 'other';

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'other';

export type ServiceKind = 'subscription' | 'on_demand';

export type ServiceStatus = 'trial' | 'active' | 'paused' | 'cancelled';

export type IntervalUnit = 'week' | 'month' | 'year';

export interface PaymentMethod {
  id: string;
  name: string;
  kind: PaymentMethodKind;
  cardBrand: CardBrand | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  fundedById: string | null;
  replacesId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Service {
  id: string;
  name: string;
  kind: ServiceKind;
  categoryId: string | null;
  paymentMethodId: string | null;
  status: ServiceStatus;
  intervalUnit: IntervalUnit | null;
  intervalCount: number | null;
  billingAnchorDate: IsoDate | null;
  trialEndsAt: IsoDate | null;
  paidUntil: IsoDate | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ServicePrice {
  id: string;
  serviceId: string;
  amountMinor: number;
  currency: string;
  validFrom: IsoDate;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BillingEvent {
  id: string;
  serviceId: string;
  periodStart: IsoDate;
  amountMinor: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CardMigration {
  id: string;
  oldMethodId: string;
  newMethodId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CardMigrationItem {
  id: string;
  migrationId: string;
  serviceId: string | null;
  paymentMethodId: string | null;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AlertSettings {
  cardExpiryThresholdsDays: number[];
  trialAlertDays: number;
  upcomingPaymentsDays: number;
  timeZone: string;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  cardExpiryThresholdsDays: [60, 30, 7],
  trialAlertDays: 3,
  upcomingPaymentsDays: 7,
  timeZone: 'Europe/Warsaw',
};

