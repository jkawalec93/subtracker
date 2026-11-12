import { eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@domain/types';
import type { SubtrackDatabase } from '../client';
import { settings } from '../schema';

export class SettingsRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  getAllMap(): Record<string, string> {
    const rows = this.db
      .select()
      .from(settings)
      .where(isNull(settings.deletedAt))
      .all();
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map;
  }

  getAlertSettings(): AlertSettings {
    const map = this.getAllMap();
    const thresholds = parseThresholds(map.cardExpiryThresholdsDays);
    const trialAlertDays = parseNonNegativeInt(
      map.trialAlertDays,
      DEFAULT_ALERT_SETTINGS.trialAlertDays,
    );
    const upcomingPaymentsDays = parseNonNegativeInt(
      map.upcomingPaymentsDays,
      DEFAULT_ALERT_SETTINGS.upcomingPaymentsDays,
    );
    const timeZone = map.timeZone || DEFAULT_ALERT_SETTINGS.timeZone;

    return {
      cardExpiryThresholdsDays: thresholds,
      trialAlertDays,
      upcomingPaymentsDays,
      timeZone,
    };
  }

  setMany(entries: Record<string, string>): void {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(entries)) {
        const existing = tx
          .select()
          .from(settings)
          .where(eq(settings.key, key))
          .get();

        if (existing) {
          tx.update(settings)
            .set({ value, updatedAt: now, deletedAt: null })
            .where(eq(settings.id, existing.id))
            .run();
        } else {
          tx.insert(settings)
            .values({
              id: uuidv7(),
              key,
              value,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            })
            .run();
        }
      }
    });
  }
}

function parseThresholds(raw: string | undefined): number[] {
  if (!raw) {
    return [...DEFAULT_ALERT_SETTINGS.cardExpiryThresholdsDays];
  }
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return parsed.length > 0
    ? parsed
    : [...DEFAULT_ALERT_SETTINGS.cardExpiryThresholdsDays];
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

