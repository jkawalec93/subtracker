import { sql } from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const paymentMethods = sqliteTable('payment_methods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  cardBrand: text('card_brand'),
  last4: text('last4'),
  expiryMonth: integer('expiry_month'),
  expiryYear: integer('expiry_year'),
  fundedById: text('funded_by_id').references((): AnySQLiteColumn => paymentMethods.id),
  replacesId: text('replaces_id').references((): AnySQLiteColumn => paymentMethods.id),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('uq_categories_active_name')
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  categoryId: text('category_id').references(() => categories.id),
  paymentMethodId: text('payment_method_id').references(() => paymentMethods.id),
  status: text('status').notNull(),
  intervalUnit: text('interval_unit'),
  intervalCount: integer('interval_count'),
  billingAnchorDate: text('billing_anchor_date'),
  trialEndsAt: text('trial_ends_at'),
  paidUntil: text('paid_until'),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const servicePrices = sqliteTable(
  'service_prices',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    validFrom: text('valid_from').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('uq_service_prices_active_valid_from')
      .on(table.serviceId, table.validFrom)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const billingEvents = sqliteTable(
  'billing_events',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id),
    periodStart: text('period_start').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('uq_billing_events_service_period').on(
      table.serviceId,
      table.periodStart,
    ),
  ],
);

export const cardMigrations = sqliteTable('card_migrations', {
  id: text('id').primaryKey(),
  oldMethodId: text('old_method_id')
    .notNull()
    .references(() => paymentMethods.id),
  newMethodId: text('new_method_id').references(() => paymentMethods.id),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const cardMigrationItems = sqliteTable('card_migration_items', {
  id: text('id').primaryKey(),
  migrationId: text('migration_id')
    .notNull()
    .references(() => cardMigrations.id),
  serviceId: text('service_id').references(() => services.id),
  paymentMethodId: text('payment_method_id').references(() => paymentMethods.id),
  doneAt: text('done_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

