import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type SubtrackDatabase } from './client';

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
  import.meta.dirname,
  '../../drizzle',
);

/**
 * Applies all pending Drizzle SQL migrations to the target database.
 */
export function runMigrations(
  db: SubtrackDatabase,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): void {
  migrate(db, { migrationsFolder });
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const dbPath = process.env.DB_PATH ?? './subtrack.db';
  const handle = openDatabase(dbPath);
  try {
    runMigrations(handle.db);
    console.log(`Migrations applied successfully to ${dbPath}`);
  } finally {
    handle.close();
  }
}

