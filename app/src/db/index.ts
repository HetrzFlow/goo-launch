import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Database = DrizzleD1Database<typeof schema>;

export function getDb(env: { DB: D1Database }): Database {
  return drizzle(env.DB, { schema });
}
