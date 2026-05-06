# R503 Trip Logger — Project Context

> This file is the single source of truth for any coding agent working on this project.
> Read it fully before making any changes. Last updated: 2026-04-29 (v2 — updated with Apr 28 AM trip findings).

---

## Project summary

An Android mobile app (Expo React Native) that acts as a **data collection instrument** for a CS thesis on bus ETA prediction along the R503 route in Davao City, Philippines. The app rides the bus, logs GPS traces, detects stop arrivals/departures, and computes inter-stop segment travel times. The resulting SQLite-backed JSON bundles are the training dataset for three competing ETA models: XGBoost, linear regression, and a time-of-day segmented median baseline.

This is **not** a production product. It is a research tool. Data quality and completeness are more important than UX.

---

## Thesis context

| Item | Detail |
|---|---|
| Course | CS (undergraduate thesis) |
| Institution | Mapúa Malayan Colleges Mindanao |
| Route | R503 — Bangkal ↔ Roxas Avenue, Davao City |
| Device | Motorola moto g54 5G, Android 15 |
| Target dataset | ≥ 100 complete trips, ≥ 50 per time bucket (AM / PM) |
| Models | XGBoost (primary), Linear Regression (baseline), Time-of-day Segmented Median (naive baseline) |
| Objectives | O1: Collect & curate dataset → O2: Train models → O3: Compare models |
| Panel | Doc Patrick Cerna, Doc Rhodessa Cascaro, Prof Cherry Lisondra |

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Expo React Native (managed workflow) |
| Language | TypeScript |
| Local DB | `expo-sqlite` — NativeDatabase async API (`execAsync`, `getAllAsync`, `runAsync`) |
| GPS | `expo-location` — foreground + background location |
| Background service | Expo Task Manager (`TaskManager.defineTask`) + foreground service notification |
| State | Zustand |
| Navigation | Expo Router |
| Build | EAS Build (Android APK) |
| Experiment variants | `exp-high` (high sampling rate), `exp-medium` (medium sampling rate) |

---

## Route configuration

### Variants

| Variant ID | Direction | Start | End | Window |
|---|---|---|---|---|
| `r503_am` | A (outbound) | Hope Avenue Bangkal Station | Roxas/downtown terminus | AM |
| `r503_pm` | B (inbound) | Davao Light (C. Bangoy Street) Station | Bangkal | PM |

### Stop detection config (from `config` table)

```json
{
  "route_number": "R503",
  "enterDistanceM": 35,
  "exitDistanceM": 60,
  "dwellMs": 8000
}
```

- **Enter**: GPS point within 35 m of a stop → fire `arrive` event
- **Exit**: GPS point beyond 60 m of a stop after arriving → fire `exit` event
- **Dwell**: Stationary within stop radius for ≥ 8000 ms → fire `dwell` event

### Stop count

48 total stops in the `stops` table: 24 for `r503_am` (stop_ids 1–24), 24 for `r503_pm` (stop_ids 101–124).

---

## Database schema

The app uses a local SQLite database opened via `NativeDatabase`. All tables must be created at app startup via migration if they do not already exist.

### `trips`

```sql
CREATE TABLE IF NOT EXISTS trips (
  trip_id TEXT PRIMARY KEY,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  route_number TEXT,
  direction_code TEXT,       -- 'A' or 'B'
  window_code TEXT,          -- 'AM' or 'PM'
  status TEXT                -- 'active' | 'stopped' | 'complete'
);
```

### `gps_points`

```sql
CREATE TABLE IF NOT EXISTS gps_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT,
  timestamp_ms INTEGER,
  lat REAL,
  lon REAL,
  accuracy_m REAL,
  speed_mps REAL,            -- raw from GPS hardware (0 on cold start — known bug)
  heading_deg REAL,          -- raw from GPS hardware (0 on cold start — known bug)
  derived_speed_mps REAL,    -- computed from consecutive coordinates
  derived_heading_deg REAL,  -- computed from consecutive coordinates
  is_filtered INTEGER,       -- 0 or 1
  filter_reason TEXT,
  smoothed_lat REAL,         -- EMA-smoothed latitude
  smoothed_lon REAL,         -- EMA-smoothed longitude
  smoothed_speed_mps REAL    -- EMA-smoothed speed
);
```

### `stop_events`

```sql
CREATE TABLE IF NOT EXISTS stop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT,
  stop_id INTEGER,
  event_type TEXT,           -- 'arrive' | 'dwell' | 'exit'
  timestamp_ms INTEGER,
  dist_m REAL,               -- distance from stop centroid at event time
  lat REAL,
  lon REAL
);
```

### `segment_times`

```sql
CREATE TABLE IF NOT EXISTS segment_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT,
  from_stop_id INTEGER,
  to_stop_id INTEGER,
  depart_ms INTEGER,         -- timestamp of EXIT from from_stop
  arrive_ms INTEGER,         -- timestamp of ARRIVE at to_stop
  travel_time_s REAL,        -- (arrive_ms - depart_ms) / 1000
  distance_m REAL,           -- haversine of smoothed GPS trace between stops
  avg_speed_mps REAL
);
```

### `trip_sessions`

```sql
CREATE TABLE IF NOT EXISTS trip_sessions (
  trip_id TEXT PRIMARY KEY,
  device_id TEXT,
  variant_id TEXT,           -- 'r503_am' | 'r503_pm'
  started_at TEXT,           -- ISO 8601
  ended_at TEXT,
  timezone TEXT,
  app_version TEXT,
  time_bucket TEXT,          -- e.g. '07-08', '17-18'
  notes TEXT,
  experiment_variant TEXT,   -- 'high' | 'medium'
  task_restart_count INTEGER,-- how many times the bg task was killed and restarted
  battery_start_pct INTEGER,
  battery_end_pct INTEGER,
  battery_drain_pct REAL,    -- computed at session end
  route_variant_id TEXT,
  loop_stop_sequence_index INTEGER,
  leg_direction TEXT,
  round_trip_index INTEGER,
  complete INTEGER,          -- 0 = incomplete, 1 = complete
  observed_stop_count INTEGER,
  max_gap_sec REAL           -- longest GPS gap during trip, computed at session end
);
```

### `stops`

```sql
CREATE TABLE IF NOT EXISTS stops (
  stop_id INTEGER PRIMARY KEY,
  variant_id TEXT,
  external_stop_id TEXT,
  stop_name TEXT,
  lat REAL,
  lon REAL,
  stop_sequence INTEGER,
  loop_stop_sequence_index INTEGER
);
```

### `config`

```sql
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

---

## Data export format

Each trip is exported as a single JSON bundle with this top-level structure:

```json
{
  "trip": { /* trips row */ },
  "gps_points": [ /* array of gps_points rows */ ],
  "stop_events": [ /* array of stop_events rows */ ],
  "segment_times": [ /* array of segment_times rows */ ],
  "trip_sessions": [ /* array, should be exactly 1 */ ],
  "stops": [ /* full stops reference table, all 48 stops */ ],
  "config": { /* key-value config object */ }
}
```

Export filename convention: `r503_trip_{trip_id}.json`

**Critical**: The filename UUID must match the `trip_id` inside the file. A mismatch indicates an export bug.

---

## Known bugs (as of 2026-04-29)

These bugs have been identified through field data analysis. They may or may not be fully fixed in the codebase. Each fix must be verified.

### BUG-01 — Zero-value speed and heading on GPS cold start

**Symptom**: First GPS fix after a service restart has `speed_mps: 0` and `heading_deg: 0` even when the device is moving.

**Root cause**: Android GPS hardware reports 0 for speed and bearing on the very first location fix after a cold start. The `derived_speed_mps` and `derived_heading_deg` fields are also `null` because there is no previous point to diff against.

**Required fix**: On insert into `gps_points`, if `speed_mps === 0` and `heading_deg === 0` and this is the first point after a restart, mark `is_filtered = 1` with `filter_reason = 'cold_start_zero_values'`. Do not use these points for stop detection or segment time computation.

**Observed partial implementation (Apr 28 AM trip)**: A filter IS active in the codebase, and it is setting `is_filtered: 1` on some points — but the `filter_reason` written is `'invalid-timestamp-gap'`, not `'cold_start_zero_values'`. This means the filter is keyed on gap size (time since the previous GPS point), not on the zero-speed/zero-heading condition directly. Two failure modes result:

1. The very first GPS fix of a trip (id 159 in the Apr 28 data) has `speed: 0, heading: 0` and is NOT filtered, because there is no preceding point to produce a gap against.
2. A cold-start zero that occurs after a fast restart (short gap) will also not be filtered, since the gap threshold won't trigger.

The filter must check `speed_mps === 0 AND heading_deg === 0` as the primary condition, independently of gap size. Gap-based filtering is a separate, secondary concern.

**Verification signal**: Cold-start zero points must have `is_filtered: 1` with `filter_reason: 'cold_start_zero_values'`. They must never appear as `stop_events`. This must apply to the very first GPS fix of a trip, not only to mid-trip restart points.

---

### BUG-02 — Foreground service killed repeatedly (Doze / Adaptive Battery)

**Symptom**: `task_restart_count` reaching 31–35 in a single 3-hour trip. GPS point density collapses to 1 point per 40–170 minutes instead of 1 per 5–10 seconds. The Apr 28 AM trip produced a single 172-minute GPS blackout — 91% of the trip duration with no data.

**Trend**: The restart count is getting worse across trips (31 → 35), consistent with Android Adaptive Battery learning to suppress the app more aggressively the more it runs. This is expected behavior on Android 15 on mid-range devices like the Motorola moto g54 5G unless the app is explicitly battery-whitelisted.

**Root cause**: Android Doze mode and Adaptive Battery kill the foreground service task when the screen is off and the app is not whitelisted. On Android 14+, `FOREGROUND_SERVICE_LOCATION` type is required in the manifest or the foreground service is demoted silently. Additionally, on Android 15, the foreground service may survive technically (not killed by the OS) but location updates are silently throttled to zero — meaning `task_restart_count` may under-report actual GPS loss events.

**Required fix checklist**:
- [ ] `AndroidManifest.xml` declares `android:foregroundServiceType="location"` on the service
- [ ] App requests `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission and prompts user to whitelist
- [ ] `TaskManager.defineTask` callback re-acquires a wake lock on restart
- [ ] `task_restart_count` is incremented on every `TASK_STARTED` or task re-registration event
- [ ] GPS location subscription is re-established inside the task restart handler, not just on initial mount
- [ ] An `AppState` listener detects when the app returns to foreground after an extended background period and re-initializes the GPS subscription explicitly, even if the task technically never died

**Verification signal**: `task_restart_count` should be 0 or very low (≤ 2) for a complete trip with stable GPS. GPS points should appear at consistent intervals with no gap exceeding 60 seconds.

---

### BUG-03 — Empty `segment_times`

**Symptom**: `segment_times` array is always empty even when stop events are being recorded.

**Root cause**: Segment times are computed when an `exit` stop event fires for `stop_N` and an `arrive` fires for `stop_N+1`. If the service restarts between these events, the in-memory state tracking which stop was last exited is lost. Also, if `exit` events are never fired (because the service dies before the exit geofence triggers), there are no pairs to compute from.

**Required fix**: Persist the "last exited stop" state to the SQLite DB (or AsyncStorage) so it survives service restarts. The segment time computation should read `stop_events` from the DB at restart to reconstruct state, not rely on in-memory variables.

**Verification signal**: Every consecutive `(exit from stop N) → (arrive at stop N+1)` pair in `stop_events` must produce exactly one row in `segment_times`.

---

### BUG-04 — Duplicate or missing EXIT events

**Symptom**: Multiple `exit` events for the same stop in one trip, or `arrive` with no matching `exit`.

**Root cause**: The stop-detection state machine does not guard against re-entry. If GPS points oscillate around the exit radius (60 m) due to accuracy drift, multiple exit events are fired.

**Required fix**: The state machine must use a debounce — an `exit` event for stop N should only be written if the current state for stop N is `ARRIVED` or `DWELLING`. After firing `exit`, state transitions to `EXITED` and further exit events for that stop are suppressed.

**Verification signal**: For any given `trip_id` + `stop_id` combination, `stop_events` should contain at most one `arrive`, one `dwell`, and one `exit`.

---

### BUG-05 — `no such table: gps_points` on NativeDatabase.execAsync

**Symptom**: App crashes on evening trip start with:
```
last error: call to function 'NativeDatabase.execAsync' has been rejected,
caused by: no such table: gps_points
```

**Root cause (candidates, in order of likelihood)**:

1. **Migration did not run**: The `CREATE TABLE IF NOT EXISTS gps_points` statement is inside a migration function that is either (a) only called conditionally on first install, (b) behind a version check that evaluated to false, or (c) called asynchronously but the DB was written to before the migration `await` resolved.

2. **DB opened on wrong path**: If the database filename is constructed dynamically (e.g., per-trip or per-date), a new filename opens a fresh empty DB with no schema.

3. **DB deleted between sessions**: If the app (or a previous bug fix) clears the DB file on crash recovery, the next session starts with an empty DB.

4. **Race condition on startup**: The GPS task starts and tries to insert into `gps_points` before the main app thread finishes running migrations. With `NativeDatabase` async API, migration must be fully `await`ed before any table operations are permitted.

**Required fix**: Migration must be idempotent (`CREATE TABLE IF NOT EXISTS` for all tables), called once at app startup from a single async init function, and `await`ed to completion before any other DB operation is allowed to run. The GPS task must not attempt any DB write until it receives a signal (e.g., a flag in AsyncStorage or a message from the main thread) that migration is complete.

**Verification signal**: App starts clean on a fresh install and on every subsequent launch without the "no such table" error.

---

### BUG-06 — Null `max_gap_sec` and `battery_drain_pct` in `trip_sessions`

**Symptom**: These fields are `null` even after a trip ends.

**Root cause**: Finalization logic that computes these values is either not called when `status` is set to `stopped` (as opposed to `complete`), or the computation query runs before `gps_points` are fully flushed.

**Required fix**: Session finalization must run for both `stopped` and `complete` trips. `max_gap_sec` = max gap between consecutive `timestamp_ms` values in `gps_points` for this trip. `battery_drain_pct` = `battery_start_pct - battery_end_pct`.

---

### BUG-07 — Mismatched export filename vs. internal trip_id

**Symptom**: Export file is named `r503_trip_{UUID-A}.json` but the `trip_id` inside is `{UUID-B}`.

**Root cause**: The export function likely reads the filename from one source (e.g., a trip object in React state) while the actual DB rows were written with a different trip_id (e.g., regenerated on service restart).

**Required fix**: The export function must derive the filename directly from `SELECT trip_id FROM trips WHERE ...` — not from any in-memory state that could have drifted.

---

## Architecture notes for the agent

- The app uses `expo-sqlite`'s new **NativeDatabase** API (`openDatabaseAsync` / `openDatabaseSync`). This is different from the older `SQLite.openDatabase` API. The async methods (`execAsync`, `getAllAsync`, `runAsync`) return promises. Forgetting `await` is a common source of race condition bugs here.
- The foreground GPS collection runs inside an **Expo TaskManager task**, not on the React component tree. It has its own execution context. State shared between the task and the UI must go through the DB or AsyncStorage — not through Zustand or React state directly.
- Stop detection is implemented as a **state machine** per stop. The machine must be reconstructed from DB on every task restart (see BUG-03).
- The EMA smoother for GPS coordinates uses a fixed alpha. If the smoother's previous state is lost on restart, it will diverge for the first few points after re-acquisition. This was confirmed in the Apr 28 AM trip: after a 172-minute blackout, `smoothed_lat` and `smoothed_lon` remained stuck at the start-of-trip values even though the raw GPS coordinate had moved ~1.8 km away. The EMA state must be either (a) reset to the new raw coordinate on restart, or (b) persisted to DB and restored. Option (a) is simpler and sufficient.

---

## Field data summary (collected so far)

| Date | Trip ID | Variant | Status | GPS Points | Segment Times | Notes |
|---|---|---|---|---|---|---|
| 2026-04-27 | 73bdf6d7 | r503_pm | stopped | 4 | 0 | task_restart_count: 31. Only 1 stop observed. Unusable. |
| 2026-04-27 | 350c8ec6* | — | — | — | — | Duplicate export of 73bdf6d7. Filename mismatch bug. No morning trip. |
| 2026-04-28 | e90f5a1f | r503_am | stopped | 7 | 0 | task_restart_count: 35 (worse). 172-min blackout. 1 stop observed. Filename match fixed. Filter partial (gap-based, not zero-based). Unusable. |
| 2026-04-28 | — | r503_pm | failed | 0 | 0 | App crashed on trip start: "no such table: gps_points". |

*350c8ec6 filename does not match any internal trip_id — export naming bug (confirmed fixed in e90f5a1f export).

---

## What a usable trip looks like

A trip is considered **usable for training** when all of the following are true:

- `complete: 1` in `trip_sessions`
- `task_restart_count` ≤ 2
- `gps_points` count ≥ 500 (for a full one-way trip at 10 s interval ≈ 600–900 points)
- `segment_times` count = (observed_stop_count − 1) — every consecutive stop pair has a segment time
- No `stop_events` row has `speed_mps: 0` and `heading_deg: 0` (cold-start zeros filtered out)
- `max_gap_sec` ≤ 60 (no GPS blackouts longer than 1 minute)
- Export filename UUID matches internal `trip_id`

---

## Data target for Objective 1

- **100 complete, usable trips minimum**
- **≥ 50 AM trips** (`r503_am`, time buckets 06-07, 07-08, 08-09)
- **≥ 50 PM trips** (`r503_pm`, time buckets 16-17, 17-18, 18-19)
- Collection window: ~2 more weeks from 2026-04-29

This target is achievable (≈ 7 trips/day × 14 days = 98) **only if** BUG-02 and BUG-05 are fully resolved before collection resumes.
