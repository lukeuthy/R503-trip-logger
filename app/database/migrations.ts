import * as SQLite from 'expo-sqlite';

import { R503_STOPS } from '../data/r503_stops';
import { CREATE_SCHEMA_STATEMENTS, CREATE_V1_TABLE_STATEMENTS } from './schema';

const LEGACY_SCHEMA_VERSION = 3;
const V1_SCHEMA_VERSION = 4;

const DEFAULT_ROUTE_ID = 'route_r503';
const DEFAULT_RADIUS_M = 40;

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');

  for (const statement of CREATE_SCHEMA_STATEMENTS) {
    await db.execAsync(statement);
  }

  await ensureLegacyColumns(db);

  for (const statement of CREATE_V1_TABLE_STATEMENTS) {
    await db.execAsync(statement);
  }

  await seedLegacyStops(db);
  await seedV1ReferenceData(db);
  await updateSchemaMeta(db);
}

async function ensureLegacyColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  await ensureColumn(
    db,
    'gps_point',
    'is_filtered',
    'ALTER TABLE gps_point ADD COLUMN is_filtered INTEGER NOT NULL DEFAULT 0;',
  );
  await ensureColumn(db, 'gps_point', 'filter_reason', 'ALTER TABLE gps_point ADD COLUMN filter_reason TEXT;');
  await ensureColumn(db, 'gps_point', 'smoothed_lat', 'ALTER TABLE gps_point ADD COLUMN smoothed_lat REAL;');
  await ensureColumn(db, 'gps_point', 'smoothed_lon', 'ALTER TABLE gps_point ADD COLUMN smoothed_lon REAL;');
  await ensureColumn(db, 'gps_point', 'smoothed_speed_mps', 'ALTER TABLE gps_point ADD COLUMN smoothed_speed_mps REAL;');
  await ensureColumn(db, 'gps_point', 'derived_speed_mps', 'ALTER TABLE gps_point ADD COLUMN derived_speed_mps REAL;');
  await ensureColumn(db, 'gps_point', 'derived_heading_deg', 'ALTER TABLE gps_point ADD COLUMN derived_heading_deg REAL;');
  await ensureColumn(db, 'gps_points', 'derived_speed_mps', 'ALTER TABLE gps_points ADD COLUMN derived_speed_mps REAL;');
  await ensureColumn(db, 'gps_points', 'derived_heading_deg', 'ALTER TABLE gps_points ADD COLUMN derived_heading_deg REAL;');
  await ensureColumn(db, 'gps_points', 'provider_speed_mps', 'ALTER TABLE gps_points ADD COLUMN provider_speed_mps REAL;');
  await ensureColumn(db, 'gps_points', 'provider_heading_deg', 'ALTER TABLE gps_points ADD COLUMN provider_heading_deg REAL;');
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  alterStatement: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (columns.some((row) => row.name === column)) {
    return;
  }
  await db.execAsync(alterStatement);
}

async function seedLegacyStops(db: SQLite.SQLiteDatabase): Promise<void> {
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

async function seedV1ReferenceData(db: SQLite.SQLiteDatabase): Promise<void> {
  const routeExists = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM routes WHERE route_id = ?;',
    [DEFAULT_ROUTE_ID],
  );
  if ((routeExists?.count ?? 0) === 0) {
    await db.runAsync('INSERT INTO routes (route_id, route_number, name) VALUES (?, ?, ?);', [
      DEFAULT_ROUTE_ID,
      'R503',
      'R503 Route',
    ]);
  }

  await ensureRouteVariant(db, {
    variantId: 'r503_am',
    direction: 'A',
    timePeriod: 'AM',
    startTime: '06:00',
    endTime: '10:00',
  });
  await ensureRouteVariant(db, {
    variantId: 'r503_pm',
    direction: 'B',
    timePeriod: 'PM',
    startTime: '16:00',
    endTime: '20:00',
  });
  await ensureRouteVariant(db, {
    variantId: 'r503_off',
    direction: 'A',
    timePeriod: 'OFF',
    startTime: '00:00',
    endTime: '23:59',
  });

  for (const stop of R503_STOPS) {
    const variantId = stop.direction_code === 'A' ? 'r503_am' : 'r503_pm';
    const stopId = `r503_${variantId}_s${String(stop.stop_sequence).padStart(2, '0')}`;
    const existing = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM stops WHERE stop_id = ?;', [
      stopId,
    ]);
    if ((existing?.count ?? 0) > 0) {
      continue;
    }

    await db.runAsync(
      `INSERT INTO stops (stop_id, variant_id, stop_order, name, lat, lng, radius_m)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [stopId, variantId, stop.stop_sequence, stop.stop_name, stop.lat, stop.lon, DEFAULT_RADIUS_M],
    );
  }
}

async function ensureRouteVariant(
  db: SQLite.SQLiteDatabase,
  input: {
    variantId: string;
    direction: string;
    timePeriod: string;
    startTime: string;
    endTime: string;
  },
): Promise<void> {
  const exists = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM route_variants WHERE variant_id = ?;',
    [input.variantId],
  );
  if ((exists?.count ?? 0) > 0) {
    return;
  }
  await db.runAsync(
    `INSERT INTO route_variants (variant_id, route_id, direction, time_period, start_time, end_time)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [input.variantId, DEFAULT_ROUTE_ID, input.direction, input.timePeriod, input.startTime, input.endTime],
  );
}

async function updateSchemaMeta(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM schema_meta;');
  await db.runAsync('INSERT INTO schema_meta (schema_version, installed_at) VALUES (?, ?);', [
    V1_SCHEMA_VERSION,
    new Date().toISOString(),
  ]);

  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const currentVersion = versionRow?.user_version ?? 0;
  const nextVersion = Math.max(currentVersion, LEGACY_SCHEMA_VERSION, V1_SCHEMA_VERSION);
  await db.execAsync(`PRAGMA user_version = ${nextVersion};`);
}
