import * as SQLite from 'expo-sqlite';

import { R503_STOPS } from '../data/r503_stops';
import { CREATE_SCHEMA_STATEMENTS, CREATE_V1_TABLE_STATEMENTS } from './schema';

const LEGACY_SCHEMA_VERSION = 3;
const V1_SCHEMA_VERSION = 6;

const DEFAULT_ROUTE_ID = 'route_r503';
const DEFAULT_RADIUS_M = 40;

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');

  for (const statement of CREATE_SCHEMA_STATEMENTS) {
    await db.execAsync(statement);
  }

  for (const statement of CREATE_V1_TABLE_STATEMENTS) {
    await db.execAsync(statement);
  }

  await migrateGpsPointsTableIfNeeded(db);
  await migrateStopEventsTableIfNeeded(db);
  await ensureLegacyColumns(db);
  await seedLegacyStops(db);
  await seedV1ReferenceData(db);
  await updateSchemaMeta(db);
}

async function migrateGpsPointsTableIfNeeded(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gps_points';",
  );
  const sql = row?.sql ?? '';
  if (sql.includes('id INTEGER PRIMARY KEY AUTOINCREMENT')) {
    return;
  }

  await ensureColumn(db, 'gps_points', 'timestamp_ms', 'ALTER TABLE gps_points ADD COLUMN timestamp_ms INTEGER;');
  await ensureColumn(db, 'gps_points', 'lon', 'ALTER TABLE gps_points ADD COLUMN lon REAL;');
  await ensureColumn(db, 'gps_points', 'heading_deg', 'ALTER TABLE gps_points ADD COLUMN heading_deg REAL;');
  await ensureColumn(db, 'gps_points', 'smoothed_lon', 'ALTER TABLE gps_points ADD COLUMN smoothed_lon REAL;');
  await db.execAsync('ALTER TABLE gps_points RENAME TO gps_points_legacy_shape;');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS gps_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id TEXT UNIQUE,
    trip_id TEXT NOT NULL,
    ts TEXT,
    timestamp_ms INTEGER,
    lat REAL NOT NULL,
    lng REAL,
    lon REAL,
    accuracy_m REAL,
    altitude_m REAL,
    speed_mps REAL,
    bearing_deg REAL,
    heading_deg REAL,
    derived_speed_mps REAL,
    derived_heading_deg REAL,
    provider_speed_mps REAL,
    provider_heading_deg REAL,
    is_filtered INTEGER NOT NULL DEFAULT 0,
    filter_reason TEXT,
    smoothed_lat REAL,
    smoothed_lng REAL,
    smoothed_lon REAL,
    smoothed_speed_mps REAL,
    FOREIGN KEY(trip_id) REFERENCES trip_sessions(trip_id)
  );`);
  await db.execAsync(`INSERT INTO gps_points (
      point_id, trip_id, ts, timestamp_ms, lat, lng, lon, accuracy_m, altitude_m, speed_mps,
      bearing_deg, heading_deg, derived_speed_mps, derived_heading_deg, provider_speed_mps,
      provider_heading_deg, is_filtered, filter_reason, smoothed_lat, smoothed_lng, smoothed_lon, smoothed_speed_mps
    )
    SELECT
      point_id,
      trip_id,
      ts,
      COALESCE(timestamp_ms, CAST(strftime('%s', ts) AS INTEGER) * 1000),
      lat,
      lng,
      COALESCE(lon, lng),
      accuracy_m,
      altitude_m,
      speed_mps,
      bearing_deg,
      COALESCE(heading_deg, bearing_deg),
      derived_speed_mps,
      derived_heading_deg,
      provider_speed_mps,
      provider_heading_deg,
      is_filtered,
      filter_reason,
      smoothed_lat,
      smoothed_lng,
      COALESCE(smoothed_lon, smoothed_lng),
      smoothed_speed_mps
    FROM gps_points_legacy_shape;`);
  await db.execAsync('DROP TABLE gps_points_legacy_shape;');
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
  await ensureColumn(db, 'gps_points', 'id', 'ALTER TABLE gps_points ADD COLUMN id INTEGER;');
  await ensureColumn(db, 'gps_points', 'timestamp_ms', 'ALTER TABLE gps_points ADD COLUMN timestamp_ms INTEGER;');
  await ensureColumn(db, 'gps_points', 'lon', 'ALTER TABLE gps_points ADD COLUMN lon REAL;');
  await ensureColumn(db, 'gps_points', 'heading_deg', 'ALTER TABLE gps_points ADD COLUMN heading_deg REAL;');
  await ensureColumn(db, 'gps_points', 'smoothed_lon', 'ALTER TABLE gps_points ADD COLUMN smoothed_lon REAL;');
  await ensureColumn(db, 'stop_events', 'id', 'ALTER TABLE stop_events ADD COLUMN id INTEGER;');
  await ensureColumn(db, 'stop_events', 'timestamp_ms', 'ALTER TABLE stop_events ADD COLUMN timestamp_ms INTEGER;');
  await ensureColumn(db, 'stop_events', 'dist_m', 'ALTER TABLE stop_events ADD COLUMN dist_m REAL;');
  await ensureColumn(db, 'stop_events', 'lat', 'ALTER TABLE stop_events ADD COLUMN lat REAL;');
  await ensureColumn(db, 'stop_events', 'lon', 'ALTER TABLE stop_events ADD COLUMN lon REAL;');
  await ensureColumn(db, 'trip_sessions', 'experiment_variant', 'ALTER TABLE trip_sessions ADD COLUMN experiment_variant TEXT;');
  await ensureColumn(db, 'trip_sessions', 'task_restart_count', 'ALTER TABLE trip_sessions ADD COLUMN task_restart_count INTEGER;');
  await ensureColumn(db, 'trip_sessions', 'battery_start_pct', 'ALTER TABLE trip_sessions ADD COLUMN battery_start_pct INTEGER;');
  await ensureColumn(db, 'trip_sessions', 'battery_end_pct', 'ALTER TABLE trip_sessions ADD COLUMN battery_end_pct INTEGER;');
  await ensureColumn(db, 'trip_sessions', 'battery_drain_pct', 'ALTER TABLE trip_sessions ADD COLUMN battery_drain_pct INTEGER;');
  await ensureColumn(db, 'trip_sessions', 'max_gap_sec', 'ALTER TABLE trip_sessions ADD COLUMN max_gap_sec REAL;');
  await ensureColumn(db, 'segment_times', 'quality_flag', 'ALTER TABLE segment_times ADD COLUMN quality_flag TEXT;');
  await ensureColumn(db, 'segment_times', 'point_count', 'ALTER TABLE segment_times ADD COLUMN point_count INTEGER;');
  await ensureColumn(db, 'segment_times', 'max_gap_sec', 'ALTER TABLE segment_times ADD COLUMN max_gap_sec REAL;');
  await ensureColumn(db, 'segment_times', 'p95_accuracy_m', 'ALTER TABLE segment_times ADD COLUMN p95_accuracy_m REAL;');
  await ensureColumn(db, 'segment_times', 'min_accuracy_m', 'ALTER TABLE segment_times ADD COLUMN min_accuracy_m REAL;');
  await ensureColumn(db, 'segment_times', 'depart_ms', 'ALTER TABLE segment_times ADD COLUMN depart_ms INTEGER;');
  await ensureColumn(db, 'segment_times', 'arrive_ms', 'ALTER TABLE segment_times ADD COLUMN arrive_ms INTEGER;');
  await ensureColumn(db, 'segment_times', 'travel_time_s', 'ALTER TABLE segment_times ADD COLUMN travel_time_s REAL;');
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_gps_points_trip_timestamp_ms ON gps_points(trip_id, timestamp_ms);');
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_stop_events_trip_timestamp_ms ON stop_events(trip_id, timestamp_ms);');
}

async function migrateStopEventsTableIfNeeded(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stop_events';",
  );
  const sql = row?.sql ?? '';
  if (!sql.includes('CHECK(event_type IN')) {
    return;
  }

  await db.execAsync('ALTER TABLE stop_events RENAME TO stop_events_legacy_check;');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS stop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    trip_id TEXT NOT NULL,
    stop_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp_ms INTEGER,
    ts TEXT,
    dist_m REAL,
    dist_to_stop_m REAL,
    lat REAL,
    lon REAL,
    speed_mps REAL,
    accuracy_m REAL,
    FOREIGN KEY(trip_id) REFERENCES trip_sessions(trip_id),
    FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
  );`);
  await db.execAsync(`INSERT INTO stop_events (
      event_id, trip_id, stop_id, event_type, timestamp_ms, ts, dist_m, dist_to_stop_m, speed_mps, accuracy_m
    )
    SELECT event_id, trip_id, stop_id, event_type, CAST(strftime('%s', ts) AS INTEGER) * 1000, ts, dist_to_stop_m, dist_to_stop_m, speed_mps, accuracy_m
    FROM stop_events_legacy_check;`);
  await db.execAsync('DROP TABLE stop_events_legacy_check;');
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  alterStatement: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (columns.length === 0) {
    return;
  }
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
