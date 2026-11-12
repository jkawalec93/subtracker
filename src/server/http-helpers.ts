import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonBody<T>(c: Context): Promise<T> {
  try {
    const data = await c.req.json();
    if (typeof data !== 'object' || data === null) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return data as T;
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

export function mapErrorToResponse(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof Error) {
    const msg = err.message;
    if (msg.toLowerCase().includes('not found')) {
      return c.json({ error: msg }, 404);
    }
    if (msg.toLowerCase().includes('already exists') || msg.includes('UNIQUE constraint')) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 400);
  }

  return c.json({ error: 'Unexpected internal server error.' }, 500);
}

