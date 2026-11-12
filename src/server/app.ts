import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Repositories } from '@db/index';
import { buildDashboardAttentionSummary } from '@domain/alerts';
import { getTodayInTimeZone } from '@domain/dates';
import { DOMAIN_VERSION } from '@domain/index';
import { resolvePaymentMethodHealth } from '@domain/payment-methods';
import { resolvePriceForDate } from '@domain/pricing';
import type {
  CardBrand,
  IntervalUnit,
  IsoDate,
  PaymentMethodKind,
  ServiceKind,
  ServiceStatus,
} from '@domain/types';
import { createAuthService } from './auth';
import {
  createTimestampedBackup,
  DEFAULT_BACKUP_RETENTION,
  listBackupFiles,
} from './backup';
import { HttpError, mapErrorToResponse, readJsonBody } from './http-helpers';

export interface CreateAppOptions {
  sqlite: Database.Database;
  repos: Repositories;
  appPassword: string | null;
  backupsDir: string;
  staticDir?: string;
  isMemoryDb?: boolean;
}

/**
 * Creates the configured Hono application with REST API, auth, backup, and static SPA routes.
 */
export function createApp({
  sqlite,
  repos,
  appPassword,
  backupsDir,
  staticDir,
  isMemoryDb = false,
}: CreateAppOptions): Hono {
  const app = new Hono();
  const auth = createAuthService(appPassword);

  // Basic security headers on every response.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.use('/api/*', auth.requireAuthMiddleware);

  app.onError((err, c) => mapErrorToResponse(c, err));

  // --- Health & Auth ---
  app.get('/api/health', (c) => {
    return c.json({ ok: true, domainVersion: DOMAIN_VERSION });
  });

  app.get('/api/auth/status', (c) => {
    return c.json({
      authRequired: auth.enabled,
      authenticated: auth.isAuthenticatedRequest(c),
    });
  });

  app.post('/api/auth/login', async (c) => {
    if (!auth.enabled) {
      return c.json({ ok: true, authRequired: false });
    }
    const body = await readJsonBody<{ password?: unknown }>(c);
    if (typeof body.password !== 'string' || !auth.verifyPassword(body.password)) {
      throw new HttpError(401, 'Invalid password.');
    }
    const token = auth.issueToken();
    auth.setSessionCookie(c, token);
    return c.json({ ok: true, token });
  });

  app.post('/api/auth/logout', (c) => {
    auth.clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // --- Dashboard ---
  app.get('/api/dashboard', (c) => {
    const alertSettings = repos.settings.getAlertSettings();
    const today = getTodayInTimeZone(alertSettings.timeZone);
    const methods = repos.paymentMethods.list();
    const services = repos.services.list();
    const prices = repos.services.listPrices();
    const migrations = repos.migrations.list();

    const summary = buildDashboardAttentionSummary({
      methods,
      services,
      prices,
      migrations,
      today,
      settings: alertSettings,
    });

    const methodsById = new Map(methods.map((m) => [m.id, m]));
    const openMigrationsEnriched = summary.openMigrations.map((migration) => {
      const detail = repos.migrations.getDetail(migration.id);
      const totalItems = detail?.items.length ?? 0;
      const doneItems = detail?.items.filter((i) => i.item.doneAt !== null).length ?? 0;
      return {
        migration,
        oldMethod: methodsById.get(migration.oldMethodId) ?? null,
        newMethod: migration.newMethodId
          ? (methodsById.get(migration.newMethodId) ?? null)
          : null,
        totalItems,
        doneItems,
      };
    });

    return c.json({
      ...summary,
      openMigrationsEnriched,
    });
  });

  // --- Payment Methods ---
  app.get('/api/payment-methods', (c) => {
    const alertSettings = repos.settings.getAlertSettings();
    const today = getTodayInTimeZone(alertSettings.timeZone);
    const includeArchived = c.req.query('includeArchived') !== 'false';
    const methods = repos.paymentMethods.list();

    const result = methods
      .filter((m) => includeArchived || m.archivedAt === null)
      .map((m) => ({
        ...m,
        health: resolvePaymentMethodHealth(methods, m.id, today),
      }));

    return c.json({ items: result });
  });

  app.post('/api/payment-methods', async (c) => {
    const body = await readJsonBody<{
      name?: string;
      kind?: PaymentMethodKind;
      cardBrand?: CardBrand | null;
      last4?: string | null;
      expiryMonth?: number | null;
      expiryYear?: number | null;
      fundedById?: string | null;
      replacesId?: string | null;
    }>(c);

    if (typeof body.name !== 'string' || typeof body.kind !== 'string') {
      throw new HttpError(400, 'Fields "name" and "kind" are required.');
    }

    const created = repos.paymentMethods.create({
      name: body.name,
      kind: body.kind,
      cardBrand: body.cardBrand,
      last4: body.last4,
      expiryMonth: body.expiryMonth,
      expiryYear: body.expiryYear,
      fundedById: body.fundedById,
      replacesId: body.replacesId,
    });
    return c.json({ item: created }, 201);
  });

  app.patch('/api/payment-methods/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody<{
      name?: string;
      kind?: PaymentMethodKind;
      cardBrand?: CardBrand | null;
      last4?: string | null;
      expiryMonth?: number | null;
      expiryYear?: number | null;
      fundedById?: string | null;
    }>(c);
    const updated = repos.paymentMethods.update(id, body);
    return c.json({ item: updated });
  });

  app.post('/api/payment-methods/:id/archive', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody<{ archived?: boolean }>(c);
    if (typeof body.archived !== 'boolean') {
      throw new HttpError(400, 'Boolean field "archived" is required.');
    }
    const updated = repos.paymentMethods.setArchived(id, body.archived);
    return c.json({ item: updated });
  });

  app.delete('/api/payment-methods/:id', (c) => {
    repos.paymentMethods.softDelete(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- Card Migrations ---
  app.get('/api/migrations', (c) => {
    const list = repos.migrations.list();
    const details = list
      .map((m) => repos.migrations.getDetail(m.id))
      .filter((d): d is NonNullable<typeof d> => d !== null);
    return c.json({ items: details });
  });

  app.get('/api/migrations/:id', (c) => {
    const detail = repos.migrations.getDetail(c.req.param('id'));
    if (!detail) {
      throw new HttpError(404, 'Card migration not found.');
    }
    return c.json(detail);
  });

  app.post('/api/migrations', async (c) => {
    const body = await readJsonBody<{
      oldMethodId?: string;
      newMethodId?: string | null;
    }>(c);
    if (typeof body.oldMethodId !== 'string') {
      throw new HttpError(400, 'Field "oldMethodId" is required.');
    }
    const created = repos.migrations.startMigration(
      body.oldMethodId,
      body.newMethodId ?? null,
    );
    const detail = repos.migrations.getDetail(created.id);
    return c.json(detail, 201);
  });

  app.patch('/api/migrations/items/:itemId', async (c) => {
    const body = await readJsonBody<{ done?: boolean }>(c);
    if (typeof body.done !== 'boolean') {
      throw new HttpError(400, 'Boolean field "done" is required.');
    }
    const detail = repos.migrations.toggleItem(c.req.param('itemId'), body.done);
    return c.json(detail);
  });

  // --- Categories ---
  app.get('/api/categories', (c) => {
    return c.json({ items: repos.categories.list() });
  });

  app.post('/api/categories', async (c) => {
    const body = await readJsonBody<{ name?: string }>(c);
    if (typeof body.name !== 'string') {
      throw new HttpError(400, 'Field "name" is required.');
    }
    const created = repos.categories.create(body.name);
    return c.json({ item: created }, 201);
  });

  app.patch('/api/categories/:id', async (c) => {
    const body = await readJsonBody<{ name?: string }>(c);
    if (typeof body.name !== 'string') {
      throw new HttpError(400, 'Field "name" is required.');
    }
    const updated = repos.categories.update(c.req.param('id'), body.name);
    return c.json({ item: updated });
  });

  app.delete('/api/categories/:id', (c) => {
    repos.categories.softDelete(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- Services & Prices ---
  app.get('/api/services', (c) => {
    const alertSettings = repos.settings.getAlertSettings();
    const today = getTodayInTimeZone(alertSettings.timeZone);
    const allMethods = repos.paymentMethods.list();
    const allPrices = repos.services.listPrices();
    const allServices = repos.services.list();

    const items = allServices.map((svc) => {
      const priceHistory = allPrices.filter((p) => p.serviceId === svc.id);
      const currentPrice = resolvePriceForDate(priceHistory, svc.id, today);
      const methodHealth = resolvePaymentMethodHealth(
        allMethods,
        svc.paymentMethodId,
        today,
      );
      return {
        ...svc,
        currentPrice,
        priceHistory,
        methodHealth,
      };
    });

    return c.json({ items });
  });

  app.post('/api/services', async (c) => {
    const body = await readJsonBody<{
      name?: string;
      kind?: ServiceKind;
      categoryId?: string | null;
      paymentMethodId?: string | null;
      status?: ServiceStatus;
      intervalUnit?: IntervalUnit | null;
      intervalCount?: number | null;
      billingAnchorDate?: IsoDate | null;
      trialEndsAt?: IsoDate | null;
      paidUntil?: IsoDate | null;
      notes?: string | null;
      initialPrice?: {
        amountMinor: number;
        currency: string;
        validFrom: IsoDate;
      } | null;
    }>(c);

    if (typeof body.name !== 'string' || typeof body.kind !== 'string') {
      throw new HttpError(400, 'Fields "name" and "kind" are required.');
    }

    const created = repos.services.create({
      name: body.name,
      kind: body.kind,
      categoryId: body.categoryId,
      paymentMethodId: body.paymentMethodId,
      status: body.status,
      intervalUnit: body.intervalUnit,
      intervalCount: body.intervalCount,
      billingAnchorDate: body.billingAnchorDate,
      trialEndsAt: body.trialEndsAt,
      paidUntil: body.paidUntil,
      notes: body.notes,
      initialPrice: body.initialPrice,
    });
    return c.json({ item: created }, 201);
  });

  app.patch('/api/services/:id', async (c) => {
    const body = await readJsonBody<{
      name?: string;
      categoryId?: string | null;
      paymentMethodId?: string | null;
      status?: ServiceStatus;
      intervalUnit?: IntervalUnit | null;
      intervalCount?: number | null;
      billingAnchorDate?: IsoDate | null;
      trialEndsAt?: IsoDate | null;
      paidUntil?: IsoDate | null;
      notes?: string | null;
    }>(c);
    const updated = repos.services.update(c.req.param('id'), body);
    return c.json({ item: updated });
  });

  app.delete('/api/services/:id', (c) => {
    repos.services.softDelete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/services/:id/prices', async (c) => {
    const body = await readJsonBody<{
      amountMinor?: number;
      currency?: string;
      validFrom?: IsoDate;
    }>(c);
    if (
      typeof body.amountMinor !== 'number' ||
      typeof body.currency !== 'string' ||
      typeof body.validFrom !== 'string'
    ) {
      throw new HttpError(
        400,
        'Fields "amountMinor", "currency", and "validFrom" are required.',
      );
    }
    const price = repos.services.upsertPrice(c.req.param('id'), {
      amountMinor: body.amountMinor,
      currency: body.currency,
      validFrom: body.validFrom,
    });
    return c.json({ item: price });
  });

  app.get('/api/services/:id/billing-events', (c) => {
    const events = repos.billingEvents.listByService(c.req.param('id'));
    return c.json({ items: events });
  });

  app.get('/api/billing-events', (c) => {
    const serviceId = c.req.query('serviceId');
    const events = serviceId
      ? repos.billingEvents.listByService(serviceId)
      : repos.billingEvents.listAll();
    const allServices = repos.services.list(true);
    const servicesById = new Map(allServices.map((s) => [s.id, s]));

    const items = events.map((ev) => {
      const svc = servicesById.get(ev.serviceId);
      return {
        ...ev,
        serviceName: svc ? svc.name : 'Usunięta usługa',
        serviceDeleted: svc ? svc.deletedAt !== null : true,
      };
    });
    return c.json({ items });
  });

  app.post('/api/scheduler/run', (c) => {
    const result = repos.billingEvents.runCatchUpScheduler();
    return c.json(result);
  });

  // --- Settings & Backup ---
  app.get('/api/settings', (c) => {
    return c.json({
      alertSettings: repos.settings.getAlertSettings(),
      raw: repos.settings.getAllMap(),
    });
  });

  app.put('/api/settings', async (c) => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === null || v === undefined) {
        continue;
      }
      normalized[k] = String(v);
    }
    repos.settings.setMany(normalized);
    return c.json({
      alertSettings: repos.settings.getAlertSettings(),
      raw: repos.settings.getAllMap(),
    });
  });

  app.get('/api/backup/export', (c) => {
    const snapshot = repos.backup.exportSnapshot();
    const today = getTodayInTimeZone(repos.settings.getAlertSettings().timeZone);
    c.header(
      'Content-Disposition',
      `attachment; filename="subtrack-backup-${today}.json"`,
    );
    return c.json(snapshot);
  });

  app.post('/api/backup/import', async (c) => {
    const snapshot = await readJsonBody<unknown>(c);
    if (!isMemoryDb) {
      const settingsMap = repos.settings.getAllMap();
      const tz = repos.settings.getAlertSettings().timeZone;
      const today = getTodayInTimeZone(tz);
      const retention = Number(settingsMap.backupRetentionCount ?? DEFAULT_BACKUP_RETENTION);
      createTimestampedBackup(
        sqlite,
        backupsDir,
        'pre-import',
        today,
        Number.isInteger(retention) && retention >= 1 ? retention : DEFAULT_BACKUP_RETENTION,
      );
    }
    repos.backup.importSnapshot(snapshot);
    return c.json({ ok: true });
  });

  app.get('/api/backup/files', (c) => {
    return c.json({ items: listBackupFiles(backupsDir) });
  });

  app.post('/api/backup/run', (c) => {
    if (isMemoryDb) {
      throw new HttpError(400, 'SQLite file backup is not supported for in-memory DB.');
    }
    const settingsMap = repos.settings.getAllMap();
    const tz = repos.settings.getAlertSettings().timeZone;
    const today = getTodayInTimeZone(tz);
    const retention = Number(settingsMap.backupRetentionCount ?? DEFAULT_BACKUP_RETENTION);
    const filePath = createTimestampedBackup(
      sqlite,
      backupsDir,
      'manual',
      today,
      Number.isInteger(retention) && retention >= 1 ? retention : DEFAULT_BACKUP_RETENTION,
    );
    return c.json({
      ok: true,
      fileName: path.basename(filePath),
      items: listBackupFiles(backupsDir),
    });
  });

  // --- Static Frontend (production bundle) ---
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    const relativeRoot = path.relative(process.cwd(), path.resolve(staticDir)) || '.';
    app.use('*', serveStatic({ root: relativeRoot }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Not found.' }, 404);
      }
      const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
      return c.html(html);
    });
  }

  return app;
}

