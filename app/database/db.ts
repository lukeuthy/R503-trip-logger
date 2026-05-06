import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { runMigrations } from './migrations';

const DB_FILENAME = 'r503_trip_logger.db';
const DB_INITIALIZED_FLAG = 'db_initialized.flag';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let initPromise: Promise<void> | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_FILENAME);
  }

  const db = await dbPromise;
  if (!initPromise) {
    initPromise = runMigrations(db).then(markDbInitialized);
  }

  await initPromise;
  return db;
}

function getDbInitializedFlagPath(): string {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error('documentDirectory unavailable');
  }
  return `${baseDir}${DB_INITIALIZED_FLAG}`;
}

export async function markDbInitialized(): Promise<void> {
  await FileSystem.writeAsStringAsync(getDbInitializedFlagPath(), 'true');
}

export async function isDbInitialized(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(getDbInitializedFlagPath());
  return info.exists;
}

export async function waitForDbInitialized(timeoutMs = 5000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await isDbInitialized()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
