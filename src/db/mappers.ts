import type {
  BillingEvent,
  CardBrand,
  CardMigration,
  CardMigrationItem,
  IntervalUnit,
  PaymentMethod,
  PaymentMethodKind,
  Service,
  ServiceKind,
  ServicePrice,
  ServiceStatus,
} from '@domain/types';
import {
  billingEvents,
  cardMigrationItems,
  cardMigrations,
  paymentMethods,
  servicePrices,
  services,
} from './schema';

export function mapPaymentMethod(
  row: typeof paymentMethods.$inferSelect,
): PaymentMethod {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PaymentMethodKind,
    cardBrand: (row.cardBrand as CardBrand | null) ?? null,
    last4: row.last4,
    expiryMonth: row.expiryMonth,
    expiryYear: row.expiryYear,
    fundedById: row.fundedById,
    replacesId: row.replacesId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function mapService(row: typeof services.$inferSelect): Service {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ServiceKind,
    categoryId: row.categoryId,
    paymentMethodId: row.paymentMethodId,
    status: row.status as ServiceStatus,
    intervalUnit: (row.intervalUnit as IntervalUnit | null) ?? null,
    intervalCount: row.intervalCount,
    billingAnchorDate: row.billingAnchorDate,
    trialEndsAt: row.trialEndsAt,
    paidUntil: row.paidUntil,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function mapServicePrice(
  row: typeof servicePrices.$inferSelect,
): ServicePrice {
  return {
    id: row.id,
    serviceId: row.serviceId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    validFrom: row.validFrom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function mapBillingEvent(
  row: typeof billingEvents.$inferSelect,
): BillingEvent {
  return {
    id: row.id,
    serviceId: row.serviceId,
    periodStart: row.periodStart,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function mapCardMigration(
  row: typeof cardMigrations.$inferSelect,
): CardMigration {
  return {
    id: row.id,
    oldMethodId: row.oldMethodId,
    newMethodId: row.newMethodId,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function mapCardMigrationItem(
  row: typeof cardMigrationItems.$inferSelect,
): CardMigrationItem {
  return {
    id: row.id,
    migrationId: row.migrationId,
    serviceId: row.serviceId,
    paymentMethodId: row.paymentMethodId,
    doneAt: row.doneAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

