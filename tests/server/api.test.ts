import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, openDatabase, runMigrations } from '@db/index';
import { createApp } from '@server/app';
import {
  createSqliteBackup,
  ensureDailyBackup,
  listBackupFiles,
} from '@server/backup';
import { loadServerConfig } from '@server/config';

describe('server config, auth, REST API, and SQLite backups', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtrack-srv-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses non-loopback host binding without APP_PASSWORD', () => {
    expect(loadServerConfig({ HOST: '127.0.0.1' }).appPassword).toBeNull();
    expect(() => loadServerConfig({ HOST: '0.0.0.0' })).toThrow(/APP_PASSWORD/);
    expect(
      loadServerConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'secret-pass' }).host,
    ).toBe('0.0.0.0');
  });

  it('protects API routes with APP_PASSWORD via HttpOnly cookie and Bearer token', async () => {
    const handle = openDatabase(':memory:');
    try {
      runMigrations(handle.db);
      const repos = createRepositories(handle.db);
      const app = createApp({
        sqlite: handle.sqlite,
        repos,
        appPassword: 'my-strong-password',
        backupsDir: './backups',
        isMemoryDb: true,
      });

      const healthRes = await app.request('/api/health');
      expect(healthRes.status).toBe(200);

      const unauthStatus = await app.request('/api/auth/status');
      expect(await unauthStatus.json()).toEqual({
        authRequired: true,
        authenticated: false,
      });

      const blocked = await app.request('/api/dashboard');
      expect(blocked.status).toBe(401);

      const badLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(badLogin.status).toBe(401);

      const okLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'my-strong-password' }),
      });
      expect(okLogin.status).toBe(200);
      const setCookie = okLogin.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('subtrack_session=');
      expect(setCookie.toLowerCase()).toContain('httponly');

      const loginBody = (await okLogin.json()) as { ok: boolean; token: string };
      expect(loginBody.ok).toBe(true);

      const viaBearer = await app.request('/api/dashboard', {
        headers: { authorization: `Bearer ${loginBody.token}` },
      });
      expect(viaBearer.status).toBe(200);

      const cookieValue = setCookie.split(';')[0] ?? '';
      const viaCookie = await app.request('/api/dashboard', {
        headers: { cookie: cookieValue },
      });
      expect(viaCookie.status).toBe(200);
    } finally {
      handle.close();
    }
  });

  it('supports full REST lifecycle, VACUUM INTO backups with retention, and JSON export/import', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'test.db');
    const backupsDir = path.join(tmpDir, 'backups');

    const handle = openDatabase(dbPath);
    try {
      runMigrations(handle.db);
      const repos = createRepositories(handle.db);
      const app = createApp({
        sqlite: handle.sqlite,
        repos,
        appPassword: null,
        backupsDir,
        isMemoryDb: false,
      });

      // Create category, card, service, and run scheduler.
      const catRes = await app.request('/api/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Cloud' }),
      });
      expect(catRes.status).toBe(201);
      const cat = ((await catRes.json()) as { item: { id: string } }).item;

      const cardRes = await app.request('/api/payment-methods', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PKO Visa',
          kind: 'card',
          cardBrand: 'visa',
          last4: '8888',
          expiryMonth: 12,
          expiryYear: 2028,
        }),
      });
      expect(cardRes.status).toBe(201);
      const card = ((await cardRes.json()) as { item: { id: string } }).item;

      const svcRes = await app.request('/api/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'iCloud',
          kind: 'subscription',
          categoryId: cat.id,
          paymentMethodId: card.id,
          status: 'active',
          intervalUnit: 'month',
          intervalCount: 1,
          billingAnchorDate: '2026-01-01',
          initialPrice: {
            amountMinor: 1499,
            currency: 'PLN',
            validFrom: '2026-01-01',
          },
        }),
      });
      expect(svcRes.status).toBe(201);

      const schedRes = await app.request('/api/scheduler/run', { method: 'POST' });
      expect(schedRes.status).toBe(200);
      const schedBody = (await schedRes.json()) as { createdCount: number };
      expect(schedBody.createdCount).toBeGreaterThan(0);

      // Export snapshot & verify VACUUM INTO retention pruning.
      const exportRes = await app.request('/api/backup/export');
      expect(exportRes.status).toBe(200);
      const snapshot = await exportRes.json();

      for (let day = 1; day <= 16; day++) {
        const d = String(day).padStart(2, '0');
        createSqliteBackup(handle.sqlite, backupsDir, `backup-2026-10-${d}.db`, 14);
      }
      expect(listBackupFiles(backupsDir)).toHaveLength(14);
      expect(
        ensureDailyBackup(handle.sqlite, backupsDir, '2026-10-16', 14),
      ).toBeNull();

      // Re-import JSON snapshot (should auto-create pre-import backup and restore cleanly).
      const importRes = await app.request('/api/backup/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      expect(importRes.status).toBe(200);

      const servicesAfter = (await (
        await app.request('/api/services')
      ).json()) as { items: Array<{ name: string }> };
      expect(servicesAfter.items.map((s) => s.name)).toEqual(['iCloud']);
    } finally {
      handle.close();
    }
  });
});

