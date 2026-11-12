import type { SubtrackDatabase } from './client';
import { BackupRepository } from './repositories/backup.repo';
import { BillingEventsRepository } from './repositories/billing-events.repo';
import { CategoriesRepository } from './repositories/categories.repo';
import { MigrationsRepository } from './repositories/migrations.repo';
import { PaymentMethodsRepository } from './repositories/payment-methods.repo';
import { ServicesRepository } from './repositories/services.repo';
import { SettingsRepository } from './repositories/settings.repo';

export * from './client';
export * from './migrate';
export * from './schema';
export * from './repositories/backup.repo';
export * from './repositories/billing-events.repo';
export * from './repositories/categories.repo';
export * from './repositories/migrations.repo';
export * from './repositories/payment-methods.repo';
export * from './repositories/services.repo';
export * from './repositories/settings.repo';

export interface Repositories {
  paymentMethods: PaymentMethodsRepository;
  categories: CategoriesRepository;
  services: ServicesRepository;
  billingEvents: BillingEventsRepository;
  migrations: MigrationsRepository;
  settings: SettingsRepository;
  backup: BackupRepository;
}

export function createRepositories(db: SubtrackDatabase): Repositories {
  return {
    paymentMethods: new PaymentMethodsRepository(db),
    categories: new CategoriesRepository(db),
    services: new ServicesRepository(db),
    billingEvents: new BillingEventsRepository(db),
    migrations: new MigrationsRepository(db),
    settings: new SettingsRepository(db),
    backup: new BackupRepository(db),
  };
}

