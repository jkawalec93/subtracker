import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createRepositories, openDatabase, runMigrations } from '@db/index';
import { createApp } from './app';
import { loadServerConfig } from './config';
import { startBackgroundJobs } from './jobs';

export { createApp } from './app';
export { loadServerConfig, isLoopbackHost } from './config';
export {
  createSqliteBackup,
  ensureDailyBackup,
  listBackupFiles,
  pruneOldBackups,
} from './backup';
export { startBackgroundJobs } from './jobs';

function main(): void {
  const config = loadServerConfig();
  const handle = openDatabase(config.dbPath);
  runMigrations(handle.db);
  const repos = createRepositories(handle.db);

  const jobs = startBackgroundJobs({
    sqlite: handle.sqlite,
    repos,
    backupsDir: config.backupsDir,
    isMemoryDb: config.dbPath === ':memory:',
  });

  const app = createApp({
    sqlite: handle.sqlite,
    repos,
    appPassword: config.appPassword,
    backupsDir: config.backupsDir,
    staticDir: config.staticDir,
    isMemoryDb: config.dbPath === ':memory:',
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      console.log(
        `SubTrack listening on http://${config.host}:${info.port} (auth: ${config.appPassword ? 'enabled' : 'disabled'})`,
      );
    },
  );

  const shutdown = () => {
    jobs.stop();
    server.close(() => {
      handle.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  main();
}
