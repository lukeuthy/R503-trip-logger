# R503 Logger (Testing) - v0.2

Offline-first Expo React Native + TypeScript app for real-world R503 trip logging.

## What v0.2 does

- Background GPS logging using `expo-location` + `expo-task-manager`.
- Foreground service notification while tracking in Android background.
- Auto-recovery of active trip after app restart.
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
- Share export through `expo-sharing` when available.
- UI telemetry panel:
  - trip status, point/event counters
  - last GPS fix (lat/lon/accuracy/speed/heading)
  - nearest stop + inside/outside state
  - export result, errors, and recent logs

## App identity

- Display name: `R503 Logger (Testing)`
- Android package: `com.jaja.r503logger.testing`

## Prerequisites

- Node.js `>= 20.19.4`
- Android phone (real device recommended)
- USB debugging enabled
- `adb` installed (`adb devices` should detect your phone)

## Dev run (uses Metro)

```bash
cd app
npm install
npx expo start
```

Use this for development only.

## Standalone install on phone (no Metro at runtime)

For a standalone app that works without Metro, install a **release** build (not Expo Go and not a debug dev-client build).

### Option A: EAS APK (recommended if you have EAS account/project)

1. In `app`, create `eas.json` if missing:

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

2. Build:

```bash
cd app
npx eas login
npx eas build -p android --profile preview
```

3. Download the APK from the EAS build page and install on phone.

### Option B: Local release APK (no EAS cloud build)

```bash
cd app
npx expo prebuild --clean
cd android
.\gradlew.bat assembleRelease
```

APK output:

- `app/android/app/build/outputs/apk/release/app-release.apk`

Install:

```bash
adb install -r app-release.apk
```

If there is a package conflict:

```bash
adb uninstall com.jaja.r503logger.testing
adb install app-release.apk
```

## Field workflow

1. Open app.
2. Choose `Direction` (`A` or `B`) and `Service Window` (`AM`, `PM`, `OFF`).
3. Tap `Start Trip`.
4. Keep GPS enabled; app can continue recording in background in v0.2.
5. At trip end, tap `Stop Trip`.
6. Tap `Export JSON`.
7. Tap `Share Export` and send to Drive/Gmail/Messenger/etc.

Export filename format:
- `r503_trip_<trip_id>.json`

## Important Android settings for reliable background logging

- Grant:
  - Foreground location
  - Background location (`Allow all the time`)
- Exclude app from battery optimization if your phone kills background services aggressively.
- Keep location services on.

## Troubleshooting

- `Background location permission denied`:
  - In Android settings, set app location to `Allow all the time`.
- Tracking stops when app is swiped away:
  - Disable battery optimization for this app.
- `Share Export` not shown:
  - Reinstall standalone build (Expo Go can behave differently for sharing).
- Low/unstable GPS accuracy:
  - Move to open sky and wait for accuracy to settle before trip start.
