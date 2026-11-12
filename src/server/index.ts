import { Hono } from 'hono';
import { DOMAIN_VERSION } from '@domain/index';

/**
 * HTTP API entry point (Hono).
 * Full endpoints, scheduler, and static frontend serving will be wired in Stage 4.
 */
export function createApp() {
  const app = new Hono();

  app.get('/api/health', (c) => {
    return c.json({ ok: true, domainVersion: DOMAIN_VERSION });
  });

  return app;
}

