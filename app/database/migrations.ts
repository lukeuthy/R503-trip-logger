import * as SQLite from 'expo-sqlite';

import { R503_STOPS } from '../data/r503_stops';
import { CREATE_SCHEMA_STATEMENTS } from './schema';

const SCHEMA_VERSION = 3;

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    await dropLegacyTables(db);
    for (const statement of CREATE_SCHEMA_STATEMENTS) {
      await db.execAsync(statement);
    }
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  await seedStops(db);
}

async function dropLegacyTables(db: SQLite.SQLiteDatabase): Promise<void> {
  const dropStatements = [
    'DROP TABLE IF EXISTS stop_event;',
    'DROP TABLE IF EXISTS gps_point;',
    'DROP TABLE IF EXISTS stop;',
    'DROP TABLE IF EXISTS trip;',
    'DROP TABLE IF EXISTS stop_events;',
    'DROP TABLE IF EXISTS gps_points;',
    'DROP TABLE IF EXISTS stops;',
    'DROP TABLE IF EXISTS trips;',
  ];

  for (const statement of dropStatements) {
    await db.execAsync(statement);
  }
}

async function seedStops(db: SQLite.SQLiteDatabase): Promise<void> {
  const countRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM stop;');
  const count = countRow?.count ?? 0;
  if (count > 0) {
    return;
  }

  for (const stop of R503_STOPS) {
    await db.runAsync(
      `INSERT INTO stop (stop_id, stop_name, lat, lon, stop_sequence, direction_code)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [stop.stop_id, stop.stop_name, stop.lat, stop.lon, stop.stop_sequence, stop.direction_code],
    );
  }
}
