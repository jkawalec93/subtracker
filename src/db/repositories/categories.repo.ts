import { and, asc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { SubtrackDatabase } from '../client';
import { categories, services } from '../schema';

export interface CategoryRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export class CategoriesRepository {
  constructor(private readonly db: SubtrackDatabase) {}

  list(): CategoryRecord[] {
    return this.db
      .select()
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(asc(categories.name))
      .all();
  }

  create(name: string): CategoryRecord {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Category name is required.');
    }
    const now = new Date().toISOString();
    const [inserted] = this.db
      .insert(categories)
      .values({
        id: uuidv7(),
        name: trimmed,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .returning()
      .all();

    if (!inserted) {
      throw new Error('Failed to create category.');
    }
    return inserted;
  }

  update(id: string, name: string): CategoryRecord {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Category name is required.');
    }
    const now = new Date().toISOString();
    const [updated] = this.db
      .update(categories)
      .set({ name: trimmed, updatedAt: now })
      .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
      .returning()
      .all();

    if (!updated) {
      throw new Error('Category not found.');
    }
    return updated;
  }

  softDelete(id: string): void {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      const result = tx
        .update(categories)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
        .run();
      if (result.changes === 0) {
        throw new Error('Category not found.');
      }
      tx.update(services)
        .set({ categoryId: null, updatedAt: now })
        .where(and(eq(services.categoryId, id), isNull(services.deletedAt)))
        .run();
    });
  }
}

