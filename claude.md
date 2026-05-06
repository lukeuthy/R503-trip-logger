# CLAUDE.md — R503 Trip Logger

## Project Summary

Offline-first Expo React Native app (SDK 51, Android API 34) for bus trip data
collection on route R503, Davao City. Collects GPS traces, detects stops via
geofence model, derives segment travel times, exports to SQLite → CSV/JSON ZIP.
No network connectivity used during collection. All sensing runs on-device.

Repository: https://github.com/lukeuthy/R503-trip-logger
Active branch: exp/variants

---

## Build Variants

One codebase, four APK profiles via EAS Build. Differentiated by a single
environment variable EXPERIMENT_VARIANT at build time:

| Profile     | EXPERIMENT_VARIANT | GPS interval | Write buffer     | Foreground svc |
|-------------|-------------------|--------------|------------------|----------------|
| exp-high    | exp-high          | 2 s          | Immediate        | Yes            |
| exp-medium  | exp-medium        | 5 s          | 10 pts / 30 s    | Yes            |
| exp-low     | exp-low           | 10 s         | 20 pts / 60 s    | Yes            |
| exp-bg-degraded | exp-bg-degraded | 5 s       | Immediate        | No             |

Build command: `eas build -p android --profile <profile-name>`
Local build: `npx expo prebuild --clean` then `cd android && gradlew.bat assembleRelease`

---

## Architecture

```
app/
  (tabs)/
    trip.tsx          ← Trip screen UI (Start/Stop buttons, status display)
    export.tsx        ← Export screen
    dashboard.tsx     ← Dashboard
  _layout.tsx

src/
  tasks/
    backgroundLocationTask.ts   ← MOST IMPORTANT: TaskManager.defineTask,
                                   GPS callback, inserts to gps_points,
                                   increments task_restart_count
  controllers/
    TripController.ts           ← startTrip(), stopTrip(), battery readings,
                                   wake lock (TO BE ADDED), trip session CRUD
  services/
    database.ts (or db.ts)      ← SQLite open + schema init (CREATE TABLE IF NOT EXISTS)
                                   THIS MUST RUN BEFORE ANY OTHER DB OPERATION
    locationService.ts          ← FLPC configuration, expo-location setup
    exportService.ts            ← ZIP export pipeline, battery_drain_pct serialization
  models/
    Trip.ts                     ← DirectionCode, trip types
  config/
    sensingConfig.ts            ← SENSING_CONFIG object, reads EXPERIMENT_VARIANT,
                                   useForegroundService boolean lives here
  stops/
    r503Stops.ts                ← R503_STOPS array, 14 stops direction A
  detection/
    stopDetector.ts             ← Geofence logic, arrive/depart events
    segmentBuilder.ts           ← Segment commit logic (non-consecutive fix needed)
```

Actual file names may differ slightly — search for these patterns if not found:
- `TaskManager.defineTask` → background task file
- `openDatabaseSync` or `SQLiteDatabase` → database service file
- `startForeground` or `expo-keep-awake` → TripController or similar
- `battery_drain_pct` → exportService or TripController

---

## Known Bugs (current as of last session)

### BUG 1 — ACTIVE: no such table: gps_points on Start Trip
**Symptom:** Last Error field shows "Call to function 'NativeDatabase.execAsync'
has been rejected → Caused by: no such table: gps_points" immediately on Start Trip.
Persists after clearing app data.

**Root cause (one of these):**
- Schema init function is called but not awaited before the background task fires
- Background task opens its own DB connection without running schema init
- Schema init function does not include the gps_points table

**Fix:** Find the schema init function (CREATE TABLE IF NOT EXISTS calls). Ensure:
1. It is awaited before startTrip() is callable
2. The background task file (backgroundLocationTask.ts) opens its own DB
   connection AND calls the schema init function at the top of the task callback
3. The UI Start Trip button is disabled until schema init resolves (use a dbReady
   state flag)

Add this diagnostic to confirm tables exist after init:
```typescript
const tables = db.getAllSync<{name: string}>(
  `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
);
console.log('[DB] Tables after init:', tables.map(t => t.name));
// Must include: gps_points, trip_sessions, stop_events, segment_times, task_events
```

### BUG 2 — battery_drain_pct is null in export
At trip end, battery_drain_pct is computed but not written (serialization bug).
Fix: compute as Math.max(0, battery_start_pct - battery_end_pct) and write
explicitly in the UPDATE trip_sessions query.

### BUG 3 — Segment builder stalls on skip-stop
Original builder required arrive(N+1) after depart(N). When bus skips a stop,
builder waits forever and all subsequent segments are lost silently.
Fix: commit segment on any arrive(M) where seq(M) > seq(lastDepart). Already
documented in CODEX_PROMPT_all_fixes.md.

### BUG 4 — PARTIAL_WAKE_LOCK not deployed (primary research fix)
Field data shows 36–46 task restarts per trip despite foreground service.
Cause: CPU sleeps between GPS callbacks after ~15 min; OS kills task.
Fix: `activateKeepAwakeAsync('r503-active-trip')` in startTrip(), gated behind
SENSING_CONFIG.useForegroundService so bg-degraded variant stays unprotected.
See CODEX_PROMPT_wakelock_fix.md for full implementation.

---

## Database Schema

```sql
gps_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  accuracy_m REAL,
  speed_mps REAL,
  heading_deg REAL,
  is_filtered INTEGER DEFAULT 0,
  filter_reason TEXT,
  smoothed_lat REAL,
  smoothed_lon REAL,
  smoothed_speed_mps REAL,
  derived_speed_mps REAL,
  derived_heading_deg REAL
)

trip_sessions (
  trip_id TEXT PRIMARY KEY,
  device_id TEXT,
  variant_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  timezone TEXT,
  app_version TEXT,
  time_bucket TEXT,
  notes TEXT,
  experiment_variant TEXT,
  battery_start_pct INTEGER,
  battery_end_pct INTEGER,
  battery_drain_pct INTEGER,
  task_restart_count INTEGER DEFAULT 0
)

stop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  stop_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- 'arrive' | 'dwell' | 'depart'
  timestamp_ms INTEGER NOT NULL,
  dist_m REAL,
  lat REAL,
  lon REAL
)

segment_times (
  segment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  from_stop_id INTEGER NOT NULL,
  to_stop_id INTEGER NOT NULL,
  start_ts INTEGER,
  end_ts INTEGER,
  travel_time_sec REAL,
  distance_m REAL,
  avg_speed_mps REAL,
  p95_speed_mps REAL,
  mean_accuracy_m REAL,
  quality_flag TEXT,
  point_count INTEGER,
  max_gap_sec REAL,
  p95_accuracy_m REAL,
  min_accuracy_m REAL
)

task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT,
  event_type TEXT,
  timestamp_ms INTEGER
)
```

All five tables must be created by the schema init function before any trip starts.

---

## Route R503 Reference

14 stops, Direction A (Hope Avenue Bangkal → Davao Light):

| stop_id | stop_name                          | lat              | lon              |
|---------|------------------------------------|------------------|------------------|
| 1       | Hope Avenue Bangkal Station        | 7.060941181744724 | 125.55389545175399 |
| 2       | Ateneo Senior High Station         | 7.060700779168272 | 125.5567978228379 |
| 3       | SPED Bangkal Station               | 7.061255258672034 | 125.55956428731429 |
| 4       | Tahimik Avenue Matina Station      | 7.060840717374191 | 125.56367702832335 |
| 5       | Matina Crossing Station            | 7.058172424027731 | 125.56975900724251 |
| 6       | Kawayan Drive Station              | 7.055763967087287 | 125.57540976367454 |
| 7       | DGT Station                        | 7.058288463021384 | 125.58031629926563 |
| 8       | Water District Matina Station      | 7.060972585362123 | 125.59005429145282 |
| 9       | NCCC Maa Station                   | 7.06192856978879  | 125.59391312759931 |
| 10      | Ateneo Matina Station              | 7.062850789005836 | 125.59773797305172 |
| 11      | Pichon St corner Quirino Ave       | 7.067860141373998 | 125.60311746328352 |
| 12      | Grand Menseng Hotel Station        | 7.0645041532673645 | 125.60685088783407 |
| 13      | CM Recto Avenue Station            | 7.0665252644676   | 125.61056370265396 |
| 14      | Davao Light (C. Bangoy Street)     | 7.072765836687623 | 125.61067755688578 |

Stop detection config: enterDistanceM=35, exitDistanceM=60, dwellMs=10000

---

## Priority Fix Order

Fix these in order — each one unblocks the next:

1. **gps_points table missing** (blocks everything — fix this first)
2. **PARTIAL_WAKE_LOCK** (primary research contribution — fix after DB works)
3. **battery_drain_pct null** (two lines — fix while in TripController anyway)
4. **Segment builder skip-stop** (fix before next data collection trip)

---

## Testing Notes

- Use Lockito (Android mock GPS app) for GPS simulation without riding the bus
- GPX simulation files are in the Artifact folder:
  - r503_sim_all_stops.gpx — all 14 stops, baseline test
  - r503_sim_skip_stops.gpx — skips stops 4,7,9,13 (mirrors real trip)
  - r503_sim_skip_4_only.gpx — skips stop 4 only, quickest test
- Enable mock location: Android Developer Options → Select mock location app → Lockito
- After ANY fix: run `npx tsc --noEmit` — zero TypeScript errors required

## Verification for wake lock fix specifically

After deploying fix 2 (wake lock):
1. Start trip
2. Check console: `[WAKELOCK] Acquired` must appear
3. Keep screen off for 20+ minutes
4. Stop trip, export JSON
5. PASS: task_restart_count = 0 or ≤ 2
6. PASS: no GPS gaps > 30s in gps_points
7. PASS: battery_drain_pct is an integer, not null