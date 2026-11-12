export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  backupsDir: string;
  appPassword: string | null;
  staticDir: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Loads and validates server runtime configuration from environment variables.
 * Refuses non-loopback binding when APP_PASSWORD is not configured.
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const host = (env.HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${rawPort}".`);
  }

  const appPassword = env.APP_PASSWORD?.trim() || null;
  if (!isLoopbackHost(host) && !appPassword) {
    throw new Error(
      `Refusing to listen on "${host}" without APP_PASSWORD set. Set APP_PASSWORD to enable LAN access.`,
    );
  }

  return {
    host,
    port,
    dbPath: env.DB_PATH?.trim() || './subtrack.db',
    backupsDir: env.BACKUPS_DIR?.trim() || './backups',
    appPassword,
    staticDir: env.STATIC_DIR?.trim() || './dist/web',
  };
}

