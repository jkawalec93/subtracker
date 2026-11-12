import type { SubtrackDatabase } from '../client';
import {
  billingEvents,
  cardMigrationItems,
  cardMigrations,
  categories,
  paymentMethods,
  servicePrices,
  services,
  settings,
} from '../schema';

export interface DatabaseSnapshotV1 {
  version: 1;
  exportedAt: string;
  tables: {
    paymentMethods: Array<typeof paymentMethods.$inferSelect>;
    categories: Array<typeof categories.$inferSelect>;
    services: Array<typeof services.$inferSelect>;
    servicePrices: Array<typeof servicePrices.$inferSelect>;
    billingEvents: Array<typeof billingEvents.$inferSelect>;
    cardMigrations: Array<typeof cardMigrations.$inferSelect>;
    cardMigrationItems: Array<typeof cardMigrationItems.$inferSelect>;
    settings: Array<typeof settings.$inferSelect>;
  };
}

export class BackupRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  exportSnapshot(): DatabaseSnapshotV1 {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tables: {
        paymentMethods: this.db.select().from(paymentMethods).all(),
        categories: this.db.select().from(categories).all(),
        services: this.db.select().from(services).all(),
        servicePrices: this.db.select().from(servicePrices).all(),
        billingEvents: this.db.select().from(billingEvents).all(),
        cardMigrations: this.db.select().from(cardMigrations).all(),
        cardMigrationItems: this.db.select().from(cardMigrationItems).all(),
        settings: this.db.select().from(settings).all(),
      },
    };
  }

  /**
   * Atomically replaces the entire database contents from a validated JSON snapshot.
   */
  importSnapshot(raw: unknown): void {
    const snapshot = validateSnapshotShape(raw);

    this.db.transaction((tx) => {
      // Clear in reverse FK order.
      tx.delete(cardMigrationItems).run();
      tx.delete(cardMigrations).run();
      tx.delete(billingEvents).run();
      tx.delete(servicePrices).run();
      tx.delete(services).run();
      tx.delete(categories).run();
      tx.delete(paymentMethods).run();
      tx.delete(settings).run();

      // Insert in FK-safe order.
      if (snapshot.tables.settings.length > 0) {
        tx.insert(settings).values(snapshot.tables.settings).run();
      }
      if (snapshot.tables.categories.length > 0) {
        tx.insert(categories).values(snapshot.tables.categories).run();
      }
      // Insert payment methods without self-FKs first, or in full if parent rows are present.
      // SQLite with PRAGMA foreign_keys = ON checks FKs at statement level unless ordered;
      // insert root methods before dependent methods to satisfy self-references.
      const orderedMethods = sortPaymentMethodsForInsert(
        snapshot.tables.paymentMethods,
      );
      for (const method of orderedMethods) {
        tx.insert(paymentMethods).values(method).run();
      }
      if (snapshot.tables.services.length > 0) {
        tx.insert(services).values(snapshot.tables.services).run();
      }
      if (snapshot.tables.servicePrices.length > 0) {
        tx.insert(servicePrices).values(snapshot.tables.servicePrices).run();
      }
      if (snapshot.tables.billingEvents.length > 0) {
        tx.insert(billingEvents).values(snapshot.tables.billingEvents).run();
      }
      if (snapshot.tables.cardMigrations.length > 0) {
        tx.insert(cardMigrations).values(snapshot.tables.cardMigrations).run();
      }
      if (snapshot.tables.cardMigrationItems.length > 0) {
        tx.insert(cardMigrationItems)
          .values(snapshot.tables.cardMigrationItems)
          .run();
      }
    });
  }
}

function validateSnapshotShape(raw: unknown): DatabaseSnapshotV1 {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Snapshot must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${String(obj.version)}.`);
  }
  if (typeof obj.tables !== 'object' || obj.tables === null) {
    throw new Error('Snapshot is missing "tables" object.');
  }
  const tables = obj.tables as Record<string, unknown>;
  const requiredKeys = [
    'paymentMethods',
    'categories',
    'services',
    'servicePrices',
    'billingEvents',
    'cardMigrations',
    'cardMigrationItems',
    'settings',
  ];
  for (const key of requiredKeys) {
    if (!Array.isArray(tables[key])) {
      throw new Error(`Snapshot table "${key}" must be an array.`);
    }
  }
  return raw as DatabaseSnapshotV1;
}

function sortPaymentMethodsForInsert(
  rows: Array<typeof paymentMethods.$inferSelect>,
): Array<typeof paymentMethods.$inferSelect> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const inserted = new Set<string>();
  const ordered: Array<typeof paymentMethods.$inferSelect> = [];

  const visit = (row: typeof paymentMethods.$inferSelect, stack: Set<string>) => {
    if (inserted.has(row.id)) {
      return;
    }
    if (stack.has(row.id)) {
      throw new Error('Snapshot contains cyclic payment method references.');
    }
    stack.add(row.id);
    if (row.fundedById && byId.has(row.fundedById)) {
      visit(byId.get(row.fundedById)!, stack);
    }
    if (row.replacesId && byId.has(row.replacesId)) {
      visit(byId.get(row.replacesId)!, stack);
    }
    stack.delete(row.id);
    inserted.add(row.id);
    ordered.push(row);
  };

  for (const row of rows) {
    visit(row, new Set());
  }
  return ordered;
}

