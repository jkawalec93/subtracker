import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { IsoDate } from '@domain/types';

export const DEFAULT_BACKUP_RETENTION = 14;
const BACKUP_FILE_PATTERN = /^backup-\d{4}-\d{2}-\d{2}.*\.db$/;

export interface BackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Creates a consistent SQLite snapshot using VACUUM INTO and prunes backups beyond retention.
 */
export function createSqliteBackup(
  sqlite: Database.Database,
  backupsDir: string,
  fileName: string,
  retentionCount = DEFAULT_BACKUP_RETENTION,
): string {
  const resolvedDir = path.resolve(backupsDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const targetPath = path.join(resolvedDir, fileName);
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  sqlite.prepare('VACUUM INTO ?').run(targetPath);
  pruneOldBackups(resolvedDir, retentionCount);
  return targetPath;
}

/**
 * Ensures at most one automatic daily backup file (backup-YYYY-MM-DD.db) exists for `today`.
 */
export function ensureDailyBackup(
  sqlite: Database.Database,
  backupsDir: string,
  today: IsoDate,
  retentionCount = DEFAULT_BACKUP_RETENTION,
): string | null {
  const resolvedDir = path.resolve(backupsDir);
  const dailyFileName = `backup-${today}.db`;
  const targetPath = path.join(resolvedDir, dailyFileName);
  if (fs.existsSync(targetPath)) {
    return null;
  }
  return createSqliteBackup(sqlite, resolvedDir, dailyFileName, retentionCount);
}

/**
 * Creates a timestamped backup before destructive operations like JSON import.
 */
export function createTimestampedBackup(
  sqlite: Database.Database,
  backupsDir: string,
  label: string,
  today: IsoDate,
  retentionCount = DEFAULT_BACKUP_RETENTION,
): string {
  const timePart = new Date()
    .toISOString()
    .slice(11, 19)
    .replaceAll(':', '-');
  const fileName = `backup-${today}-${timePart}-${label}.db`;
  return createSqliteBackup(sqlite, backupsDir, fileName, retentionCount);
}

/** Keeps the newest `retentionCount` backup files matching backup-YYYY-MM-DD*.db. */
export function pruneOldBackups(
  backupsDir: string,
  retentionCount = DEFAULT_BACKUP_RETENTION,
): number {
  const resolvedDir = path.resolve(backupsDir);
  if (!fs.existsSync(resolvedDir)) {
    return 0;
  }

  const keep = Math.max(1, retentionCount);
  const entries = fs
    .readdirSync(resolvedDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort(); // ISO dates sort chronologically

  if (entries.length <= keep) {
    return 0;
  }

  const toRemove = entries.slice(0, entries.length - keep);
  for (const name of toRemove) {
    fs.unlinkSync(path.join(resolvedDir, name));
  }
  return toRemove.length;
}

/** Lists existing SQLite backup files newest-first. */
export function listBackupFiles(backupsDir: string): BackupFileInfo[] {
  const resolvedDir = path.resolve(backupsDir);
  if (!fs.existsSync(resolvedDir)) {
    return [];
  }

  return fs
    .readdirSync(resolvedDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const stats = fs.statSync(path.join(resolvedDir, name));
      return {
        name,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
    });
}

