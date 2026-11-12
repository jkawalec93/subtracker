import type Database from 'better-sqlite3';
import type { Repositories } from '@db/index';
import { getTodayInTimeZone } from '@domain/dates';
import type { IsoDate } from '@domain/types';
import { DEFAULT_BACKUP_RETENTION, ensureDailyBackup } from './backup';

export interface BackgroundJobsOptions {
  sqlite: Database.Database;
  repos: Repositories;
  backupsDir: string;
  isMemoryDb?: boolean;
  checkIntervalMs?: number;
}

export interface BackgroundJobsHandle {
  runNow: () => void;
  stop: () => void;
}

function getLocalHourMinute(timeZone: string, now = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

function getRetentionCount(repos: Repositories): number {
  const raw = repos.settings.getAllMap().backupRetentionCount;
  if (!raw) {
    return DEFAULT_BACKUP_RETENTION;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_BACKUP_RETENTION;
}

/**
 * Runs catch-up billing generation and daily SQLite backup on startup and daily at 06:00
 * in the configured timezone (resilient to DST shifts and laptop sleep/wake).
 */
export function startBackgroundJobs({
  sqlite,
  repos,
  backupsDir,
  isMemoryDb = false,
  checkIntervalMs = 60_000,
}: BackgroundJobsOptions): BackgroundJobsHandle {
  let lastDailyRunDate: IsoDate | null = null;

  const runTasks = (today: IsoDate, markDailyRun: boolean): void => {
    repos.billingEvents.runCatchUpScheduler(today);
    if (!isMemoryDb) {
      ensureDailyBackup(sqlite, backupsDir, today, getRetentionCount(repos));
    }
    if (markDailyRun) {
      lastDailyRunDate = today;
    }
  };

  // Startup catch-up run.
  const initialTz = repos.settings.getAlertSettings().timeZone;
  const initialToday = getTodayInTimeZone(initialTz);
  const initialHm = getLocalHourMinute(initialTz);
  runTasks(initialToday, initialHm.hour >= 6);

  const timer = setInterval(() => {
    try {
      const tz = repos.settings.getAlertSettings().timeZone;
      const now = new Date();
      const today = getTodayInTimeZone(tz, now);
      const { hour } = getLocalHourMinute(tz, now);
      if (hour >= 6 && lastDailyRunDate !== today) {
        runTasks(today, true);
      }
    } catch (err) {
      console.error('Background job tick failed:', err);
    }
  }, checkIntervalMs);

  timer.unref();

  return {
    runNow: () => {
      const tz = repos.settings.getAlertSettings().timeZone;
      const today = getTodayInTimeZone(tz);
      runTasks(today, true);
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

