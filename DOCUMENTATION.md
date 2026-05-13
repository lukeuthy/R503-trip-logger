# R503 Trip Logger — In-Depth Codebase Documentation

> Comprehensive reference for the R503 trip-logger Android app. Written for
> a developer or reviewer who has never opened this repository before.
> Covers every file, every algorithm, every state field, every SQL query,
> and the operating-system constraints that shape the design.

**Document version:** 2026-05-13
**App version:** 1.8.0 (Expo SDK 55)
**Target device family:** Android only (Android 12 / API 31+ assumed)
**Tested on:** Motorola Moto G54 5G (MyUX, near-stock Android)

---

## Table of contents

1. [Project goal and constraints](#1-project-goal-and-constraints)
2. [Stack and dependencies](#2-stack-and-dependencies)
3. [Build variants](#3-build-variants)
4. [Directory tree](#4-directory-tree)
5. [Architecture at a glance](#5-architecture-at-a-glance)
6. [Per-file deep dive](#6-per-file-deep-dive)
    - [6.1 Entry points and root files](#61-entry-points-and-root-files)
    - [6.2 The `trip/` folder (the hot path)](#62-the-trip-folder-the-hot-path)
    - [6.3 The `database/` folder](#63-the-database-folder)
    - [6.4 The `src/db/` folder](#64-the-srcdb-folder)
    - [6.5 The `src/screens/` folder](#65-the-srcscreens-folder)
    - [6.6 The `src/services/` folder](#66-the-srcservices-folder)
    - [6.7 The `src/utils/` folder](#67-the-srcutils-folder)
    - [6.8 The `src/components/` folder](#68-the-srccomponents-folder)
    - [6.9 The `models/`, `data/`, and `utils/` folders](#69-the-models-data-and-utils-folders)
    - [6.10 The `android/` native module](#610-the-android-native-module)
7. [Database schema reference](#7-database-schema-reference)
8. [Algorithm walkthroughs](#8-algorithm-walkthroughs)
    - [8.1 GPS filter pipeline](#81-gps-filter-pipeline)
    - [8.2 Stop detection state machine](#82-stop-detection-state-machine)
    - [8.3 Skip-stop handling](#83-skip-stop-handling)
    - [8.4 Segment builder](#84-segment-builder)
    - [8.5 Write buffer](#85-write-buffer)
    - [8.6 Dangling trip recovery](#86-dangling-trip-recovery)
    - [8.7 Watchdog hierarchy](#87-watchdog-hierarchy)
9. [State management reference (`UITripState`)](#9-state-management-reference-uitripstate)
10. [Lifecycle scenarios](#10-lifecycle-scenarios)
11. [Operating-system constraints (the hard truths)](#11-operating-system-constraints-the-hard-truths)
12. [Moto G54 5G specific troubleshooting](#12-moto-g54-5g-specific-troubleshooting)
13. [Build and deploy workflow](#13-build-and-deploy-workflow)
14. [Export bundle contents](#14-export-bundle-contents)
15. [Glossary](#15-glossary)
16. [Appendix A — Full SQL query catalog](#appendix-a--full-sql-query-catalog)

---

## 1. Project goal and constraints

**Goal:** continuously collect GPS traces of bus trips on the R503 route in
Davao City, derive stop arrival / dwell / departure events at each of 14
fixed stops, compute stop-to-stop segment travel times, and export everything
as a CSV+JSON ZIP for offline analysis. Trips can run **one+ hour** with the
screen off and the phone in a pocket.

**Hard constraints:**

- **Strictly offline at collection time.** No network calls during a trip.
  All persistence is local SQLite.
- **Android only.** The codebase has iOS shims but is not maintained or
  tested on iOS.
- **Single operator device.** No authentication, no multi-tenancy.
- **Battery- and reliability-sensitive.** Must survive Doze, App Standby,
  vendor battery managers, and process kills.
- **Reproducibility.** Trips are scientific samples — every filtered point,
  every retry, every restart must be auditable in `r503_tracking_audit.log`.

---

## 2. Stack and dependencies

From [package.json](app/package.json):

| Package | Version | Why |
|---|---|---|
| `expo` | `~55.0.4` | SDK base |
| `expo-location` | `~55.0.4` | GPS via Fused Location Provider + foreground service |
| `expo-task-manager` | `~55.0.4` | `defineTask` for the GPS callback |
| `expo-background-fetch` | `~55.0.4` | Out-of-process watchdog (~15min cadence) |
| `expo-keep-awake` | `~55.0.7` | `PARTIAL_WAKE_LOCK` to keep CPU alive |
| `expo-sqlite` | `~55.0.4` | Local DB |
| `expo-battery` | `~55.0.8` | Battery level snapshots |
| `expo-notifications` | `~55.0.4` | Live sticky notification with trip stats |
| `expo-file-system` (`legacy`) | `~55.0.4` | Audit log file + JSON state file |
| `expo-sharing` | `~55.0.11` | Share-sheet for export ZIP |
| `expo-constants` | `~55.0.7` | Reads `EXPERIMENT_VARIANT` from EAS extra |
| `expo-dev-client` | `~55.0.11` | Dev builds |
| `jszip` | `^3.10.1` | Build the ZIP without native deps |
| `react-native` | `0.83.2` | Framework |
| `react` | `19.2.0` | UI |
| `typescript` | `~5.9.2` (dev) | Static types |

No additional runtime dependencies. No analytics, no crash reporters, no
network clients of any kind.

---

## 3. Build variants

Selected at EAS build time via the `EXPERIMENT_VARIANT` env var, resolved at
launch by [`app/src/utils/experimentConfig.ts`](app/src/utils/experimentConfig.ts).
Every variant produces a separate APK so they can be compared on the same
route under controlled conditions.

| variant | label | sampling | fastest | writeBufferSize | writeBufferTimeoutMs | geofence in | geofence out | dwell | FG service |
|---|---|---|---|---|---|---|---|---|---|
| `exp-high` | HIGH-FREQ | 2 s | 1 s | 1 | 0 | 40 m | 60 m | 5 s | yes |
| `exp-medium` | MEDIUM-FREQ | 5 s | 3 s | 1 | 0 | 40 m | 60 m | 5 s | yes |
| `exp-low` | LOW-FREQ | 10 s | 7 s | 20 | 60 s | 55 m | 80 m | 8 s | yes |
| `exp-bg-degraded` | BG-DEGRADED | 5 s | 3 s | 1 | 0 | 40 m | 60 m | 5 s | **no** |

**Notes:**

- The variant string also flows into `trip_sessions.experiment_variant` so
  every export can be sliced by variant downstream.
- `exp-bg-degraded` is the **negative control** — no foreground service, no
  wake lock, so the OS is free to kill the GPS callback. The expected outcome
  is poorer recall vs. the other three variants.
- `exp-high` is the **upper bound** — most points, most battery use.
- `exp-low` is the **production-realistic baseline** — points are batched in
  groups of 20 (or every 60 s, whichever first) into SQLite, so write
  pressure is ~20× lower than the per-point variants.

---

## 4. Directory tree

```
R503-trip-logger/
├── DOCUMENTATION.md                    ← this document
├── CLAUDE.md                           ← agent context
├── README.md                           ← short user-facing
├── TODO.md
├── analyze_r503.py                     ← Python offline analysis (not used at runtime)
└── app/                                ← the entire mobile app
    ├── App.tsx                         ← root React component → <AppTabs/>
    ├── index.ts                        ← Expo registry entry, registers App.tsx
    ├── app.json                        ← Expo config: name, permissions, plugins
    ├── app.config.js                   ← dynamic config (reads EXPERIMENT_VARIANT)
    ├── eas.json                        ← EAS Build profiles per variant
    ├── package.json / package-lock.json
    ├── tsconfig.json                   ← strict TS
    ├── explore.tsx                     ← (unused / dev scratch — not registered)
    ├── assets/                         ← icon.png, splash, adaptive icons
    ├── android/                        ← prebuilt native project (gradlew, manifest, kotlin)
    │   └── app/src/main/
    │       ├── AndroidManifest.xml     ← merged manifest (permissions + services)
    │       └── java/com/jaja/r503logger/testing/
    │           ├── BatteryOptimizationModule.kt  ← native bridge to PowerManager
    │           ├── BatteryOptimizationPackage.kt ← registers the module
    │           └── MainApplication.kt            ← adds the package to packages list
    ├── data/
    │   └── r503_stops.ts               ← R503_STOPS[] constant (14 stops, direction A)
    ├── database/
    │   ├── db.ts                       ← SQLite singleton + init flag
    │   ├── migrations.ts               ← CREATE / ALTER + seeds R503 stops
    │   └── schema.ts                   ← canonical CREATE TABLE strings
    ├── models/
    │   └── Trip.ts                     ← DirectionCode, WindowCode, TripRow
    ├── src/
    │   ├── components/                 ← presentational React (GlassCard, MetricTile, MiniChart, StopProgress)
    │   ├── db/
    │   │   ├── queries.ts              ← ALL SQL access + write buffer (~750 lines)
    │   │   └── qu/                     ← legacy / unused subdirectory
    │   ├── screens/
    │   │   ├── AppTabs.tsx             ← bottom tab bar (5 tabs)
    │   │   ├── DashboardScreen.tsx     ← live metrics + tracking health
    │   │   ├── TripScreen.tsx          ← Start/Stop + System Status card + banners
    │   │   ├── ExportsScreen.tsx       ← export buttons
    │   │   ├── LogsScreen.tsx          ← in-app log viewer
    │   │   ├── SettingsScreen.tsx      ← toggles (charts, debug overlay)
    │   │   └── useTripState.ts         ← React hook subscribing to TripController
    │   ├── services/
    │   │   ├── android/
    │   │   │   └── batteryOptimization.ts  ← JS bridge to BatteryOptimizationModule.kt
    │   │   ├── export/
    │   │   │   └── exportBundle.ts     ← builds the ZIP
    │   │   └── location/
    │   │       ├── filters.ts          ← haversine, EMA, generic filter rules
    │   │       ├── fileAudit.ts        ← appendAuditLog → r503_tracking_audit.log
    │   │       └── stopDetector.ts     ← (alternative sequenced detector, used for state shape)
    │   ├── theme/
    │   │   └── tokens.ts               ← colors, spacing
    │   └── utils/
    │       ├── experimentConfig.ts     ← VARIANT + SENSING_CONFIG
    │       ├── id.ts                   ← createUuidV4
    │       └── settingsStore.ts        ← app-level prefs JSON file
    ├── trip/                           ← THE HOT PATH (read this folder first)
    │   ├── TripController.ts           ← orchestrator (state, timers, lifecycle) ~1100 lines
    │   ├── backgroundLocationTask.ts   ← TaskManager.defineTask body
    │   ├── backgroundWatchdogTask.ts   ← expo-background-fetch fallback
    │   ├── activeTripStore.ts          ← active_trip_session.json read/write
    │   ├── tripNotification.ts         ← live sticky notification with trip stats
    │   ├── gpsService.ts               ← (foreground-only) permission helper
    │   ├── stopDetector.ts             ← (legacy) detector state shape, helpers
    │   └── speedCalculator.ts          ← haversine + speed util (duplicate of filters.ts haversine)
    └── utils/
        └── share.ts                    ← expo-sharing wrapper
```

---

## 5. Architecture at a glance

```
                          ┌────────────────────────┐
                          │     React UI Tree      │
                          │  AppTabs ─┬─ Dashboard │
                          │           ├─ Trip     │
                          │           ├─ Exports  │
                          │           ├─ Logs     │
                          │           └─ Settings │
                          └───────────┬────────────┘
                                      │ useTripState()
                                      ▼
                          ┌────────────────────────────┐
                          │      TripController        │  ◄── tripUpdateListener
                          │  (single global singleton) │       (point-update | task-error)
                          │  state, timers, lifecycle  │
                          └─┬────────┬─────────────┬───┘
                            │        │             │
              AppState ─────┘        │             └──► tripNotification.publish (10s)
              Permissions            │                  tripNotification.clear  (on stop)
              Battery opt            │
              Wake lock              ▼
              MotoG54 5G   ┌─────────────────────────┐
              MyUX         │ backgroundLocationTask  │
              Background   │  (defineTask body)      │
              Activity     │  - persistPoint         │
                           │  - runStopDetection     │
                           │  - flushPointBuffer     │
                           └──┬──────────────────┬───┘
                              │                  │
                              ▼                  ▼
                  ┌──────────────────┐  ┌──────────────────────┐
                  │  src/db/queries  │  │ activeTripStore      │
                  │   (all SQL +     │◄─┤  active_trip_session │
                  │   write buffer)  │  │  .json on disk       │
                  └────────┬─────────┘  └──────────────────────┘
                           ▼
                      database/db
                  (SQLite singleton)
                           │
                           ▼
                      migrations
                  + schema seeds

  Out-of-process:    backgroundWatchdogTask  (expo-background-fetch)
                     - independent JS context invocation
                     - reads active_trip_session + DB
                     - logs to audit + maybe resubscribes (foreground only)

  Auditing:          fileAudit.appendAuditLog  →  r503_tracking_audit.log
                     (JSON-lines, shared by ALL modules)
```

**Coupling rules (enforced by convention, not by tooling):**

- All UI subscribes to `TripController.state` via the `useTripState` hook.
  No screen imports from `trip/`, `database/`, or `src/db/` directly except
  `LogsScreen` (it reads the audit log file path).
- All SQL goes through `src/db/queries.ts`. The DB singleton in
  `database/db.ts` is its private dependency.
- `backgroundLocationTask` is the only module that holds a reference to
  `expo-location.startLocationUpdatesAsync`.
- The audit log is the only safe communication channel between the
  out-of-process watchdog and the rest of the app (and analysts in the
  field) — because the watchdog can fire when the JS context is otherwise
  suspended.

---

## 6. Per-file deep dive

### 6.1 Entry points and root files

#### [`app/App.tsx`](app/App.tsx)

3-line root component:
```tsx
import { AppTabs } from './src/screens/AppTabs';
export default function App() { return <AppTabs />; }
```
No state, no providers, no theming wrapper — the theme is plain constants.

#### [`app/index.ts`](app/index.ts)

Standard Expo entry registering `App` via `registerRootComponent`. Also
implicitly triggers the side-effectful `TripController` singleton
construction (via the import chain `AppTabs → TripScreen → TripController`)
which immediately calls `bootstrap()`.

#### [`app/app.json`](app/app.json)

Declarations that matter:

```json
"android": {
  "permissions": [
    "ACCESS_COARSE_LOCATION",
    "ACCESS_FINE_LOCATION",
    "ACCESS_BACKGROUND_LOCATION",
    "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_LOCATION",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    "WAKE_LOCK"
  ],
  "package": "com.jaja.r503logger.testing"
},
"plugins": [
  "expo-sharing",
  ["expo-location", {
    "locationAlwaysAndWhenInUsePermission": "Allow R503 Logger to access ...",
    "isAndroidBackgroundLocationEnabled": true,
    "isAndroidForegroundServiceEnabled": true
  }]
]
```

`RECEIVE_BOOT_COMPLETED` was previously listed but removed — no boot
receiver was ever implemented, and Play Store flags unused permissions.

#### [`app/app.config.js`](app/app.config.js)

Dynamic Expo config (`expo.extra.experimentVariant` resolved from
`process.env.EXPERIMENT_VARIANT`). EAS pipes the env var in at build time;
locally you can override it with `EXPERIMENT_VARIANT=exp-high npx expo prebuild`.

#### [`app/eas.json`](app/eas.json)

One profile per variant. Each profile sets `EXPERIMENT_VARIANT` so the same
codebase produces four distinct APKs.

#### [`app/tsconfig.json`](app/tsconfig.json)

Strict mode on. No path aliases.

---

### 6.2 The `trip/` folder (the hot path)

This folder contains 95% of the runtime complexity. Read it in this order:

#### [`app/trip/TripController.ts`](app/trip/TripController.ts) — ~1100 lines

The orchestrator. A single module-scope singleton (`tripController`) constructed
when the import graph first touches this file (during React tree
initialization). It owns:

**Singleton state:** every UI screen subscribes through `useTripState`. State
shape is described in §9.

**Constructor (lines 197-204):**
```typescript
constructor() {
  setTripUpdateListener((update) => this.handleBackgroundTripUpdate(update));
  AppState.addEventListener('change', (nextState) => void this.handleAppStateChange(nextState));
  void this.bootstrap();
}
```
Three side effects: wires the background-task callback, attaches the
AppState listener, and kicks off bootstrap (DB open → orphan finalize →
recover active trip → register BackgroundFetch watchdog).

**Public methods:**

| method | called from | what it does |
|---|---|---|
| `subscribe(fn)` | `useTripState` | adds a listener; calls it once with the current state |
| `getState()` | (rare) | snapshot getter |
| `setDirectionCode`, `setWindowCode` | TripScreen Selector | mutate state.directionCode / windowCode (only while idle) |
| `setChartsMode`, `setDebugOverlayEnabled` | SettingsScreen | persist via `saveSettings`, then update state |
| `startTrip()` | TripScreen | the big one — see §10.1 |
| `stopTrip()` | TripScreen | the other big one — see §10.2 |
| `exportTrip()` | ExportsScreen | flush buffer + write `r503_trip_<id>.json` to document directory |
| `exportBundle()` | ExportsScreen | flush buffer + delegate to `exportTripBundle` (the ZIP) |
| `shareExport()` | ExportsScreen | open share sheet via `expo-sharing` |
| `refreshDebugInfo()`, `refreshTrackingHealth()` | health timer | re-read DB counters |

**Private methods (the interesting ones):**

| method | when fires | what it does |
|---|---|---|
| `bootstrap()` | constructor | open DB → finalizeDanglingTrips → refreshSystemStatus → startSystemStatusTimer → recoverActiveTrip → registerBackgroundWatchdog |
| `recoverActiveTrip()` | bootstrap | reads active_trip_session.json; if a recording trip row exists, restores state + resumes tracking |
| `handleBackgroundTripUpdate(update)` | listener | discriminated union: 'point-update' updates counters; 'task-error' fills lastError |
| `handleAppStateChange(next)` | AppState | on bg→active, refresh system status; if GPS stale, resubscribe |
| `verifyBatteryWhitelist()` | startTrip | checks `isIgnoringBatteryOptimizations`; prompts once via native module; warns loudly if still denied |
| `refreshSystemStatus()` | every 5 s | re-reads permissions, services, battery whitelist, and runs the "task alive" truth check |
| `startWatchdog(tripId)` | startTrip | sets interval that queries `MAX(timestamp_ms)` and calls `resubscribeBackgroundTracking` if stale |
| `resubscribeBackgroundTracking(reason)` | watchdog / AppState | calls `restartBackgroundTracking` with a 30 s throttle |
| `publishLiveNotification()` | every 10 s | computes trip stats, calls `publishTripNotification` |
| `sampleBatteryNow(tripId)` | every 5 min | reads battery level, inserts into `battery_samples` |
| `safeBackgroundCleanup()` | error / stop | stops the background task, clears active session, releases wake lock, stops all timers, clears notification |
| `appendLog(message)` | everywhere | prepends an ISO-timestamped line to `state.logs` (max 200) |

**Constants of note:**

```typescript
const MAX_LOG_LINES = 200;                       // controller log cap
const NOTIFICATION_UPDATE_INTERVAL_MS = 10_000;
const BATTERY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const SYSTEM_STATUS_REFRESH_INTERVAL_MS = 5_000;

function getWatchdogThresholdMs(): number {
  // 6× sampling interval, clamped to [15s, 90s].
  // exp-high → 15s, exp-medium → 30s, exp-low → 60s
  return Math.min(90_000, Math.max(15_000, SENSING_CONFIG.samplingIntervalMs * 6));
}

function getWatchdogIntervalMs(): number {
  return Math.min(30_000, Math.max(10_000, Math.floor(getWatchdogThresholdMs() / 2)));
}
```

#### [`app/trip/backgroundLocationTask.ts`](app/trip/backgroundLocationTask.ts) — ~670 lines

This file lives in module scope outside the React tree. The first import of
this file registers the named task `R503_BACKGROUND_LOCATION_TASK` via
`TaskManager.defineTask`. After registration, any GPS callback OR any task
restart event invokes the body — even if the React tree was never mounted
in this process (e.g. the BackgroundFetch task could trigger a callback in
a separate JS instance after a force-stop).

**Module-scope state (~lines 90-94):**
```typescript
let tripUpdateListener: TripUpdateListener | null = null;
const countedTaskRuntimeTripIds = new Set<string>();
const taskRuntimeStartedAtMs = Date.now();
```
The `taskRuntimeStartedAtMs` is the **fingerprint** used to detect "this is
a task restart" — if the active session's `startedAtMs` is more than 10 s
older than the runtime's own start time, we know the OS spun up a new JS
instance and we should increment `task_restart_count`.

**`defineTask` body (~lines 187-340):** the heart of the data pipeline.
Pseudocode:

```typescript
1. const session = await loadActiveTripSession();
2. try {
3.   await activateKeepAwakeAsync('r503-gps');           // re-grab the wake lock
4.   if (taskBody.error) {
5.     incrementTripRestartCount + resubscribeGPS;
6.     audit log + emit 'task-error' to listener;
7.     return;
8.   }
9.   if (!session) return;                                // trip stopped → noop
10.  if (!(await waitForDbInitialized(5_000))) {          // DB not ready (rare)
11.    audit log 'db-not-initialized-timeout' + return;
12.  }
13.  if (this looks like a task restart) {
14.    increment task_restart_count + resubscribeGPS;
15.  }
16.  for (const location of locations.sortByTimestamp()) {
17.    if (location.timestamp < session.startedAtMs) continue; // discard stale
18.    const point = await insertGPSPoint(session.tripId, location);
19.    let detection = (defaults to no-event);
20.    if (!point.isFiltered) {
21.      detection = await runStopDetection(session.tripId, stops, point);
22.    }
23.    update lastUpdate;
24.  }
25.  await flushPointBuffer();                            // durability
26.  await saveActiveTripSession(mutableSession);
27.  if (lastUpdate) tripUpdateListener?.(lastUpdate);
28. } catch (error) {
29.   audit log + emit 'task-error';
30. }
```

**`insertGPSPoint(tripId, location)`** — the filter pipeline. See §8.1 for
the full walkthrough. It always returns an `InsertedGpsPoint` and ALWAYS
calls `persistPoint` (buffered) — filtered rows are still written, just
with `is_filtered=1`.

**`runStopDetection(tripId, stops, point)`** — the stop state machine. See
§8.2 and §8.3.

**Subroutines:**

- `ensureBackgroundLocationReady()`: requests foreground and background
  permissions in sequence, verifies location services are on. Throws with
  user-actionable messages.
- `isBackgroundTrackingRunning()`: thin wrapper around
  `Location.hasStartedLocationUpdatesAsync`. Returns whether **we asked the
  OS to track**, not whether the OS is actually delivering callbacks.
- `startBackgroundTracking()`: acquires wake lock, calls
  `Location.startLocationUpdatesAsync` with `getLocationTaskOptions()` —
  this is the call that actually starts the foreground service.
- `stopBackgroundTracking()`: stops the location updates, defensively
  `TaskManager.unregisterTaskAsync`s the task (the `defineTask` binding at
  module scope is retained), releases the wake lock.
- `resubscribeGPS()`: the recovery path. **This function is intentionally
  defensive.** See §11 — it never calls `stopLocationUpdatesAsync` and bails
  if the app is backgrounded. Failure to follow this rule causes the
  `ForegroundServiceStartNotAllowedException` cascade.
- `getLocationTaskOptions()`: builds the `Location.LocationTaskOptions`
  object from `SENSING_CONFIG`. Sets accuracy to `BestForNavigation`,
  `pausesUpdatesAutomatically: false` (critical — without this, iOS-style
  motion pausing kicks in and we lose data), and includes the foreground
  service config only when `SENSING_CONFIG.useForegroundService === true`.
- `incrementTripRestartCount(tripId)`: increments `trip_sessions.task_restart_count`.

#### [`app/trip/backgroundWatchdogTask.ts`](app/trip/backgroundWatchdogTask.ts) — ~140 lines

A second `TaskManager.defineTask` registration, this one for
`R503_BACKGROUND_WATCHDOG_TASK` — driven by `expo-background-fetch`. The
OS will fire this task on its own schedule (minimum interval 15 min,
heavily throttled in Doze) regardless of whether the app is running.

Behavior on fire:

1. Wait up to 3 s for DB init.
2. Load `active_trip_session.json`. If none, return `NoData`.
3. Confirm the matching `trip_sessions` row still has `ended_at IS NULL`.
4. Compute GPS gap = now - `MAX(gps_points.timestamp_ms)` (or now - started).
5. If gap < `max(90_000, samplingInterval × 60)`, return `NoData`.
6. Re-acquire wake lock (best-effort).
7. If location task is still alive (`hasStartedLocationUpdatesAsync`): just
   audit log and return — don't try a destructive restart.
8. If the task registration is gone:
   - If app is backgrounded AND foreground-service variant: log
     `restart-skipped: app-backgrounded-fg-service-restricted` and bail —
     attempting to start a foreground service here will throw
     `ForegroundServiceStartNotAllowedException` and we'd lose this
     watchdog slot for nothing.
   - Otherwise: call `startLocationUpdatesAsync` with the variant's options,
     increment `task_restart_count`, audit log `resubscribed`.

The watchdog is registered once at app bootstrap via
`registerBackgroundWatchdog()` and is never unregistered.

#### [`app/trip/activeTripStore.ts`](app/trip/activeTripStore.ts) — ~70 lines

Three functions backed by a single JSON file at
`{documentDirectory}active_trip_session.json`:

- `loadActiveTripSession(): Promise<ActiveTripSession | null>` — returns
  null if the file doesn't exist OR if the file exists but has no `tripId`.
- `saveActiveTripSession(session)` — writes the full session payload
  (tripId, route, direction, window, startedAtMs, variantId, detector
  states, lastFix) atomically (single `writeAsStringAsync` call).
- `clearActiveTripSession()` — idempotent delete.

`saveActiveTripSession` is called from inside the GPS callback batch every
time a point is processed, so the on-disk state stays at most one callback
behind real-time. This is what makes crash recovery (§10.4) possible.

#### [`app/trip/tripNotification.ts`](app/trip/tripNotification.ts) — ~85 lines

Wraps `expo-notifications` to publish a sticky low-importance notification
named `'r503-trip-live-stats'`. Configured once (lazy) — sets up the
Android channel `'r503-trip-stats'` with `IMPORTANCE_LOW` (no sound, no
vibrate, no badge) and requests permission silently.

**Public API:**

```typescript
publishTripNotification({
  tripId, elapsedSec, pointsCount, lastGpsAgeSec,
  taskRestartCount, variantLabel, wakeLockHeld
}): Promise<void>

clearTripNotification(): Promise<void>
```

Internally deduplicates: if the rendered body hasn't changed since last
call, returns without hitting the system API. This avoids spurious
notification updates every 10 s when the trip is stationary.

Notification body format:

```
Title:  R503 Trip {shortId}
Body:   {variantLabel} · {HH:MM:SS} · {pts} pts · last fix {Ngs ago} · restarts {N} · WL{✓|✗}
```

#### [`app/trip/gpsService.ts`](app/trip/gpsService.ts) — ~55 lines

A foreground-only helper (`watchPositionAsync` based). **Not used in the
recording hot path** — `backgroundLocationTask` takes over for trips. This
file is leftover from a pre-foreground-service version and currently has
no live callers from screens. Safe to delete in a future cleanup.

#### [`app/trip/stopDetector.ts`](app/trip/stopDetector.ts) — ~175 lines

A pure-functional stop detector with its own state shape
(`StopDetectorState`). Currently used only for its `getStopDetectionConfig`
export (consumed by `TripController.exportTrip` to embed config in the
legacy JSON dump) and for `createInitialStopDetectorState` (the persisted
detector state shape stored in `active_trip_session.json`).

The actual runtime stop detection happens in
[`backgroundLocationTask.runStopDetection`](app/trip/backgroundLocationTask.ts)
which uses the `stop_states` SQLite table for its state machine instead of
the in-memory `StopDetectorState`. The two co-exist; the SQLite one is
authoritative.

This file is the simpler-to-read version of the algorithm — read it first
to understand the intent, then read the SQLite version for the production
behavior.

#### [`app/trip/speedCalculator.ts`](app/trip/speedCalculator.ts) — 35 lines

Two utilities:

- `haversineMeters(lat1, lon1, lat2, lon2)`: great-circle distance in
  meters. Earth radius constant 6371000. Used by the legacy `stopDetector.ts`.
- `calculateSpeedMps(previous, current, sensorSpeedMps)`: returns the
  sensor speed if non-null and finite and ≥0; otherwise derives from
  position delta over time.

Note: `haversineMeters` is duplicated in
[`src/services/location/filters.ts`](app/src/services/location/filters.ts).
This is intentional separation — `trip/` is meant to be self-contained for
the background task context where importing too widely can pull in heavy
dependencies. In practice the duplication is harmless because the two
implementations are byte-identical.

---

### 6.3 The `database/` folder

#### [`app/database/db.ts`](app/database/db.ts) — 53 lines

Three module-scope variables and four exports:

```typescript
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let initPromise: Promise<void> | null = null;
```

- `getDb(): Promise<SQLite.SQLiteDatabase>` — the singleton accessor. First
  caller triggers `openDatabaseAsync('r503_trip_logger.db')` AND
  `runMigrations`. Subsequent callers await the cached promises. Always
  returns AFTER migrations have completed.
- `markDbInitialized()` — writes a `db_initialized.flag` file. Called once
  by `getDb` after `runMigrations` resolves.
- `isDbInitialized(): Promise<boolean>` — checks the flag file existence.
- `waitForDbInitialized(timeoutMs = 5000): Promise<boolean>` — polls the
  flag file every 500 ms. Used by `backgroundLocationTask` to avoid racing
  the migration on a cold start.

The flag file mechanism is necessary because the background task can fire
in a NEW JS context where the module-scope `initPromise` is `null` — so it
can't rely on awaiting the same promise. The flag file is shared cross-
context state.

#### [`app/database/schema.ts`](app/database/schema.ts) — ~195 lines

Two arrays of CREATE TABLE statements:

- `CREATE_SCHEMA_STATEMENTS`: the **legacy** singular tables (`trip`,
  `gps_point`, `stop`, `stop_event`). Run first by migrations. Still
  referenced by `TripController.startTrip` (INSERT INTO trip ...) and the
  `loadStops` helper. These will eventually be deprecated but are kept for
  upgrade compatibility.
- `CREATE_V1_TABLE_STATEMENTS`: the **current** plural tables
  (`trip_sessions`, `gps_points`, `stops`, `stop_events`, `stop_states`,
  `segment_times`, `route_variants`, `devices`, `schema_meta`, `config`).
  These are the hot-path tables.

See §7 for full column reference.

#### [`app/database/migrations.ts`](app/database/migrations.ts) — ~310 lines

Idempotent migration runner. Called once per app launch by `getDb`.
Performs:

1. `PRAGMA foreign_keys = ON`.
2. Run every statement in `CREATE_SCHEMA_STATEMENTS` (legacy CREATE IF NOT EXISTS).
3. Run every statement in `CREATE_V1_TABLE_STATEMENTS` (v1 CREATE IF NOT EXISTS).
4. `migrateGpsPointsTableIfNeeded(db)` — handles the historical schema where
   `gps_points` had `id INTEGER PRIMARY KEY` *without* `AUTOINCREMENT`. If
   detected, renames the table to `gps_points_legacy_shape`, recreates it
   with the correct shape, copies all rows over, drops the old table.
5. `migrateStopEventsTableIfNeeded(db)` — same pattern for `stop_events`
   that previously had `CHECK(event_type IN ...)` constraints.
6. `ensureLegacyColumns(db)` — **the workhorse**. A long list of
   `ensureColumn` calls each guarded by `PRAGMA table_info` to check
   whether the column exists; only ALTER TABLE if it doesn't. This is how
   we add new columns to existing tables (e.g. `ended_reason`,
   `experiment_variant`, `task_restart_count`, `battery_*`, `max_gap_sec`,
   etc.) without losing data. The recent additions are:

   ```typescript
   await ensureColumn(db, 'trip_sessions', 'ended_reason',
     'ALTER TABLE trip_sessions ADD COLUMN ended_reason TEXT;');
   await db.execAsync(`CREATE TABLE IF NOT EXISTS battery_samples (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     trip_id TEXT NOT NULL,
     timestamp_ms INTEGER NOT NULL,
     level_pct INTEGER NOT NULL,
     FOREIGN KEY(trip_id) REFERENCES trip_sessions(trip_id)
   );`);
   ```

7. `seedLegacyStops(db)` — inserts `R503_STOPS` into the legacy `stop` table
   if it's empty. 14 rows, all `direction_code='A'`.
8. `seedV1ReferenceData(db)` — inserts the route + route_variants + stops
   into the v1 tables. **Critical:** all 14 stops are inserted with
   `variant_id='r503_am'` because all 14 R503 stops are direction-A. There
   are no direction-B stops seeded.
9. `updateSchemaMeta(db)` — writes the schema version + installed timestamp.

The `ensureColumn` helper is the right pattern for adding columns; do not
add new columns by editing the CREATE TABLE strings (those only run on a
fresh install).

---

### 6.4 The `src/db/` folder

#### [`app/src/db/queries.ts`](app/src/db/queries.ts) — ~830 lines

**Every SQL access in the app goes through this file.** Organized by
concern:

**Device & session management:**

- `ensureDeviceRegistered(): Promise<string>` — returns the persistent
  device UUID. Generates one on first call, stores in
  `settingsStore.deviceId` AND `devices` table. Idempotent.
- `resolveVariantId(directionCode, _windowCode): string` — **direction-only
  resolution**. Always returns `'r503_am'` for direction A and `'r503_pm'`
  for direction B. The window code is ignored (it's preserved separately
  in `time_bucket`). The previous version respected the window code, which
  caused PM trips to look up zero stops because no direction-B stops are
  seeded. See §11.4 for the bug history.
- `computeTimeBucket(timestampMs): string` — returns `'HH-HH'` (e.g.
  `'14-15'`). Used to bucket trips for analysis.
- `insertSessionMetadata(input)` — INSERT OR IGNORE into `trip_sessions`.
- `markSessionEnded(tripId, endedAtMs, endedReason)` — UPDATE
  `trip_sessions.ended_at` AND `ended_reason` (only if non-null —
  preserves existing reason on subsequent calls). Also calls
  `updateTripMaxGapSec(tripId)`.
- `updateTripMaxGapSec(tripId)` — scans all `gps_points` for the trip,
  computes the largest inter-point gap in seconds, writes it to
  `trip_sessions.max_gap_sec`.
- `updateTripTaskRestartCount(tripId, n)` — direct setter.
- `updateTripBatteryMetrics(input)` — COALESCE-based update so partial
  metrics (e.g. only `battery_start_pct`) don't overwrite existing fields.

**Stop reference data:**

- `loadStopsForVariant(variantId)` — SELECT from `stops` WHERE variant_id.

**Point persistence:**

- `persistPoint(input)` — pushes to the module-scope buffer. Triggers
  `flushPointBuffer` if buffer overflows size OR exceeds time. See §8.5.
- `flushPointBuffer()` — drains the buffer via SQLite transaction. Has an
  in-flight lock (`flushInFlight`) so concurrent calls serialize.
- `getPendingPointCount()` — number of points still in the buffer.
- `insertPointNow(db, input)` — the actual INSERT. Writes BOTH the new
  column names (`lon`, `heading_deg`, `smoothed_lon`) AND the legacy ones
  (`lng`, `bearing_deg`, `smoothed_lng`) for cross-version compatibility.

**Dangling trip recovery:**

- `finalizeDanglingTrips(excludeTripId): Promise<DanglingTripRecovery[]>` —
  finds every `trip_sessions` row with `ended_at IS NULL` (excluding the
  one passed in, if any) and closes it. Uses `MAX(gps_points.timestamp_ms)`
  as the end time, falling back to `started_at + 1s` if no points. Tags
  with `ended_reason='auto_finalized_orphan'`. Returns the list of
  recoveries for inclusion in the next export.

**Stop event persistence:**

- `persistStopEvent(input)` — calls `flushPointBuffer` first (so the
  segment computation sees the latest points). Then enforces three
  invariants via the audit log:
  1. No duplicate `(trip_id, stop_id, event_type)`.
  2. The new event's `timestamp_ms` must be > any previous event for that
     stop (time-monotonic).
  3. No new events after an `exit` event for the same stop.
  Suppressed events get audit-logged with a `reason` field.

**Segment rebuilding:**

- `rebuildSegmentsForTrip(tripId)` — flushes the buffer, deletes ALL
  existing segments for the trip, then rebuilds from scratch using the
  current `stop_events`. Skip-stop aware (see §8.4). Each segment row gets
  full quality metrics computed by `computeSegmentMetrics`.

**Segment metrics:**

- `computeSegmentMetrics(db, tripId, departMs, arriveMs)` — queries all
  non-filtered `gps_points` in `[departMs, arriveMs]`, computes:
  - `distanceM`: sum of haversine between consecutive points
  - `avgSpeedMps`: SPACE mean speed (`distanceM / wallTimeSec`) — correct
    for ETA modeling, NOT the arithmetic mean of point speeds
  - `p95SpeedMps`, `stdSpeedMps`, `congestionRatio` (% points under
    3 m/s ≈ 10 km/h)
  - `meanAccuracyM`, `p95AccuracyM`, `minAccuracyM`
  - `qualityFlag`: 'good' | 'degraded' | 'poor' based on point count,
    max gap, accuracy
  - `maxGapSec` between consecutive timestamps in the segment

**Stop-state reconstruction:**

- `reconstructStopDetectionStateFromEvents(tripId, stops)` — walks
  `stop_events` for the trip in time order and rebuilds the legacy
  `StopDetectionState` (used during recovery to repopulate the in-memory
  detector). Only used in legacy code paths.

**Health queries:**

- `loadTripDebug(tripId)` — counts events, segments, and the most recent
  filter_reason for filtered points.
- `loadTrackingHealth(tripId)` — counts legacy points, v1 points, stop
  events, plus the latest timestamp from both tables.

**Persistence helpers (legacy detector state):**

- `saveDetectionState`, `loadDetectionState` — read/write JSON blob in
  `trip_sessions.notes`. Used by the older code paths that haven't moved
  to the `stop_states` table yet.

**Export metadata:**

- `loadExportMetadata(tripId)` — used by `exportBundle` to write
  `metadata.json` with schema version, app version, device id, variant id,
  experiment variant, restart count, battery deltas, max gap.

**Mid-trip battery sampling:**

- `insertBatterySample(tripId, timestampMs, levelPct)` — single-row INSERT.
  Called every 5 min by the `batterySampler` timer in TripController.

---

### 6.5 The `src/screens/` folder

#### [`app/src/screens/AppTabs.tsx`](app/src/screens/AppTabs.tsx) — 75 lines

Custom 5-tab navigator built with plain React + Pressable (no
react-navigation). Tabs: `dashboard | trip | exports | logs | settings`.
The currently selected tab id is held in `useState`. Other tabs are simply
not rendered (no preserve-state-while-hidden behavior).

Adding a new tab: import the screen component, add to the `TabId` union,
add a `<TabButton/>` to the bottom bar.

#### [`app/src/screens/useTripState.ts`](app/src/screens/useTripState.ts) — 9 lines

```typescript
export function useTripState(): UITripState {
  const [state, setState] = useState<UITripState>(tripController.getState());
  useEffect(() => tripController.subscribe(setState), []);
  return state;
}
```

Every screen calls this. The `useEffect` returns the unsubscribe function
so re-mounts don't leak listeners.

#### [`app/src/screens/TripScreen.tsx`](app/src/screens/TripScreen.tsx) — ~300 lines

The Start/Stop screen. Layout from top to bottom:

1. Title card (route + variant + variant id).
2. **Banners** (conditional):
   - Red "Background task error" if `lastTaskErrorAt` was within the last 60 s.
   - Red "Background location revoked" if `state.backgroundPermissionRevoked`.
   - Yellow "Recovered N orphan trips" if `recoveredOrphans.length > 0`.
   - Yellow "OS throttling background service" if `taskRestartCount ≥ 5`,
     with Moto-friendly instructions.
   - Red "Foreground service not running" if we're recording but the OS
     says the task isn't registered.
3. Direction selector (A / B) — disabled while recording.
4. Window selector (AM / PM / OFF) — disabled while recording.
5. Start / Stop buttons. Start is disabled when:
   - already recording or busy
   - `!state.dbReady`
   - `!state.foregroundPermissionGranted`
   - `!state.backgroundPermissionGranted`
   - `!state.locationServicesEnabled`
   When disabled for any of these, a one-line hint appears below.
6. **Trip card**: tripId, elapsed, points, events, last error.
7. **System card**: green/red indicators for all the system status fields,
   plus last GPS age, task restart count, variant config.

`Banner` is an inline component with `error | warn` tone variants. `StatusRow`
is an inline component that renders a label + colored value pair.

#### [`app/src/screens/DashboardScreen.tsx`](app/src/screens/DashboardScreen.tsx) — ~145 lines

Live read-only dashboard. Doesn't drive any actions. Sections:

1. Title + status badge (color-coded: green=recording, yellow=stopped,
   muted=idle).
2. Six `MetricTile`s: elapsed, distance, avg speed, current speed,
   GPS accuracy, segments.
3. Stop progress (current stop / next stop / nearest distance) via
   `<StopProgress/>`.
4. Tracking health: legacy point count, v1 point count, stop event count,
   audit log line count, last DB write ISO, audit file path.
5. Conditional charts (speed + accuracy mini line charts) OR text-mode
   metrics (points, events, last filter reason, nearest stop).

The chart histories (`speedHistory`, `accuracyHistory`) are module-scope
arrays so they survive screen unmount but reset on app restart. Cap of 40
samples each.

#### [`app/src/screens/ExportsScreen.tsx`](app/src/screens/ExportsScreen.tsx) — ~85 lines

Three buttons:

1. **Export Legacy JSON** — `tripController.exportTrip()` writes a single
   JSON file with everything (the pre-bundle format). Useful for quick
   debugging.
2. **Export Bundle (CSV/JSON/ZIP)** — `tripController.exportBundle()` calls
   `exportTripBundle()` which writes the ZIP to cache.
3. **Share Export** — opens the share sheet with the last export path.

Status card at the bottom shows: last export timestamp, export path,
sharing availability, hint text.

All buttons are disabled when `!tripId` or `isBusy`. Note that "Share" is
only enabled after an export has produced a path.

#### [`app/src/screens/LogsScreen.tsx`](app/src/screens/LogsScreen.tsx) — ~165 lines

In-app log viewer with two sections:

1. **Controller log** — bound to `state.logs` (max 200 entries, newest
   first). Pure React render — auto-updates as new log lines are pushed.
2. **Audit log tail** — reads the last 200 lines of
   `r503_tracking_audit.log` via `expo-file-system` `readAsStringAsync`.
   Auto-refreshes every 5 s. Pretty-prints each JSON line as
   `HH:MM:SS [scope/action] trip=ABC12345 message`.

Includes a "Share audit log" button that hands the raw `.log` file to
`expo-sharing` so the user can ship it to a researcher without ADB.

Critical for field debugging without a USB cable.

#### [`app/src/screens/SettingsScreen.tsx`](app/src/screens/SettingsScreen.tsx) — ~90 lines

Two toggles:

1. **Visualization Mode** (charts ↔ text) — persisted via
   `tripController.setChartsMode`.
2. **Debug Overlay** — when on, shows a card with raw accuracy, nearest
   stop distance, inside/outside state, and last filter reason. Persisted
   via `tripController.setDebugOverlayEnabled`.

Also shows the current build's variant label and variant id at the top of
the title card.

---

### 6.6 The `src/services/` folder

#### [`app/src/services/location/filters.ts`](app/src/services/location/filters.ts) — ~110 lines

Exported helpers (some used by the runtime, some legacy):

- `haversineMeters(lat1, lon1, lat2, lon2)` — same as
  `speedCalculator.haversineMeters`. Used widely. Returns meters.
- `deriveHeadingDeg(previous, current)` — great-circle bearing in degrees,
  normalized to [0, 360). Used by `backgroundLocationTask.insertGPSPoint`
  to compute `derived_heading_deg` when both previous and current points
  are valid.
- `filterRawPoint(previous, current): FilterResult` — a more general filter
  (invalid coords, low quality accuracy, invalid timestamp gap, teleport
  jump, short-interval bounce, accuracy spike during motion). **Not used
  by the production hot path** — `backgroundLocationTask` has its own
  inlined filter logic. This is the cleaner reference implementation.
- `applyEmaSmoothing(previous, current, alpha=0.25)` — EMA on lat, lon, and
  speed. Also not used by the hot path; the hot path inlines an α=0.3 EMA.

You can think of this file as the "design intent" of the filters; the hot
path is the "fast-path implementation" for the same intent.

#### [`app/src/services/location/fileAudit.ts`](app/src/services/location/fileAudit.ts) — 32 lines

Three small functions:

- `getAuditFilePath()` — returns `{documentDirectory}r503_tracking_audit.log`.
- `appendAuditLog(entry)` — JSON-encodes the entry, prepends an ISO
  `logged_at` timestamp, appends one line to the audit file. Used by every
  module that needs durable logging.
- `getAuditStats()` — returns `{ path, lines, bytes }` for the audit file.
  Used by `TripController.refreshTrackingHealth` to surface the line count
  in the dashboard.

**Audit log format:** newline-delimited JSON, one event per line. Common
fields: `scope` (e.g. `'background-task'`, `'stop-event'`, `'recovery'`),
`action` (e.g. `'task-error'`, `'persisted'`, `'auto-finalize-orphan'`),
optional `trip_id`, plus event-specific fields. The file grows append-only
forever; there is no rotation. Size is typically 1-5 MB after a trip.

#### [`app/src/services/location/stopDetector.ts`](app/src/services/location/stopDetector.ts) — ~205 lines

A second stop detector implementation, **sequenced** — it tracks which
stop index the bus is currently approaching and only fires `arrive` /
`depart` events for that target (or advances to skip).

Differences from `trip/stopDetector.ts`:

- Uses `RouteStop` interface (string `stopId`, `stopOrder`, `radiusM`)
  matching the v1 `stops` table.
- Tracks `expectedIndex` so the detector knows which stop to look for next.
- Uses both geofence radius AND speed thresholds for arrive/depart
  (`arriveSpeedMps`, `departSpeedMps`, `departSpeedHoldMs`).
- Returns a `StopDetectionState` shape that gets persisted in
  `active_trip_session.json` for crash recovery.

Used by `TripController` only for its `createInitialStopDetectionState`
factory (to initialize the persisted detector state). The actual runtime
detection is done by `backgroundLocationTask.runStopDetection`, which uses
the SQLite `stop_states` table instead of this in-memory state. The two
implementations co-exist for historical reasons; the SQLite one is
authoritative.

#### [`app/src/services/android/batteryOptimization.ts`](app/src/services/android/batteryOptimization.ts)

JS bridge to the Kotlin `BatteryOptimizationModule`. Two exports:

- `isIgnoringBatteryOptimizations(): Promise<boolean>` — true if the app
  has been whitelisted from battery optimization (system settings screen
  or via our prompt).
- `requestIgnoreBatteryOptimizations(): Promise<boolean>` — opens the
  system "request whitelist" dialog. Resolves to true if granted, false
  if denied or cancelled.

Both go through `NativeModules.BatteryOptimization`.

#### [`app/src/services/export/exportBundle.ts`](app/src/services/export/exportBundle.ts) — ~260 lines

The `exportTripBundle(tripId)` function:

1. Flushes the point buffer.
2. Resolves the canonical trip id (looks up `trip_sessions.trip_id`).
3. Creates a per-export directory in
   `{cacheDirectory}export/r503_trip_{safeId}_{timestamp}/`.
4. Queries all relevant tables for this trip + the global stops + the
   global recovered-orphans list.
5. Normalizes each GPS row (computes `timestamp_iso`, `elapsed_sec`,
   `inter_point_gap_sec`).
6. Normalizes each stop_event row (lowercases event_type, maps legacy
   names: `enter→arrive`, `depart→exit`, `dwell_confirmed→dwell`).
7. Tags each segment row with `time_bucket`, `day_of_week`, `is_peak`.
8. Reads the entire `tracking_audit.log` from disk.
9. Builds the `metadata.json` payload with bundle_version=2, trip_id,
   device_id, app_version, experiment_variant, sensing config, battery
   start/end/drain, max gap, restart count, counts, schema version.
10. Validates: checks for empty segments-with-events, empty gps, empty
    stop_events, missing variant; logs warnings to console (not visible
    to users).
11. Writes each file individually to disk, builds a JSZip object, encodes
    as base64, writes the ZIP.

Files in the ZIP:
| file | format | content |
|---|---|---|
| `trip_sessions.csv` | CSV | one row, this trip |
| `trip.csv` | CSV | one row, legacy table |
| `gps_points.csv` | CSV | every callback (filtered + unfiltered) |
| `stop_events.csv` | CSV | every arrive/dwell/exit |
| `segment_times.csv` | CSV | derived segments |
| `stops.csv` | CSV | route reference (all 14) |
| `battery_samples.csv` | CSV | 5-min battery snapshots |
| `metadata.json` | JSON | bundle metadata |
| `recovery_metadata.json` | JSON | list of orphan trips auto-finalized |
| `tracking_audit.log` | JSON-L | full audit log copy |
| `bundle.json` | JSON | combined dump for one-shot ingestion |

---

### 6.7 The `src/utils/` folder

#### [`app/src/utils/experimentConfig.ts`](app/src/utils/experimentConfig.ts) — 76 lines

Resolves the build variant at runtime:

```typescript
const raw = Constants.expoConfig?.extra?.experimentVariant ?? 'medium';
export const VARIANT: ExperimentVariant = normalizeVariant(String(raw));
export const SENSING_CONFIG: SensingConfig = configs[VARIANT];
```

The `configs` object is a 4-entry record keyed by variant id. Every
consumer (background task, controller, screens, notification, export)
reads from `SENSING_CONFIG`.

#### [`app/src/utils/settingsStore.ts`](app/src/utils/settingsStore.ts) — ~70 lines

Persists user-level preferences in a JSON file at
`{documentDirectory}trip_logger_settings.json`. Schema:

```typescript
interface AppSettings {
  deviceId: string | null;
  debugOverlayEnabled: boolean;
  chartsMode: boolean;
  smoothingAlpha: number;          // unused at runtime
  enterRadiusM: number;            // unused at runtime (variant has it)
  exitRadiusM: number;             // unused at runtime
  experimentVariant: string;
  taskRestartCount: number;        // never actually incremented (DB is source of truth)
  batteryOptimizationPrompted: boolean;
}
```

Two functions: `loadSettings(merge?)` reads (optionally merges + writes
back), `saveSettings(patch)` reads-modify-writes. `incrementTaskRestartCount`
exists but is never called — the actual restart counter lives in
`trip_sessions.task_restart_count`.

#### [`app/src/utils/id.ts`](app/src/utils/id.ts)

`createUuidV4()` — non-crypto-secure UUID v4 generator using `Math.random`.
Adequate for trip IDs and event IDs (no security implications). The DB
enforces uniqueness via `UNIQUE` constraints.

---

### 6.8 The `src/components/` folder

Small presentational React components with no business logic:

- **`GlassCard`** — translucent card with border and rounded corners.
  Container for grouped content.
- **`MetricTile`** — label + value, side-by-side, used in the dashboard
  grid.
- **`MiniChart`** — a sparkline-style line chart drawn with React Native
  views (no charting library). Auto-scales to the data range.
- **`StopProgress`** — three rows: "Inside stop:", "Next stop:", "Nearest
  distance:". Used on the dashboard.

None of these own state. All take props and render.

---

### 6.9 The `models/`, `data/`, and `utils/` folders

#### [`app/models/Trip.ts`](app/models/Trip.ts) — 13 lines

```typescript
export type DirectionCode = 'A' | 'B';
export type WindowCode = 'AM' | 'PM' | 'OFF';
export interface TripRow { trip_id, started_at_ms, ended_at_ms,
  route_number, direction_code, window_code, status }
```

That's it. Just the union types and the legacy table row interface.

#### [`app/data/r503_stops.ts`](app/data/r503_stops.ts) — 125 lines

The 14 R503 stops, hardcoded with WGS84 lat/lon to 15 decimal places:

| seq | name | lat | lon |
|---:|---|---|---|
| 1 | Hope Avenue Bangkal | 7.0609411 | 125.5538954 |
| 2 | Ateneo Senior High | 7.0607007 | 125.5567978 |
| 3 | SPED Bangkal | 7.0612552 | 125.5595642 |
| 4 | Tahimik Avenue Matina | 7.0608407 | 125.5636770 |
| 5 | Matina Crossing | 7.0581724 | 125.5697590 |
| 6 | Kawayan Drive | 7.0557639 | 125.5754097 |
| 7 | DGT | 7.0582884 | 125.5803162 |
| 8 | Water District Matina | 7.0609725 | 125.5900542 |
| 9 | NCCC Maa | 7.0619285 | 125.5939131 |
| 10 | Ateneo Matina | 7.0628507 | 125.5977379 |
| 11 | Pichon St / Quirino Ave | 7.0678601 | 125.6031174 |
| 12 | Grand Menseng Hotel | 7.0645041 | 125.6068508 |
| 13 | CM Recto Avenue | 7.0665252 | 125.6105637 |
| 14 | Davao Light (C. Bangoy St) | 7.0727658 | 125.6106775 |

All have `direction_code='A'`. There are no direction-B stops in this
seed (the reverse trip uses the same physical stops, conceptually).

#### [`app/utils/share.ts`](app/utils/share.ts)

Thin wrapper around `expo-sharing`:

- `isSharingAvailable(): Promise<boolean>` — checks if the runtime supports
  share.
- `tryShareFile(path): Promise<{ shared: boolean }>` — opens the share
  sheet; returns whether the share completed.

Used by `TripController.shareExport` and `LogsScreen.onShareAudit`.

---

### 6.10 The `android/` native module

#### [`BatteryOptimizationModule.kt`](app/android/app/src/main/java/com/jaja/r503logger/testing/BatteryOptimizationModule.kt)

A minimal `ReactContextBaseJavaModule` exposing two `@ReactMethod`s:

```kotlin
@ReactMethod
fun isIgnoringBatteryOptimizations(promise: Promise) {
  // SDK < M: always true (no battery optimization yet)
  // SDK >= M: PowerManager.isIgnoringBatteryOptimizations(packageName)
}

@ReactMethod
fun requestIgnoreBatteryOptimizations(promise: Promise) {
  // Launches Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
  // intent with FLAG_ACTIVITY_NEW_TASK.
  // Resolves true if the user agreed.
}
```

The package is registered in `MainApplication.kt` via the standard
`getPackages()` override. The JS side accesses it via
`NativeModules.BatteryOptimization` (wrapped in
`src/services/android/batteryOptimization.ts`).

---

## 7. Database schema reference

### 7.1 Legacy tables (kept for compatibility)

**`trip`** — older session table. Still written by `TripController.startTrip`
but mostly redundant with `trip_sessions`. Schema:

| column | type | nullable | notes |
|---|---|:-:|---|
| `trip_id` | TEXT | NO | PK; same UUID as `trip_sessions.trip_id` |
| `started_at_ms` | INTEGER | NO | epoch ms |
| `ended_at_ms` | INTEGER | YES | NULL while recording |
| `route_number` | TEXT | NO | always `'R503'` |
| `direction_code` | TEXT | NO | `'A' \| 'B'` |
| `window_code` | TEXT | NO | `'AM' \| 'PM' \| 'OFF'` |
| `status` | TEXT | NO | `'recording' \| 'stopped' \| 'start_failed'` |

**`gps_point`** — older points table. Modern code reads/writes
`gps_points` (plural) instead, but `trip_sessions` migrations preserve
this for backward compatibility queries.

**`stop`** — legacy stops table (integer stop_id 1-14, direction_code).
Seeded by `seedLegacyStops`. Used by `TripController.loadStops` to
populate the `stops: StopInfo[]` field on the controller, but **stop
detection runtime uses `stops` (plural)** with string IDs.

**`stop_event`** — legacy stop_event table. Not actively written.

### 7.2 v1 tables (the hot path)

**`schema_meta`**

| column | type | notes |
|---|---|---|
| `schema_version` | INTEGER NOT NULL | currently 7 |
| `installed_at` | TEXT NOT NULL | ISO timestamp |

**`devices`**

| column | type | notes |
|---|---|---|
| `device_id` | TEXT PRIMARY KEY | persistent app-install UUID |
| `created_at` | TEXT NOT NULL | ISO |
| `platform` | TEXT NOT NULL | `'android'` |
| `os_version` | TEXT NOT NULL | e.g. `'33'` (API 33 = Android 13) |
| `model` | TEXT NOT NULL | `'unknown-model'` (could be improved) |

**`routes`** + **`route_variants`** — reference data for the route + its
direction/time variants. Three variants seeded: `r503_am`, `r503_pm`,
`r503_off`.

**`stops`** — runtime stops reference, keyed by `(stop_id, variant_id)`.
Currently all 14 R503 stops live under `variant_id='r503_am'`. Direction-B
trips will need their own seeded set if/when direction B is supported.

| column | type | notes |
|---|---|---|
| `stop_id` | TEXT PRIMARY KEY | format `r503_r503_am_s01` ... `_s14` |
| `variant_id` | TEXT NOT NULL | FK → `route_variants.variant_id` |
| `stop_order` | INTEGER NOT NULL | 1-14 |
| `name` | TEXT NOT NULL | human-readable |
| `lat`, `lng` | REAL NOT NULL | WGS84 |
| `radius_m` | REAL NOT NULL | seeded 40; runtime ignores this and uses `SENSING_CONFIG.geofenceRadiusM` |

**`trip_sessions`** — the canonical session record. **One row per trip.**

| column | type | notes |
|---|---|---|
| `trip_id` | TEXT PRIMARY KEY | UUID v4 |
| `device_id` | TEXT NOT NULL | FK → devices |
| `variant_id` | TEXT NOT NULL | FK → route_variants — used for stop lookup |
| `started_at` | TEXT NOT NULL | ISO |
| `ended_at` | TEXT | NULL while recording |
| `timezone` | TEXT NOT NULL | e.g. `'Asia/Manila'` |
| `app_version` | TEXT NOT NULL | hardcoded `'1.0.0-v1.0'` |
| `time_bucket` | TEXT NOT NULL | `'HH-HH'` |
| `notes` | TEXT | legacy detector state JSON, rarely used |
| `experiment_variant` | TEXT | `'high'`/`'medium'`/`'low'`/`'bg-degraded'` |
| `task_restart_count` | INTEGER | incremented by background task on restart detection |
| `battery_start_pct` | INTEGER | 0-100, written at startTrip |
| `battery_end_pct` | INTEGER | 0-100, written at stopTrip |
| `battery_drain_pct` | INTEGER | `max(0, start - end)` |
| `max_gap_sec` | REAL | computed from gps_points on stopTrip |
| `ended_reason` | TEXT | `'user_stop' \| 'start_failed' \| 'auto_finalized_orphan'` |

**`gps_points`** — every GPS callback. Has both `timestamp_ms` (INTEGER,
used everywhere internally) and `ts` (ISO TEXT) kept in sync.

| column | type | notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `point_id` | TEXT UNIQUE | optional; null in current writes |
| `trip_id` | TEXT NOT NULL | FK |
| `ts` | TEXT | ISO mirror of timestamp_ms |
| `timestamp_ms` | INTEGER | epoch ms; authoritative |
| `lat` | REAL NOT NULL | raw |
| `lng` | REAL | legacy alias of `lon` |
| `lon` | REAL | raw |
| `accuracy_m` | REAL | provider accuracy in meters |
| `altitude_m` | REAL | provider altitude (often noisy) |
| `speed_mps` | REAL | provider speed |
| `bearing_deg` | REAL | legacy alias of `heading_deg` |
| `heading_deg` | REAL | provider heading |
| `derived_speed_mps` | REAL | computed by position delta when valid |
| `derived_heading_deg` | REAL | great-circle bearing from previous valid point |
| `provider_speed_mps` | REAL | redundant with `speed_mps` |
| `provider_heading_deg` | REAL | redundant with `heading_deg` |
| `is_filtered` | INTEGER NOT NULL DEFAULT 0 | 1 if any filter matched |
| `filter_reason` | TEXT | see §8.1 for values |
| `smoothed_lat` | REAL | EMA-smoothed (α=0.3) |
| `smoothed_lng` | REAL | legacy alias |
| `smoothed_lon` | REAL | EMA-smoothed |
| `smoothed_speed_mps` | REAL | EMA-smoothed |

Indexes: `idx_gps_points_trip_ts`, `idx_gps_points_trip_timestamp_ms` —
both `(trip_id, ...)` for trip-scoped scans.

**`stop_events`** — one row per arrive/dwell/exit transition.

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `event_id` | TEXT UNIQUE | UUID per event |
| `trip_id` | TEXT NOT NULL | FK |
| `stop_id` | TEXT NOT NULL | FK |
| `event_type` | TEXT NOT NULL | `'arrive' \| 'dwell' \| 'exit'` |
| `timestamp_ms` | INTEGER | epoch ms |
| `ts` | TEXT | ISO mirror |
| `dist_m` | REAL | distance to stop center at event |
| `dist_to_stop_m` | REAL | redundant with dist_m |
| `lat`, `lon` | REAL | bus position at event (smoothed) |
| `speed_mps` | REAL | provider speed at event |
| `accuracy_m` | REAL | provider accuracy at event |

**`stop_states`** — per-trip per-stop state machine cache. Used by the
background task to know which `arrive`/`dwell`/`exit` to expect next.

| column | type | notes |
|---|---|---|
| `trip_id` | TEXT NOT NULL | composite PK part 1 |
| `stop_id` | TEXT NOT NULL | composite PK part 2 |
| `state` | TEXT NOT NULL | `'OUTSIDE' \| 'NEAR' \| 'ARRIVED' \| 'DWELLING' \| 'EXITED'` |
| `entered_at_ms` | INTEGER | timestamp of latest enter |
| `dwell_at_ms` | INTEGER | timestamp of dwell confirmation |
| `exit_candidate_count` | INTEGER NOT NULL DEFAULT 0 | consecutive points outside |
| `updated_at_ms` | INTEGER NOT NULL | last touched |

**`segment_times`** — derived. Rebuilt from `stop_events` after every new
event.

| column | type | notes |
|---|---|---|
| `segment_id` | TEXT PK | UUID |
| `trip_id` | TEXT NOT NULL | FK |
| `from_stop_id` | TEXT NOT NULL | FK |
| `to_stop_id` | TEXT NOT NULL | FK |
| `depart_ms` | INTEGER | when bus exited from_stop |
| `arrive_ms` | INTEGER | when bus arrived at to_stop |
| `travel_time_s` | REAL | (arrive_ms - depart_ms) / 1000 |
| `start_ts`, `end_ts` | TEXT NOT NULL | ISO mirrors |
| `travel_time_sec` | INTEGER NOT NULL | rounded `travel_time_s` |
| `distance_m` | REAL NOT NULL | sum of haversine in segment |
| `avg_speed_mps` | REAL | distance / wall time |
| `p95_speed_mps` | REAL | 95th percentile derived/provider speed |
| `mean_accuracy_m` | REAL | mean of accuracy_m |
| `quality_flag` | TEXT | `'good' \| 'degraded' \| 'poor'` |
| `point_count` | INTEGER | non-filtered points in segment |
| `max_gap_sec` | REAL | max inter-point gap |
| `p95_accuracy_m` | REAL | |
| `min_accuracy_m` | REAL | |
| `dwell_time_sec` | REAL | from_stop arrive → exit dwell duration |
| `congestion_ratio` | REAL | fraction of points under 3 m/s |
| `std_speed_mps` | REAL | std deviation |
| `stops_skipped` | INTEGER NOT NULL DEFAULT 0 | 0 = adjacent; N = N stops skipped |

**`battery_samples`** — added recently.

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `trip_id` | TEXT NOT NULL | FK |
| `timestamp_ms` | INTEGER NOT NULL | epoch ms |
| `level_pct` | INTEGER NOT NULL | 0-100 |

Index: `idx_battery_samples_trip_ts (trip_id, timestamp_ms)`.

**`config`** — key-value store, unused at runtime.

---

## 8. Algorithm walkthroughs

### 8.1 GPS filter pipeline

Implemented in
[`backgroundLocationTask.insertGPSPoint`](app/trip/backgroundLocationTask.ts).
Every GPS callback runs through this. The filter rules are checked in
order; the first match wins. Filtered rows ARE persisted (with
`is_filtered=1`), they're just excluded from segment metrics by
`WHERE is_filtered=0`.

| order | filter_reason | trigger | smoothed values | impact |
|---|---|---|---|---|
| 1 | `duplicate-timestamp` | `timestampMs === previousPoint.timestamp_ms` | carryover | drop redundant fix |
| 2 | `out-of-order-timestamp` | `timestampMs < previousPoint.timestamp_ms` | carryover | callbacks can interleave; keep monotonic |
| 3 | `post-gap-reset` | `timestampMs - previousPoint.timestamp_ms > 60_000` | reset EMA to current | mark recovery from CPU sleep |
| 4 | `cold_start_zero_values` | `speedMps===0 && headingDeg===0` AND **(accuracy>20m OR previousPoint was filtered)** | carryover | sentinel-value first lock; relaxed to keep mid-trip stationary fixes |
| 5 | `low-accuracy` | `accuracyM > 40` | carryover | drop garbage |
| — | (kept) | none of the above | EMA update with α=0.3 | use for segments |

**Important nuance for rule 4:** Android's Fused Location Provider returns
`speed=0, heading=0` for ANY stationary fix (including legitimate dwell at
a bus stop). The original rule filtered all such points indiscriminately,
which corrupted dwell detection (`runStopDetection` requires consecutive
non-filtered points inside the geofence). The relaxed rule only filters
when accuracy is poor (>20 m, indicating provider hasn't locked yet) OR
when we're in a post-gap context (previous point was filtered as
`post-gap-reset` or `cold_start_zero_values`).

**EMA (Exponential Moving Average) smoothing** for a kept point:

```typescript
smoothedLat = 0.3 * currentLat + 0.7 * previousSmoothedLat
smoothedLon = 0.3 * currentLon + 0.7 * previousSmoothedLon
smoothedSpeed = 0.3 * currentSpeed + 0.7 * previousSmoothedSpeed
```

This produces ~3-point effective window. The smoothed coords are what
`runStopDetection` uses to compute distance to stops — raw coords would
trigger spurious arrive/depart events on bouncy fixes.

### 8.2 Stop detection state machine

Implemented in
[`backgroundLocationTask.runStopDetection`](app/trip/backgroundLocationTask.ts).
Per-trip state is keyed by `(trip_id, stop_id)` in `stop_states`.

```
              ┌──────────┐  enter_radius
              │ OUTSIDE  │ ─────────────────►  ARRIVED
              └────┬─────┘  (& haven't been before)
                   │
                   │
              ┌────▼─────┐  enter_radius held
              │   NEAR   │ ─────────────────►  ARRIVED
              └──────────┘  (& haven't been before)

   ARRIVED  ────────────────────────►  DWELLING
            (inside enter_radius for ≥ dwellMs)

   ARRIVED|DWELLING ──────────────►   EXITED
                     (3 consecutive points
                      ≥ exit_radius)
```

**Per-point processing pseudocode:**

```
target = first stop with state != EXITED
nearest = stop with min distance to (smoothedLat, smoothedLon)

# Skip-stop check (§8.3) — may advance target.

if target.state in (OUTSIDE, NEAR) and dist(target) <= enter_radius:
  state[target] = ARRIVED
  enteredAtMs = now
  insertStopEvent(target, 'arrive')
  rebuildSegmentsForTrip()

elif target.state == ARRIVED:
  if dist(target) <= enter_radius:
    if now - enteredAtMs >= dwellMs:
      state[target] = DWELLING
      insertStopEvent(target, 'dwell')
  elif dist(target) >= exit_radius:
    exit_candidate_count[target] += 1
    if exit_candidate_count[target] >= 3:
      state[target] = EXITED
      insertStopEvent(target, 'exit')
      rebuildSegmentsForTrip()

elif target.state == DWELLING:
  # same exit logic as ARRIVED case
  ...

UPDATE stop_states SET ... WHERE (trip_id, stop_id) = ...
```

**Radii** are read from `SENSING_CONFIG.geofenceRadiusM` (enter) and
`departureRadiusM` (exit). For `exp-medium`: 40 m enter, 60 m exit. The
asymmetry creates hysteresis to prevent flapping at the boundary.

### 8.3 Skip-stop handling

Real-world buses skip stops (no boarding/alighting expected). The detector
handles this:

```typescript
if (target && nearest.stop && nearest.distanceM != null &&
    nearest.stop.stopOrder > target.stopOrder &&
    nearest.distanceM <= EXIT_DISTANCE_M) {
  // We're within exit_radius of a stop ahead of our current target —
  // meaning the bus passed the target without arriving.
  state[target] = EXITED  (skip-stop-advanced)
  target = next non-EXITED stop
}
```

This advances the target machine. Multiple consecutive skips will cascade
through the loop. The skip is audit-logged with
`scope='stop-detection', action='skip-stop-advanced'`.

**Why we don't insert an `arrive`/`exit` event for the skipped stop:**
because the bus never reached the `enter_radius` for it. The segment
builder (§8.4) will pick up the skip and write a single
`from_stop=N` → `to_stop=N+k` segment with `stops_skipped=k-1`.

### 8.4 Segment builder

Implemented in
[`queries.rebuildSegmentsForTrip(tripId)`](app/src/db/queries.ts). Called
after every `arrive` and every `exit` event.

**Steps:**

1. Flush point buffer (so segment metrics see latest data).
2. Load all stops for the trip's variant; build `stopOrder` lookup.
3. Load all `stop_events` for the trip, sorted by time.
4. Build:
   - `arrivesByStopId: Map<stopId, firstArriveMs>` — first arrive per stop
   - `exits: Array<{stopId, timestampMs}>` — all exit events in order
5. DELETE all existing segments for the trip (full rebuild).
6. For each exit:
   - Find the lowest-order stop AHEAD of the exit that has an arrive event
     AND whose arrive timestamp is AFTER the exit. This is the "to" stop.
   - If no such stop exists (e.g. last stop of trip): skip this exit.
   - Compute `stopsSkipped = lowestAheadOrder - fromOrder - 1`
   - Compute `dwellTimeSec` at the from-stop using the arrive/exit pair.
   - Call `computeSegmentMetrics` for `[exit.timestampMs, arriveMs]`.
   - INSERT one row into `segment_times`.
   - Audit log the segment completion.

The full rebuild on every event is fine because trips have at most ~14
segments and rebuilding is < 50 ms.

### 8.5 Write buffer

Implemented in
[`queries.persistPoint` + `queries.flushPointBuffer`](app/src/db/queries.ts).

Module-scope state:
```typescript
const pointBuffer: PersistPointInput[] = [];
let bufferLastFlushAtMs = Date.now();
let flushInFlight: Promise<void> | null = null;
```

`persistPoint(input)`:
1. Push to `pointBuffer`.
2. Compute `overSize = pointBuffer.length >= writeBufferSize`.
3. Compute `overTime = (writeBufferTimeoutMs > 0) && (now - bufferLastFlushAtMs >= writeBufferTimeoutMs)`.
4. If `overSize || overTime`, await `flushPointBuffer()`.

`flushPointBuffer()`:
1. If another flush is in-flight, await it and return.
2. If buffer is empty, just update `bufferLastFlushAtMs` and return.
3. Splice the entire buffer into a local `drained` array.
4. Start a new flush promise that runs `db.withTransactionAsync` with one
   `insertPointNow` per drained point.
5. On error: re-queue `drained` at the head of `pointBuffer`, audit log
   `'flush-failed'`, rethrow.
6. Finally: update `bufferLastFlushAtMs`, clear `flushInFlight`.

**Buffer flush triggers:**

| trigger | location |
|---|---|
| Buffer reaches `writeBufferSize` | `persistPoint` |
| Elapsed time exceeds `writeBufferTimeoutMs` | `persistPoint` |
| Stop event being inserted | `persistStopEvent` |
| Segment rebuild starting | `rebuildSegmentsForTrip` |
| End of every GPS callback batch | `backgroundLocationTask` defineTask |
| Trip ending | `TripController.stopTrip` |
| Export starting | `TripController.exportTrip`, `exportTrip Bundle` |
| App going to background | `TripController.handleAppStateChange` |

For `exp-high` and `exp-medium` (writeBufferSize=1, writeBufferTimeoutMs=0)
this is effectively write-through. For `exp-low` (size=20, timeout=60s)
SQLite write pressure drops ~20×.

### 8.6 Dangling trip recovery

Implemented in
[`queries.finalizeDanglingTrips(excludeTripId)`](app/src/db/queries.ts).
Runs once at app bootstrap, before `recoverActiveTrip`.

```
SELECT trip_id, started_at FROM trip_sessions WHERE ended_at IS NULL;

for each row:
  if excludeTripId && row.trip_id == excludeTripId: skip
  lastMs = SELECT MAX(timestamp_ms) FROM gps_points WHERE trip_id = ?
  endedAtMs = lastMs ?? (started_at + 1s)
  pointCount = SELECT COUNT(*) FROM gps_points WHERE trip_id = ?
  markSessionEnded(row.trip_id, endedAtMs, 'auto_finalized_orphan')
  UPDATE trip SET ended_at_ms = ?, status='stopped' WHERE trip_id = ?
  audit log 'auto-finalize-orphan'
  push to recovered[]

return recovered
```

`TripController.bootstrap` calls this with the currently active trip id
(from `active_trip_session.json`), so a live trip is NOT closed. Recoveries
are surfaced via `state.recoveredOrphans` and shown in a TripScreen banner.

The same recoveries are also queryable directly later (any
`trip_sessions` row with `ended_reason='auto_finalized_orphan'`), so the
export bundle includes a list in `recovery_metadata.json`.

### 8.7 Watchdog hierarchy

Three independent watchdogs run concurrently:

**1. In-process health watchdog** (`TripController.startWatchdog`)
- Cadence: variant-tuned, `max(10s, min(30s, gapThresholdMs/2))`
- Effective only when the app's JS context is active (foreground or just
  recently backgrounded before suspension).
- Action on stale GPS: calls `resubscribeBackgroundTracking('watchdog')`.

**2. AppState resume guard** (`TripController.handleAppStateChange`)
- Fires on every `background → active` transition.
- Refreshes system status, then if GPS is stale (older than
  `gapThresholdMs`), calls `resubscribeBackgroundTracking('foreground-resume')`.
- This is the **primary recovery mechanism on a real device** — the
  in-process watchdog can't run while suspended, but the moment the user
  opens the app, this hook kicks in.

**3. Out-of-process BackgroundFetch watchdog**
([`backgroundWatchdogTask`](app/trip/backgroundWatchdogTask.ts))
- Cadence: ~15 min (Android `JobScheduler`-throttled).
- Fires in a fresh JS context even if the React tree was never mounted.
- Action on stale GPS:
  - If task still registered: re-acquire wake lock, return.
  - If task gone AND app foregrounded: restart location updates.
  - If task gone AND app backgrounded: log `restart-skipped`. The
    foreground-service-from-background restriction prevents recovery here;
    the app needs to be re-opened.

All three are deliberate — they have different visibility:
- #1 sees real-time GPS callbacks but can't run while suspended.
- #2 reacts to user behavior.
- #3 is the only one that runs while the app is fully suspended; it can't
  start a foreground service from background but it CAN detect death and
  audit-log it.

---

## 9. State management reference (`UITripState`)

Defined in [`TripController.UITripState`](app/trip/TripController.ts).
Every field with its purpose:

| field | type | description |
|---|---|---|
| `status` | `'idle' \| 'recording' \| 'stopped'` | top-level trip lifecycle |
| `isBusy` | boolean | true during an async action (start/stop/export) |
| `routeNumber` | `'R503'` | constant for now |
| `directionCode` | `'A' \| 'B'` | user-selected before start |
| `windowCode` | `'AM' \| 'PM' \| 'OFF'` | user-selected before start |
| `tripId` | string \| null | current trip UUID |
| `pointsCount` | number | cumulative point inserts (incl. filtered) |
| `eventsCount` | number | cumulative arrive/dwell/exit |
| `segmentsCount` | number | cumulative segment rebuilds (not segment rows) |
| `startedAtMs` | number \| null | epoch ms |
| `elapsedSeconds` | number | updated every 1 s |
| `totalDistanceM` | number | running haversine sum of kept points |
| `avgSpeedMps` | number \| null | distance / elapsed |
| `currentSpeedMps` | number \| null | provider speed of last fix |
| `gpsAccuracyM` | number \| null | accuracy of last fix |
| `lastFix` | object \| null | timestampMs, lat, lon, accuracyM, speedMps, headingDeg |
| `nearestStopName` | string \| null | reported by detector |
| `nearestStopDistanceM` | number \| null | smoothed distance |
| `insideStopName` | string \| null | non-null when inside enter_radius of the current target |
| `expectedNextStopName` | string \| null | the current target stop name |
| `insideState` | `'INSIDE' \| 'OUTSIDE'` | for display |
| `exportPath` | string \| null | last export path (ZIP or JSON) |
| `lastExportTimestampIso` | string \| null | when last export finished |
| `shareAvailable` | boolean \| null | from expo-sharing |
| `shareHint` | string \| null | reason share is unavailable |
| `chartsMode` | boolean | dashboard mode toggle |
| `debugOverlayEnabled` | boolean | settings toggle |
| `lastFilterReason` | string \| null | most recent filter_reason |
| `healthLegacyPoints` | number | COUNT(*) from `gps_point` |
| `healthV1Points` | number | COUNT(*) from `gps_points` |
| `healthStopEvents` | number | COUNT(*) from `stop_events` |
| `healthAuditLines` | number | lines in `r503_tracking_audit.log` |
| `healthLastWriteIso` | string \| null | most recent gps_points.ts |
| `healthLastWriteMs` | number \| null | epoch ms version |
| `healthAuditPath` | string \| null | full path to audit log |
| `lastError` | string \| null | last user-facing error |
| `logs` | string[] | in-memory log buffer, max 200, newest first |
| `dbReady` | boolean | DB initialization flag |
| `foregroundPermissionGranted` | boolean \| null | from Location |
| `backgroundPermissionGranted` | boolean \| null | from Location |
| `locationServicesEnabled` | boolean \| null | from Location |
| `batteryOptimizationWhitelisted` | boolean \| null | from native module |
| `foregroundServiceActive` | boolean | true iff `hasStartedLocationUpdatesAsync` |
| `wakeLockHeld` | boolean | mirrors `activateKeepAwakeAsync` for `'r503-active-trip'` |
| `taskRestartCount` | number | mirrors trip_sessions.task_restart_count |
| `variantLabel` | string | from SENSING_CONFIG.label |
| `variantSamplingMs` | number | from SENSING_CONFIG.samplingIntervalMs |
| `variantId` | string | the EXPERIMENT_VARIANT string |
| `variantUseForegroundService` | boolean | from SENSING_CONFIG |
| `backgroundPermissionRevoked` | boolean | banner trigger |
| `lastTaskErrorAt` | number \| null | epoch ms of last task-error update |
| `lastTaskErrorMessage` | string \| null | text of last task error |
| `recoveredOrphans` | DanglingTripRecovery[] | from `finalizeDanglingTrips` |

---

## 10. Lifecycle scenarios

### 10.1 `startTrip()` — happy path

```
User taps Start
  └─ TripController.startTrip
      ├─ setState({ isBusy: true, lastError: null })
      ├─ getDb()  (idempotent)
      ├─ create new tripId (UUID v4)
      ├─ INSERT trip(...)  [legacy table]
      ├─ insertSessionMetadata({...})  [trip_sessions]
      ├─ read batteryStartLevel via expo-battery
      ├─ updateTripBatteryMetrics(start, null, null)
      ├─ build ActiveTripSession object
      ├─ saveActiveTripSession(...)  [active_trip_session.json]
      ├─ verifyBatteryWhitelist()  [native module]
      │     ├─ isIgnoringBatteryOptimizations
      │     ├─ if false and not prompted before: prompt
      │     └─ log result loudly if still false
      ├─ ensureBackgroundLocationReady()  [permission cascade]
      ├─ startBackgroundTracking()
      │     ├─ activateKeepAwakeAsync('r503-gps')
      │     └─ Location.startLocationUpdatesAsync(R503_BACKGROUND_TASK, options)
      │        └─ THIS is where the foreground service starts
      ├─ setState({ foregroundServiceActive: true, ... })
      ├─ if variant uses FG service: activateKeepAwakeAsync('r503-active-trip')
      ├─ startWatchdog(tripId)
      ├─ startNotificationUpdater()
      ├─ startBatterySampler(tripId)
      ├─ setState({ status: 'recording', ...counters reset... })
      ├─ startElapsedTimer / startHealthTimer
      └─ appendLog('Trip started: ...')
```

Time budget on a warm app: 50-150 ms. On a cold app: 1-2 s (DB migration
runs).

### 10.2 `stopTrip()` — happy path

```
User taps Stop
  └─ TripController.stopTrip
      ├─ setState({ isBusy: true })
      ├─ stopBackgroundTracking()
      │     ├─ Location.stopLocationUpdatesAsync (releases foreground service)
      │     ├─ TaskManager.unregisterTaskAsync (defensive — defineTask binding kept)
      │     └─ deactivateKeepAwake('r503-gps')
      ├─ setState({ foregroundServiceActive: false })
      ├─ deactivateKeepAwake('r503-active-trip')
      ├─ setState({ wakeLockHeld: false })
      ├─ flushPointBuffer()  [final durability]
      ├─ stopNotificationUpdater + stopBatterySampler
      ├─ clearTripNotification()
      ├─ UPDATE trip SET ended_at_ms=?, status='stopped'
      ├─ markSessionEnded(tripId, now, 'user_stop')
      │     └─ also updates max_gap_sec
      ├─ read batteryEndLevel
      ├─ updateTripBatteryMetrics(start, end, drain)
      ├─ appendLog with battery + restart count
      ├─ clearActiveTripSession()  [delete json file]
      ├─ stopElapsedTimer / stopHealthTimer / stopWatchdog
      ├─ refreshTrackingHealth (final counts)
      └─ setState({ status: 'stopped', isBusy: false })
```

### 10.3 `startTrip()` — failure rollback

If anything between the `INSERT trip` and the successful background tracking
start throws (e.g. permission denied, location services off), the catch
block:

1. Calls `safeBackgroundCleanup()` (stops tracking, clears session, releases
   wake lock, stops timers).
2. UPDATE `trip` SET `status='start_failed'`.
3. **`markSessionEnded(tripId, now, 'start_failed')`** — closes the
   `trip_sessions` row immediately so the next bootstrap's
   `finalizeDanglingTrips` doesn't have to clean it up.
4. Sets `state.lastError` with the user-facing message.
5. Calls `clearTripNotification()`.

The user sees the error in TripScreen's "Last Error" line plus an idle
state with the Start button re-enabled.

### 10.4 Crash recovery on next launch

If the OS killed the app process mid-trip:

```
App relaunches
  └─ AppTabs renders → TripScreen renders
       └─ useTripState() → tripController.subscribe + tripController.getState()
                                ^
                                |
            Note: TripController was already constructed during the
            import of useTripState (it's a module-scope singleton).
            Its constructor ran void bootstrap() asynchronously.

  └─ TripController.bootstrap (running in parallel):
      ├─ getDb()
      ├─ setState({ dbReady: true })
      ├─ loadSettings()
      ├─ loadActiveTripSession()  [reads JSON file]
      │     └─ session is non-null if there was a recording trip
      ├─ finalizeDanglingTrips(session?.tripId)  [closes orphans NOT matching session]
      │     └─ if any: setState({ recoveredOrphans }) + log
      ├─ refreshSystemStatus()
      ├─ startSystemStatusTimer()
      ├─ recoverActiveTrip()
      │     ├─ if no session: return
      │     ├─ SELECT trip WHERE trip_id = session.tripId
      │     ├─ if !trip || trip.status != 'recording': safeBackgroundCleanup + return
      │     ├─ loadStops (for direction)
      │     ├─ loadTripSnapshot (counts, latest fix)
      │     ├─ setState({ status: 'recording', tripId, ...snapshot... })
      │     ├─ startElapsedTimer / startHealthTimer
      │     ├─ refreshTrackingHealth (one-shot)
      │     ├─ isBackgroundTrackingRunning?
      │     │    └─ no: startBackgroundTracking() (we are foreground, so allowed)
      │     ├─ setState({ foregroundServiceActive: true })
      │     ├─ activateKeepAwakeAsync('r503-active-trip') (re-acquire)
      │     ├─ setState({ wakeLockHeld: true })
      │     ├─ startWatchdog / startNotificationUpdater / startBatterySampler
      │     └─ appendLog('Recovered trip and restarted background tracking')
      └─ registerBackgroundWatchdog()
```

Net effect: the user sees a brief loading state, then the dashboard pops
back into "recording" with the same trip id and counters intact. GPS
resumes within a few seconds.

### 10.5 The bad scenario: backgrounded for 20+ min, OS kills service

```
0:00 - User taps Start, backgrounds the app.
0:02 - Foreground service active, GPS callbacks flow.
8:00 - Phone enters Doze (screen off + unplugged for ~5min).
10:30 - OS kills the foreground service (App Standby + Doze maintenance window).
        Our defineTask body would have received taskBody.error but the JS context
        is suspended — the callback may not even fire.
11:00 - BackgroundFetch watchdog wakes up (its own ~15min schedule).
        - sees the trip_sessions row has ended_at IS NULL
        - sees MAX(gps_points.timestamp_ms) is older than threshold
        - tries to restart but app is backgrounded → audit-logs 'restart-skipped'
20:00 - User foregrounds the app.
       ├─ AppState.change fires
       ├─ refreshSystemStatus runs → foregroundServiceActive=false detected
       ├─ red banner appears: "Foreground service not running"
       ├─ resubscribeBackgroundTracking('service-death-detected') called
       │   └─ now we're foregrounded so the restart succeeds
       ├─ GPS callbacks resume
       └─ in-process watchdog detects the gap → another resubscribe (throttled out)
```

Net effect: 10-20 minutes of lost GPS, but recovery on foreground is
immediate and the UI surfaces the failure rather than hiding it.

**This is the constraint we cannot work around in software.** See §11.

---

## 11. Operating-system constraints (the hard truths)

### 11.1 Foreground service start restriction (Android 12+)

`startForegroundService()` from a background context throws
`ForegroundServiceStartNotAllowedException`. `expo-location`'s
`startLocationUpdatesAsync` with a `foregroundService` config does exactly
this. **Therefore: a foreground service cannot be restarted while the app
is backgrounded.**

Our code respects this in three places:

- `backgroundLocationTask.resubscribeGPS` checks `AppState.currentState`
  and bails if not active.
- `backgroundWatchdogTask` same check.
- The recovery path **never** calls `stopLocationUpdatesAsync` from a
  context that can't restart it.

Prior to this fix, the audit log from your test trip showed ~30 occurrences
of this exception per trip. Every one was a wasted recovery attempt that
made things worse by destroying the running service.

### 11.2 Doze mode

After ~30 min of screen-off + unplugged + stationary, Android enters Doze.
In Doze:
- Wake locks are suppressed.
- Network access is suspended.
- AlarmManager wake-ups are batched into maintenance windows.
- Location updates are deferred unless the app holds an active foreground
  service of type `location` AND the user has whitelisted it from battery
  optimizations.

For long bus rides where the device is stationary (sitting in a pocket),
Doze can trigger after 30 min. Our `expo-keep-awake` wake lock SHOULD
prevent CPU suspension, but Doze can override it. Battery optimization
whitelisting is the only reliable mitigation.

### 11.3 App Standby Buckets (Android 9+)

Apps the user hasn't interacted with recently get demoted to lower buckets
(active → working set → frequent → rare → restricted). Lower buckets get:
- Throttled job execution
- Reduced foreground service runtime
- Limited network access

For a single-purpose data collection app, this is hostile. The mitigation
is the same: battery optimization whitelist + frequent foreground use.

### 11.4 Behavior on Motorola MyUX (Moto G54 5G)

Moto MyUX is near-stock Android with the following specifics:

- **Battery optimization** is on by default for every app. Whitelisting via
  our prompt is reliable.
- **Background Activity** per-app toggle in Settings → Apps → R503 Logger
  → Battery — can be set to:
  - `Unrestricted` (the one we want)
  - `Optimized` (default, throttles background work)
  - `Restricted` (kills background entirely)
  Our code can detect "Battery optimization whitelisted" but cannot detect
  the Background Activity mode directly — there's no public API.
- **Adaptive Battery** — Moto's ML-based predictor of which apps to
  throttle. Disable globally for testing, OR use the app frequently
  enough that it stays in the active bucket.
- **Doze** behaves per AOSP spec.

There is NO autostart manager equivalent to MIUI/EMUI on Moto. The path
to a reliable trip is simpler than on a Xiaomi device but still requires
the two settings actions in §12.

### 11.5 Process kill scenarios

The OS will kill the app process under:
- Memory pressure (LMK) — foreground services with type=location are
  near-immune to this.
- User swipe from recents — depends on `killServiceOnDestroy` in our
  notification config (we set it `false`, so the service survives).
- Force stop via system settings — service dies, recovery requires
  manual relaunch.
- Reboot — service dies; we don't have a boot receiver so trips don't
  resume automatically.

Recovery semantics for each are described in §10.4.

---

## 12. Moto G54 5G specific troubleshooting

For your defense and ongoing collection, do this exactly:

**Mandatory settings on the device:**

1. **Settings → Apps → See all apps → R503 Logger → Battery → Unrestricted**
   This is the most important setting on Moto. It overrides background
   activity restrictions.

2. **Settings → Battery → Battery optimization → R503 Logger → Don't optimize**
   This is what our `verifyBatteryWhitelist()` checks. The in-app prompt
   triggers the dialog, but you can also do it manually.

3. **Settings → Location → make sure "Use location" is on; the R503 Logger
   permission is "Allow all the time".** "Allow only while using the app"
   will block background tracking after a few minutes.

4. **Settings → Battery → Adaptive Battery → off** (optional but reduces
   variability during data collection sessions).

5. **Open the app every 30-60 minutes** if possible. AppState resume
   triggers the recovery hook, and using the app keeps it in the active
   App Standby bucket.

**Diagnostics during a trip:**

- Open the **Logs tab** — controller log shows the controller's view,
  audit log shows what the background task is actually doing.
- Open the **Trip tab** — the System card has live status indicators.
  Watch for:
  - "Foreground service" turning red (service died)
  - "Task restarts" climbing (OS is killing the service repeatedly)
  - "Last GPS" age exceeding 30 s (gap forming)

**If you see a red banner during a trip:**

| banner | what to do |
|---|---|
| "Background task error" | Open Logs, look at the latest audit entry. Usually self-recovers within 30 s; if not, Stop and Start again. |
| "Background location revoked" | Re-grant "Allow all the time" via system settings. |
| "Foreground service not running" | Stop and Start again. (You must be in the app — the recovery only works from foreground.) |
| "OS throttling background service" | Mid-trip not much you can do. After the trip, follow the mandatory settings above. |

---

## 13. Build and deploy workflow

### 13.1 Dev build (USB-attached device)

```
cd app
npx expo install   # one-time, ensures version compat
npx expo prebuild --clean   # regenerates android/ from app.json
cd android
./gradlew.bat installDebug   # installs to attached device
```

The dev build pulls JS from a Metro bundler started by
`npx expo start --dev-client`.

### 13.2 Production-style local APK

```
cd app
npx expo prebuild --clean
cd android
./gradlew.bat assembleRelease
# APK at android/app/build/outputs/apk/release/app-release.apk
```

This is a "production-shaped" build but unsigned. Sufficient for field
testing on your own device.

### 13.3 EAS Build (one APK per variant)

```
cd app
eas build -p android --profile exp-high
eas build -p android --profile exp-medium
eas build -p android --profile exp-low
eas build -p android --profile exp-bg-degraded
```

Each profile sets a different `EXPERIMENT_VARIANT` env var. Output is a
downloadable APK with the matching variant baked in.

### 13.4 What requires a native rebuild

Any change that touches:
- `app.json` (permissions, plugins config)
- `android/` Kotlin files
- The set of installed `expo-*` packages

…requires `npx expo prebuild --clean` + a fresh `./gradlew.bat assembleRelease`.

Pure JS/TS changes (under `app/`, excluding `app/android/`) hot-reload
in dev mode and ship via Metro in dev builds; for release APKs they
require a rebuild but no `prebuild --clean`.

---

## 14. Export bundle contents

ZIP layout (built by
[`exportTripBundle`](app/src/services/export/exportBundle.ts)):

```
r503_trip_{safe_trip_id}_{timestamp}/
├── trip_sessions.csv       ← single row, the canonical session
├── trip.csv                ← legacy table row
├── gps_points.csv          ← every callback (filtered + kept)
├── stop_events.csv         ← arrive/dwell/exit
├── segment_times.csv       ← derived stop-to-stop segments
├── stops.csv               ← R503 route reference data
├── battery_samples.csv     ← 5-min battery snapshots
├── metadata.json           ← bundle version + sensing config + counts
├── recovery_metadata.json  ← any orphan trips auto-finalized
├── tracking_audit.log      ← full audit log (JSON-lines)
├── bundle.json             ← combined dump for one-shot ingestion
└── r503_trip_{safe_id}.zip ← the ZIP itself (in this dir)
```

The CSV column set is the full set of columns from each table, with
extras added during export:

- `gps_points.csv` extras: `timestamp_iso`, `elapsed_sec` (from start),
  `inter_point_gap_sec`.
- `stop_events.csv` extras: `timestamp_iso`, normalized `event_type`
  (legacy values mapped to canonical names).
- `segment_times.csv` extras: `time_bucket`, `day_of_week`, `is_peak`.

`metadata.json` schema:

```json
{
  "bundle_version": 2,
  "trip_id": "uuid",
  "device_id": "uuid",
  "app_version": "1.0.0-v1.0",
  "experiment_variant": "medium",
  "sensing_label": "MEDIUM-FREQ",
  "sampling_interval_ms": 5000,
  "write_buffer_size": 1,
  "geofence_enter_m": 40,
  "geofence_exit_m": 60,
  "dwell_ms": 5000,
  "use_foreground_service": true,
  "battery_start_pct": 67,
  "battery_end_pct": 56,
  "battery_drain_pct": 11,
  "max_gap_sec": 1265.653,
  "task_restart_count": 28,
  "started_at": "2026-05-13T05:02:00.458Z",
  "ended_at": "2026-05-13T06:09:26.410Z",
  "duration_sec": 4046,
  "total_gps_points": 226,
  "filtered_gps_points": 75,
  "stop_events_count": 0,
  "segments_count": 0,
  "schema_version": 7
}
```

`recovery_metadata.json` schema:

```json
{
  "orphan_recoveries": [
    {
      "trip_id": "uuid",
      "started_at": "ISO",
      "ended_at": "ISO",
      "ended_reason": "auto_finalized_orphan"
    }
  ]
}
```

`bundle.json` contains the full denormalized dump (all CSVs as JSON
arrays) plus the metadata.

---

## 15. Glossary

| term | meaning |
|---|---|
| **Variant** | One of the four build profiles (high / medium / low / bg-degraded) controlling sampling rate and behavior. |
| **`SENSING_CONFIG`** | The resolved variant configuration object available at runtime. |
| **`R503_BACKGROUND_TASK`** | The TaskManager task id for the GPS callback (`'R503_BACKGROUND_LOCATION_TASK'`). |
| **`R503_BACKGROUND_WATCHDOG_TASK`** | The TaskManager task id for the BackgroundFetch watchdog. |
| **Foreground service** | Android service with a sticky notification, exempt from many background restrictions. Started by `expo-location` when `foregroundService` is in its config. |
| **Wake lock** | A request to the OS to keep the CPU running. We hold `r503-gps` (for the background task) and `r503-active-trip` (for the duration of a trip). Released on stop. |
| **Doze** | Android battery optimization mode after ~30 min of screen-off + stationary + unplugged. Heavily restricts background work. |
| **App Standby Buckets** | Per-app priority categories that govern how much background work the app gets. |
| **Trip session** | One row in `trip_sessions`, identified by `trip_id` (UUID). One per trip. |
| **Active trip session** | The contents of `active_trip_session.json` on disk, denoting the currently-recording trip. |
| **Orphan trip** | A `trip_sessions` row with `ended_at IS NULL` that no longer has a matching active-trip JSON file. Caused by app force-kill. Cleaned up at next launch by `finalizeDanglingTrips`. |
| **Filtered point** | A `gps_points` row with `is_filtered=1`. Retained for audit but excluded from metrics. |
| **Smoothed coords** | EMA-smoothed lat/lon (α=0.3). Used by stop detection. |
| **Geofence (enter/exit) radius** | The two distances used for stop detection hysteresis. Per-variant in `SENSING_CONFIG`. |
| **Dwell time** | Duration the bus must remain inside the enter radius for an `arrive` to escalate to `dwell`. |
| **Segment** | A `segment_times` row representing the trip between two consecutive (or skip-stop adjacent) stops. |
| **`task_restart_count`** | The number of times the background task was unexpectedly restarted during a trip. High values indicate OS killing the service. |
| **Audit log** | `r503_tracking_audit.log` — append-only JSON-lines log written by all modules. The source of truth for post-trip debugging. |
| **Bundle** | The export ZIP produced by `exportTripBundle`. |

---

## Appendix A — Full SQL query catalog

Every query executed at runtime, by file, in order of importance:

### A.1 [`src/db/queries.ts`](app/src/db/queries.ts)

```sql
-- ensureDeviceRegistered
SELECT COUNT(*) as count FROM devices WHERE device_id = ?
INSERT INTO devices (device_id, created_at, platform, os_version, model) VALUES (?, ?, ?, ?, ?)

-- insertSessionMetadata
INSERT OR IGNORE INTO trip_sessions
  (trip_id, device_id, variant_id, started_at, ended_at, timezone, app_version,
   time_bucket, notes, experiment_variant, task_restart_count)
VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)

-- markSessionEnded
UPDATE trip_sessions
  SET ended_at = ?, ended_reason = COALESCE(?, ended_reason)
WHERE trip_id = ?

-- finalizeDanglingTrips
SELECT trip_id, started_at FROM trip_sessions WHERE ended_at IS NULL
SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?
SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?
UPDATE trip SET ended_at_ms = COALESCE(ended_at_ms, ?), status='stopped'
  WHERE trip_id = ? AND (status IS NULL OR status != 'stopped')

-- loadStopsForVariant
SELECT stop_id as stopId, stop_order as stopOrder, name, lat, lng, radius_m as radiusM
FROM stops WHERE variant_id = ? ORDER BY stop_order ASC

-- persistPoint → insertPointNow (INSIDE transaction)
INSERT INTO gps_points (...)  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- updateTripBatteryMetrics
UPDATE trip_sessions
  SET battery_start_pct = COALESCE(?, battery_start_pct),
      battery_end_pct   = COALESCE(?, battery_end_pct),
      battery_drain_pct = COALESCE(?, battery_drain_pct)
WHERE trip_id = ?

-- updateTripMaxGapSec
SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC
UPDATE trip_sessions SET max_gap_sec = ? WHERE trip_id = ?

-- updateTripTaskRestartCount
UPDATE trip_sessions SET task_restart_count = ? WHERE trip_id = ?

-- persistStopEvent
SELECT COUNT(*) as count FROM stop_events
  WHERE trip_id = ? AND stop_id = ? AND event_type = ?
SELECT event_type, timestamp_ms, ts FROM stop_events
  WHERE trip_id = ? AND stop_id = ?
  ORDER BY COALESCE(timestamp_ms, CAST(strftime('%s', ts) AS INTEGER) * 1000) DESC LIMIT 1
INSERT INTO stop_events (event_id, trip_id, stop_id, event_type, timestamp_ms,
                          ts, dist_m, dist_to_stop_m, lat, lon, speed_mps, accuracy_m)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- rebuildSegmentsForTrip
SELECT s.stop_id, s.stop_order FROM stops s
  INNER JOIN trip_sessions t ON t.variant_id = s.variant_id
  WHERE t.trip_id = ?
SELECT stop_id, event_type, timestamp_ms, ts FROM stop_events WHERE trip_id = ? ORDER BY ...
DELETE FROM segment_times WHERE trip_id = ?
INSERT INTO segment_times (...) VALUES (...)

-- computeSegmentMetrics
SELECT timestamp_ms, smoothed_lat, smoothed_lon, lat, lon, speed_mps, derived_speed_mps, accuracy_m
FROM gps_points WHERE trip_id = ? AND is_filtered = 0
                AND timestamp_ms >= ? AND timestamp_ms <= ?
ORDER BY timestamp_ms ASC

-- loadTripDebug
SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?
SELECT COUNT(*) as count FROM segment_times WHERE trip_id = ?
SELECT filter_reason FROM gps_points
  WHERE trip_id = ? AND is_filtered = 1
  ORDER BY timestamp_ms DESC LIMIT 1

-- loadTrackingHealth
SELECT COUNT(*) as count FROM gps_point WHERE trip_id = ?
SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?
SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?
SELECT timestamp_ms FROM gps_point WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1
SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1

-- loadExportMetadata
SELECT schema_version FROM schema_meta LIMIT 1
SELECT app_version, device_id, variant_id, experiment_variant, task_restart_count,
       battery_start_pct, battery_end_pct, battery_drain_pct, max_gap_sec
FROM trip_sessions WHERE trip_id = ?

-- insertBatterySample
INSERT INTO battery_samples (trip_id, timestamp_ms, level_pct) VALUES (?, ?, ?)
```

### A.2 [`trip/backgroundLocationTask.ts`](app/trip/backgroundLocationTask.ts)

```sql
-- insertGPSPoint: look-up previous point
SELECT timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg, is_filtered,
       smoothed_lat, smoothed_lon, smoothed_speed_mps
FROM gps_points
WHERE trip_id = ?
ORDER BY timestamp_ms DESC LIMIT 1

-- insertGPSPoint: look-up previous valid point (for derived speed/heading)
SELECT ... FROM gps_points
WHERE trip_id = ? AND (is_filtered = 0 OR filter_reason = 'post-gap-reset')
                  AND timestamp_ms < ?
ORDER BY timestamp_ms DESC LIMIT 1

-- runStopDetection: load nearest and target stop state machine cache
SELECT state, entered_at_ms, dwell_at_ms, exit_candidate_count
FROM stop_states WHERE trip_id = ? AND stop_id = ?

-- runStopDetection: list active states
SELECT stop_id, state FROM stop_states WHERE trip_id = ?

-- runStopDetection: skip-stop write
INSERT INTO stop_states (trip_id, stop_id, state, ...) VALUES (...)
  ON CONFLICT(trip_id, stop_id) DO UPDATE SET state='EXITED', updated_at_ms=excluded.updated_at_ms

-- runStopDetection: state update
INSERT INTO stop_states (...) VALUES (...)
  ON CONFLICT(trip_id, stop_id) DO UPDATE SET state=excluded.state, ...

-- incrementTripRestartCount
UPDATE trip_sessions
  SET task_restart_count = COALESCE(task_restart_count, 0) + 1
WHERE trip_id = ?
```

### A.3 [`trip/TripController.ts`](app/trip/TripController.ts)

```sql
-- startTrip: insert legacy trip row
INSERT INTO trip (trip_id, started_at_ms, ended_at_ms, route_number,
                  direction_code, window_code, status)
VALUES (?, ?, NULL, ?, ?, ?, ?)

-- startTrip rollback
UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?

-- stopTrip: close legacy + session
UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?

-- stopTrip: query battery_start
SELECT battery_start_pct FROM trip_sessions WHERE trip_id = ?

-- stopTrip: query restart count
SELECT task_restart_count FROM trip_sessions WHERE trip_id = ?

-- recoverActiveTrip: lookup trip row
SELECT * FROM trip WHERE trip_id = ?

-- loadTripSnapshot
SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?
SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?
SELECT COUNT(*) as count FROM segment_times WHERE trip_id = ?
SELECT timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg
  FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1
SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC LIMIT 1
SELECT lat, lon FROM gps_points WHERE trip_id = ? AND is_filtered = 0 ORDER BY timestamp_ms ASC

-- loadStops (legacy table for back-compat)
SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code
FROM stop WHERE direction_code = ? ORDER BY stop_sequence ASC

-- watchdog: latest point
SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?

-- refreshTrackingHealth (in addition to loadTrackingHealth above)
SELECT task_restart_count FROM trip_sessions WHERE trip_id = ?

-- exportTrip (legacy JSON dump)
SELECT * FROM trip WHERE trip_id = ?
SELECT * FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC
SELECT * FROM stop_events WHERE trip_id = ? ORDER BY timestamp_ms ASC
SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC
SELECT * FROM trip_sessions WHERE trip_id = ?
SELECT * FROM stops ORDER BY variant_id ASC, stop_order ASC
```

### A.4 [`trip/backgroundWatchdogTask.ts`](app/trip/backgroundWatchdogTask.ts)

```sql
SELECT ended_at FROM trip_sessions WHERE trip_id = ?
SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?
UPDATE trip_sessions
  SET task_restart_count = COALESCE(task_restart_count, 0) + 1
WHERE trip_id = ?
```

### A.5 [`src/services/export/exportBundle.ts`](app/src/services/export/exportBundle.ts)

```sql
SELECT trip_id FROM trip_sessions WHERE trip_id = ?
SELECT * FROM trip_sessions WHERE trip_id = ?
SELECT * FROM trip WHERE trip_id = ?
SELECT * FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC
SELECT * FROM stop_events WHERE trip_id = ? ORDER BY timestamp_ms ASC
SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC
SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code
  FROM stop ORDER BY stop_sequence ASC
SELECT id, trip_id, timestamp_ms, level_pct
  FROM battery_samples WHERE trip_id = ? ORDER BY timestamp_ms ASC
SELECT trip_id, started_at, ended_at, ended_reason
  FROM trip_sessions WHERE ended_reason = 'auto_finalized_orphan'
  ORDER BY started_at DESC
```

---

**End of document.** Last updated 2026-05-13.
