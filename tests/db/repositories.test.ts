import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDashboardAttentionSummary } from '@domain/alerts';
import {
  createRepositories,
  openDatabase,
  runMigrations,
  services,
  type DatabaseHandle,
  type Repositories,
} from '@db/index';

describe('database migrations and repositories', () => {
  let handle: DatabaseHandle;
  let repos: Repositories;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    runMigrations(handle.db);
    repos = createRepositories(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it('enforces foreign keys and preserves billing_events after service soft-delete', () => {
    expect(() =>
      handle.db
        .insert(services)
        .values({
          id: 'bad-svc',
          name: 'Broken',
          kind: 'on_demand',
          categoryId: null,
          paymentMethodId: 'non-existent-method',
          status: 'active',
          intervalUnit: null,
          intervalCount: null,
          billingAnchorDate: null,
          trialEndsAt: null,
          paidUntil: null,
          notes: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          deletedAt: null,
        })
        .run(),
    ).toThrow();

    const card = repos.paymentMethods.create({
      name: 'mBank Visa',
      kind: 'card',
      cardBrand: 'visa',
      last4: '4321',
      expiryMonth: 12,
      expiryYear: 2028,
    });

    const svc = repos.services.create({
      name: 'Netflix',
      kind: 'subscription',
      paymentMethodId: card.id,
      status: 'active',
      intervalUnit: 'month',
      intervalCount: 1,
      billingAnchorDate: '2026-01-15',
      initialPrice: {
        amountMinor: 4900,
        currency: 'PLN',
        validFrom: '2026-01-01',
      },
    });

    const run1 = repos.billingEvents.runCatchUpScheduler('2026-03-20');
    expect(run1.createdCount).toBe(3);

    repos.services.softDelete(svc.id);
    expect(repos.services.getById(svc.id)).toBeNull();
    expect(repos.billingEvents.listByService(svc.id)).toHaveLength(3);
  });

  it('runs scheduler idempotently, transitions trial to active, and upserts same-day price', () => {
    const svc = repos.services.create({
      name: 'Linear',
      kind: 'subscription',
      status: 'trial',
      intervalUnit: 'month',
      intervalCount: 1,
      trialEndsAt: '2026-05-10',
      initialPrice: {
        amountMinor: 3200,
        currency: 'PLN',
        validFrom: '2026-05-01',
      },
    });

    expect(svc.billingAnchorDate).toBe('2026-05-10');

    // Overwrite price on same validFrom date.
    repos.services.upsertPrice(svc.id, {
      amountMinor: 3500,
      currency: 'PLN',
      validFrom: '2026-05-01',
    });
    expect(repos.services.listPrices(svc.id)).toHaveLength(1);
    expect(repos.services.listPrices(svc.id)[0]?.amountMinor).toBe(3500);

    const beforeEnd = repos.billingEvents.runCatchUpScheduler('2026-05-09');
    expect(beforeEnd.createdCount).toBe(0);

    const onEnd = repos.billingEvents.runCatchUpScheduler('2026-05-10');
    expect(onEnd.createdCount).toBe(1);
    expect(onEnd.transitionedServiceIds).toEqual([svc.id]);
    expect(repos.services.getById(svc.id)?.status).toBe('active');
    expect(repos.billingEvents.listByService(svc.id)[0]?.amountMinor).toBe(3500);

    const duplicateRun = repos.billingEvents.runCatchUpScheduler('2026-05-10');
    expect(duplicateRun.createdCount).toBe(0);
  });

  it('handles card migration without new card first, attaches replacement later, relinks items, and auto-archives old card', () => {
    const oldCard = repos.paymentMethods.create({
      name: 'Old Card',
      kind: 'card',
      cardBrand: 'mastercard',
      last4: '1111',
      expiryMonth: 4,
      expiryYear: 2026,
    });
    const paypal = repos.paymentMethods.create({
      name: 'PayPal',
      kind: 'wallet',
      fundedById: oldCard.id,
    });
    const netflix = repos.services.create({
      name: 'Netflix',
      kind: 'subscription',
      paymentMethodId: oldCard.id,
      status: 'active',
      intervalUnit: 'month',
      intervalCount: 1,
      billingAnchorDate: '2026-01-01',
      initialPrice: { amountMinor: 4900, currency: 'PLN', validFrom: '2026-01-01' },
    });
    repos.services.create({
      name: 'Uber',
      kind: 'on_demand',
      paymentMethodId: paypal.id,
    });

    // Start manual migration before receiving new card.
    const migration = repos.migrations.startMigration(oldCard.id, null);
    expect(migration.newMethodId).toBeNull();

    // Receive new card with replacesId -> attaches to open migration.
    const newCard = repos.paymentMethods.create({
      name: 'New Card',
      kind: 'card',
      cardBrand: 'mastercard',
      last4: '9999',
      expiryMonth: 4,
      expiryYear: 2030,
      replacesId: oldCard.id,
    });

    const detail = repos.migrations.getDetail(migration.id)!;
    expect(detail.migration.newMethodId).toBe(newCard.id);
    expect(detail.items).toHaveLength(2);

    for (const entry of detail.items) {
      repos.migrations.toggleItem(entry.item.id, true);
    }

    const completed = repos.migrations.getDetail(migration.id)!;
    expect(completed.migration.completedAt).not.toBeNull();
    expect(repos.paymentMethods.getById(oldCard.id)?.archivedAt).not.toBeNull();
    expect(repos.services.getById(netflix.id)?.paymentMethodId).toBe(newCard.id);
    expect(repos.paymentMethods.getById(paypal.id)?.fundedById).toBe(newCard.id);
  });

  it('flags services when a payment method in their chain is archived', () => {
    const card = repos.paymentMethods.create({
      name: 'Revolut',
      kind: 'card',
      cardBrand: 'visa',
      expiryMonth: 12,
      expiryYear: 2028,
    });
    const appleId = repos.paymentMethods.create({
      name: 'Apple ID',
      kind: 'store_account',
      fundedById: card.id,
    });
    const icloud = repos.services.create({
      name: 'iCloud+',
      kind: 'subscription',
      paymentMethodId: appleId.id,
      status: 'active',
      intervalUnit: 'month',
      intervalCount: 1,
      billingAnchorDate: '2026-01-05',
      initialPrice: { amountMinor: 499, currency: 'PLN', validFrom: '2026-01-01' },
    });

    repos.paymentMethods.setArchived(card.id, true);

    const summary = buildDashboardAttentionSummary({
      methods: repos.paymentMethods.list(),
      services: repos.services.list(),
      prices: repos.services.listPrices(),
      migrations: repos.migrations.list(),
      today: '2026-05-01',
    });

    expect(summary.unhealthyServices.map((u) => [u.service.id, u.health.issue])).toEqual([
      [icloud.id, 'archived_method'],
    ]);
  });

  it('exports and imports full JSON snapshot atomically and rolls back invalid imports', () => {
    const cat = repos.categories.create('Rozrywka');
    const card = repos.paymentMethods.create({
      name: 'Visa',
      kind: 'card',
      cardBrand: 'visa',
      last4: '5555',
      expiryMonth: 11,
      expiryYear: 2029,
    });
    const svc = repos.services.create({
      name: 'Spotify',
      kind: 'subscription',
      categoryId: cat.id,
      paymentMethodId: card.id,
      status: 'active',
      intervalUnit: 'month',
      intervalCount: 1,
      billingAnchorDate: '2026-01-01',
      initialPrice: { amountMinor: 2399, currency: 'PLN', validFrom: '2026-01-01' },
    });
    repos.billingEvents.runCatchUpScheduler('2026-02-01');
    repos.settings.setMany({ timeZone: 'Europe/Warsaw', trialAlertDays: '5' });

    const snapshot = repos.backup.exportSnapshot();

    // Invalid import must fail without wiping existing data.
    expect(() => repos.backup.importSnapshot({ version: 99, tables: {} })).toThrow();
    expect(repos.services.getById(svc.id)).not.toBeNull();

    // Import into a brand new database cleanly restores all records.
    const freshHandle = openDatabase(':memory:');
    try {
      runMigrations(freshHandle.db);
      const freshRepos = createRepositories(freshHandle.db);
      freshRepos.backup.importSnapshot(snapshot);

      expect(freshRepos.categories.list()).toHaveLength(1);
      expect(freshRepos.paymentMethods.list()).toHaveLength(1);
      expect(freshRepos.services.list()).toHaveLength(1);
      expect(freshRepos.billingEvents.listAll()).toHaveLength(2);
      expect(freshRepos.settings.getAlertSettings().trialAlertDays).toBe(5);
    } finally {
      freshHandle.close();
    }
  });
});

