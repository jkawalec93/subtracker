import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type SubtrackDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: SubtrackDatabase;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Opens a SQLite database connection with strict foreign keys and WAL mode (for file DBs).
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

