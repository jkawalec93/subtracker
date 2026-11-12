import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE_NAME = 'subtrack_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface SessionPayload {
  iat: number;
  exp: number;
}

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = sha256Buffer(a);
  const bufB = sha256Buffer(b);
  return timingSafeEqual(bufA, bufB);
}

export interface AuthService {
  readonly enabled: boolean;
  verifyPassword: (candidate: string) => boolean;
  issueToken: (nowMs?: number) => string;
  verifyToken: (token: string | undefined, nowMs?: number) => boolean;
  isAuthenticatedRequest: (c: Context) => boolean;
  setSessionCookie: (c: Context, token: string) => void;
  clearSessionCookie: (c: Context) => void;
  requireAuthMiddleware: MiddlewareHandler;
}

/**
 * Stateless HMAC-signed session service supporting both HttpOnly cookies (web)
 * and Authorization Bearer headers (future mobile client).
 */
export function createAuthService(appPassword: string | null): AuthService {
  const enabled = Boolean(appPassword && appPassword.length > 0);
  const signingKey = enabled
    ? sha256Buffer(`subtrack-session-v1:${appPassword}`)
    : Buffer.alloc(0);

  const verifyPassword = (candidate: string): boolean => {
    if (!enabled || !appPassword) {
      return false;
    }
    return constantTimeEquals(candidate, appPassword);
  };

  const sign = (encodedPayload: string): string => {
    return createHmac('sha256', signingKey)
      .update(encodedPayload)
      .digest('base64url');
  };

  const issueToken = (nowMs = Date.now()): string => {
    const iat = Math.floor(nowMs / 1000);
    const payload: SessionPayload = {
      iat,
      exp: iat + SESSION_TTL_SECONDS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    return `${encoded}.${sign(encoded)}`;
  };

  const verifyToken = (
    token: string | undefined,
    nowMs = Date.now(),
  ): boolean => {
    if (!enabled || !token) {
      return false;
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      return false;
    }
    const [encoded, signature] = parts;
    if (!encoded || !signature) {
      return false;
    }
    const expectedSig = sign(encoded);
    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return false;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as Partial<SessionPayload>;
      const nowSec = Math.floor(nowMs / 1000);
      return typeof parsed.exp === 'number' && parsed.exp > nowSec;
    } catch {
      return false;
    }
  };

  const extractToken = (c: Context): string | undefined => {
    const authHeader = c.req.header('authorization');
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.slice(7).trim();
    }
    return getCookie(c, SESSION_COOKIE_NAME);
  };

  const isAuthenticatedRequest = (c: Context): boolean => {
    if (!enabled) {
      return true;
    }
    return verifyToken(extractToken(c));
  };

  const isSecureRequest = (c: Context): boolean => {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) {
      return proto.split(',')[0]?.trim().toLowerCase() === 'https';
    }
    return c.req.url.startsWith('https://');
  };

  const setSessionCookie = (c: Context, token: string): void => {
    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
      secure: isSecureRequest(c),
    });
  };

  const clearSessionCookie = (c: Context): void => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  };

  const PUBLIC_API_PATHS = new Set([
    '/api/health',
    '/api/auth/status',
    '/api/auth/login',
    '/api/auth/logout',
  ]);

  const requireAuthMiddleware: MiddlewareHandler = async (c, next) => {
    if (!enabled || PUBLIC_API_PATHS.has(c.req.path)) {
      return next();
    }
    if (!isAuthenticatedRequest(c)) {
      return c.json({ error: 'Authentication required.' }, 401);
    }
    return next();
  };

  return {
    enabled,
    verifyPassword,
    issueToken,
    verifyToken,
    isAuthenticatedRequest,
    setSessionCookie,
    clearSessionCookie,
    requireAuthMiddleware,
  };
}

