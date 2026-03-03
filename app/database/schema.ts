export const CREATE_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS trip (
    trip_id TEXT PRIMARY KEY,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    route_number TEXT NOT NULL,
    direction_code TEXT NOT NULL,
    window_code TEXT NOT NULL,
    status TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS gps_point (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy_m REAL,
    speed_mps REAL,
    heading_deg REAL,
    FOREIGN KEY(trip_id) REFERENCES trip(trip_id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_gps_point_trip_ts ON gps_point(trip_id, timestamp_ms);`,
  `CREATE TABLE IF NOT EXISTS stop (
    stop_id INTEGER PRIMARY KEY,
    stop_name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    stop_sequence INTEGER NOT NULL,
    direction_code TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS stop_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id TEXT NOT NULL,
    stop_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    dist_m REAL NOT NULL,
    lat REAL,
    lon REAL,
    FOREIGN KEY(trip_id) REFERENCES trip(trip_id) ON DELETE CASCADE,
    FOREIGN KEY(stop_id) REFERENCES stop(stop_id)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_stop_event_trip_ts ON stop_event(trip_id, timestamp_ms);`,
];
