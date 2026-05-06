# R503 Trip Logger - v1.0

Offline-first Expo React Native app for collecting trip and stop-level bus travel data on route `R503` (thesis data collection for ETA modeling).

## What v1.0 includes

- Android-first trip session logging with background location tracking.
- Start/stop-only operator workflow (minimal manual input).
- Auto-captured session metadata at trip start:
  - `trip_id (run_id UUID)`
  - `device_id` (persisted local UUID)
  - route and variant metadata
  - app version, timezone, OS/platform context
  - time bucket (for AM/PM grouping)
- Raw GPS + filtered/smoothed GPS storage for auditability.
- Offline stop detection (sequence-aware geofence-style arrive/depart events).
- Segment-time derivation between consecutive stops.
- Dark glassmorphism dashboard UI with:
  - visualization mode (mini charts)
  - text/table mode
  - debug overlay toggle
- Export pipeline:
  - `trip_sessions.csv`
  - `gps_points.csv`
  - `stop_events.csv`
  - `segment_times.csv`
  - `metadata.json`
  - `bundle.json`
  - `bundle.zip` (share-ready)

## Data collection workflow

1. Open app on phone.
2. Go to `Trip` tab, choose direction/window.
3. Tap `Start Trip`.
4. App logs continuously in foreground/background (offline).
5. Stop detection and segment derivation happen on-device.
6. Tap `Stop Trip` at run end.
7. Open `Export` tab and tap `Export Bundle (CSV/JSON/ZIP)`.
8. Tap `Share Export` and send to Drive/Files/Gmail/etc.

## Repository file map

Root app: `app/`

Core runtime and compatibility:
- `app/trip/TripController.ts`
- `app/trip/backgroundLocationTask.ts`
- `app/trip/activeTripStore.ts`
- `app/database/db.ts`
- `app/database/migrations.ts`
- `app/database/schema.ts`

v1.0 data and logic modules:
- `app/src/db/queries.ts`
- `app/src/services/location/filters.ts`
- `app/src/services/location/stopDetector.ts`
- `app/src/services/location/segmentBuilder.ts`
- `app/src/services/location/tracker.ts`
- `app/src/services/export/exportBundle.ts`
- `app/src/utils/settingsStore.ts`
- `app/src/utils/id.ts`

UI/theme:
- `app/src/screens/AppTabs.tsx`
- `app/src/screens/DashboardScreen.tsx`
- `app/src/screens/TripScreen.tsx`
- `app/src/screens/ExportsScreen.tsx`
- `app/src/screens/SettingsScreen.tsx`
- `app/src/components/GlassCard.tsx`
- `app/src/components/MetricTile.tsx`
- `app/src/components/MiniChart.tsx`
- `app/src/components/StopProgress.tsx`
- `app/src/theme/tokens.ts`

Route seeds:
- `app/data/r503_stops.ts`

## SQLite schema (v1.0 additions)

Added normalized tables (without dropping legacy tables):

- `schema_meta`
- `devices`
- `routes`
- `route_variants`
- `stops`
- `trip_sessions`
- `gps_points`
- `stop_events`
- `segment_times`

Legacy tables (`trip`, `gps_point`, `stop`, `stop_event`) are still preserved for backward compatibility.

## Export sample rows

`trip_sessions.csv`

```csv
trip_id,device_id,variant_id,started_at,ended_at,timezone,app_version,time_bucket,notes
9f3...,4ba...,r503_am,2026-03-06T08:02:12.000Z,2026-03-06T08:47:29.000Z,Asia/Taipei,1.0.0-v1.0,08-09,
```

`gps_points.csv`

```csv
point_id,trip_id,ts,lat,lng,accuracy_m,speed_mps,is_filtered,filter_reason,smoothed_lat,smoothed_lng,smoothed_speed_mps
2ab...,9f3...,2026-03-06T08:02:13.000Z,7.06094,125.55389,8.4,3.8,0,,7.06094,125.55389,3.8
```

`stop_events.csv`

```csv
event_id,trip_id,stop_id,event_type,ts,dist_to_stop_m,speed_mps,accuracy_m
7ce...,9f3...,r503_r503_am_s01,arrive,2026-03-06T08:03:11.000Z,17.6,1.2,7.1
```

`segment_times.csv`

```csv
segment_id,trip_id,from_stop_id,to_stop_id,start_ts,end_ts,travel_time_sec,distance_m,avg_speed_mps,p95_speed_mps,mean_accuracy_m
1f8...,9f3...,r503_r503_am_s01,r503_r503_am_s02,2026-03-06T08:03:45.000Z,2026-03-06T08:07:20.000Z,215,1340.1,6.2,10.5,9.8
```

## How exports are used for training + benchmarking

1. Import exported CSV files to laptop (Python/R).
2. Build feature sets by segment and time bucket:
   - segment travel time target
   - speed statistics
   - accuracy quality metrics
   - AM/PM and peak bucket flags
3. Train ETA models offline (no app-side ML required).
4. Benchmark with MAE/RMSE/MAPE by segment and time-of-day.
5. Iterate route/stop detection parameters, recollect, retrain.

## Run and verify locally

This app should be run in a development build or standalone APK, not Expo Go. Expo Go QR codes are unreliable for this project because the app depends on Android background location / foreground service behavior and native configuration generated at build time.

```bash
cd app
npm install
npm run typecheck
npm run start:dev
```

After installing a development build on the phone, scan the QR from `npm run start:dev` with the installed R503 Logger development app. Do not scan it with Expo Go.

If you only need to inspect the UI in Expo Go, you can try:

```bash
cd app
npm run start:go
```

Expo Go should not be used for actual trip collection.

### First-time development build

Use this once per native config change, then keep using `npm run start:dev` for JavaScript changes:

```bash
cd app
npx expo run:android
```

If LAN QR scanning fails, start Metro in tunnel mode:

```bash
cd app
npx expo start --dev-client --tunnel
```

## Build APK (standalone, no Metro at runtime)

### EAS Build (recommended)

1. Install EAS CLI and configure:

```bash
npm install -g eas-cli
cd app
eas login
eas build:configure
```

2. Ensure `eas.json` contains APK profile:

```json
{
  "build": {
    "preview": {
      "android": {
        "buildType": "apk"
      }
    }
  }
}
```

3. Build:

```bash
cd app
eas build -p android --profile preview
```

4. Download APK from EAS build page and install on phone.

### Local APK build (Windows)

```powershell
cd app
npx expo prebuild --clean
cd android
.\gradlew.bat assembleRelease
adb install -r app\build\outputs\apk\release\app-release.apk
```

## Notes and constraints

- No cloud sync/login/server is used.
- All critical logging and stop detection runs offline.
- Grant background location permission and disable aggressive battery optimization for best field reliability.
