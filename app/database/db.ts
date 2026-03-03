import * as SQLite from 'expo-sqlite';

import { runMigrations } from './migrations';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let initPromise: Promise<void> | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('r503_trip_logger.db');
  }

  const db = await dbPromise;
  if (!initPromise) {
    initPromise = runMigrations(db);
  }

  await initPromise;
  return db;
}
