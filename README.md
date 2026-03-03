# R503 Logger (Testing) - v0.1

Offline-first Expo React Native + TypeScript prototype for real-world R503 trip logging.

## What v0.1 does

- Foreground GPS logging using `expo-location` (no background tracking yet).
- Local SQLite storage using `expo-sqlite`:
  - `trip`
  - `gps_point`
  - `stop`
  - `stop_event`
- Stop detection (nearest-stop + hysteresis + dwell):
  - `ENTER` at `<= 35m`
  - `DWELL_CONFIRMED` after `>= 10s` while still `<= 35m`
  - `EXIT` at `>= 60m`
- JSON export to `FileSystem.documentDirectory` using `expo-file-system`.
- Optional share action using dynamic import of `expo-sharing` (no crash if unavailable).
- Minimal UI with live telemetry + visible status + error + log panel.

## Prerequisites

- Node.js `>= 20.19.4` (recommended for current Expo CLI/tooling).
- Android phone with:
  - Developer Options enabled
  - USB debugging enabled
  - `adb` installed on laptop (`adb devices` should list your phone).

## Run quickly in Expo Go

1. Install dependencies:

```bash
cd app
npm install
```

2. Start dev server:

```bash
npx expo start
```

3. Scan QR with Expo Go on Android.

Notes:
- Works for logging + export JSON.
- `expo-sharing` can be unavailable in Expo Go/runtime combinations. If share is unavailable, use USB file transfer.

## Install as standalone "Testing" app on Android (Dev Build)

App identity is set to:
- Display name: `R503 Logger (Testing)`
- Package: `com.jaja.r503logger.testing`

Steps:

```bash
cd app
npx expo prebuild --clean
npx expo run:android --device
```

If package conflict happens (old install present):

```bash
adb uninstall com.jaja.r503logger.testing
```

Then rerun `npx expo run:android --device`.

## Build APK for sideload (no Play Store)

### Option A: EAS preview build

```bash
cd app
npx eas build -p android --profile preview
```

Use this when EAS is configured in the project/account.

### Option B: Local debug APK (fallback)

```bash
cd app
npx expo prebuild
cd android
./gradlew assembleDebug
```

APK output path:

- `app/android/app/build/outputs/apk/debug/app-debug.apk`

Install:

```bash
adb install -r app-debug.apk
```

## Bus data collection workflow

1. Open app.
2. Confirm route is `R503`.
3. Select `Direction` (A/B) and `Service Window` (AM/PM/OFF).
4. At terminal/start point, tap `Start Trip`.
5. Keep app open in foreground during trip (v0.1 is foreground-only).
6. At trip end, tap `Stop Trip`.
7. Tap `Export JSON`.
8. If `Share Export` is shown, share immediately; otherwise transfer by USB later.

## Transfer exports to laptop

- Connect phone via USB and enable File Transfer (MTP).
- Export files are written under Expo app document storage (`documentDirectory`).
- Export filename format:
  - `r503_trip_<trip_id>.json`
- Copy JSON files to laptop (daily or weekly batch is fine).

## Troubleshooting

- Permission denied:
  - Allow foreground location permission in Android app settings.
- Location services off:
  - Turn on GPS/location services before starting trip.
- Emulator vs real phone:
  - Use a real phone for field tests; emulator GPS is not representative.
- Low/unstable accuracy:
  - Move to open sky when possible.
  - Wait for accuracy to settle before starting trip.
  - Keep phone away from dense metal enclosures.

## v0.2 note (planned)

- Background tracking and task-based capture are intentionally out-of-scope for v0.1.
- v0.2 can add reliable background logging with explicit battery/permission handling.
