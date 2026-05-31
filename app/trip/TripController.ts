import * as FileSystem from 'expo-file-system/legacy';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import { getDb, isDbInitialized } from '../database/db';
import type { TripRow, DirectionCode, WindowCode } from '../models/Trip';
import { exportTripBundle } from '../src/services/export/exportBundle';
import { haversineMeters } from '../src/services/location/filters';
import { getAuditStats } from '../src/services/location/fileAudit';
import { createInitialStopDetectionState } from '../src/services/location/stopDetector';
import { createUuidV4 } from '../src/utils/id';
import { loadSettings, saveSettings } from '../src/utils/settingsStore';
import { isSharingAvailable, tryShareFile } from '../utils/share';
import type { ActiveTripSession } from './activeTripStore';
import { clearActiveTripSession, loadActiveTripSession, saveActiveTripSession } from './activeTripStore';
import {
  ensureBackgroundLocationReady,
  initBackgroundGeolocation,
  isBackgroundTrackingRunning,
  registerRNBGHeadlessTask,
  setTripUpdateListener,
  startBackgroundTracking,
  restartBackgroundTracking,
  stopBackgroundTracking,
  type BackgroundTripUpdate,
} from './backgroundLocationTask';
import { registerBackgroundWatchdog } from './backgroundWatchdogTask';
import { clearTripNotification, publishTripNotification } from './tripNotification';
import { createInitialStopDetectorState, getStopDetectionConfig } from './stopDetector';
import {
  type DanglingTripRecovery,
  finalizeDanglingTrips,
  flushPointBuffer,
  insertBatterySample,
  insertSessionMetadata,
  loadTrackingHealth,
  loadTripDebug,
  markSessionEnded,
  resolveVariantId,
  updateTripBatteryMetrics,
} from '../src/db/queries';
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from '../src/services/android/batteryOptimization';
import { SENSING_CONFIG, VARIANT } from '../src/utils/experimentConfig';

const APP_VERSION = '1.0.0-v1.0';
const MAX_LOG_LINES = 200;
const NOTIFICATION_UPDATE_INTERVAL_MS = 10_000;
const BATTERY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const SYSTEM_STATUS_REFRESH_INTERVAL_MS = 5_000;

function getWatchdogThresholdMs(): number {
  // 6× sampling interval, clamped to [15s, 90s]. exp-high → 15s, medium → 30s, low → 60s.
  return Math.min(90_000, Math.max(15_000, SENSING_CONFIG.samplingIntervalMs * 6));
}

function getWatchdogIntervalMs(): number {
  return Math.min(30_000, Math.max(10_000, Math.floor(getWatchdogThresholdMs() / 2)));
}

export interface UITripState {
  status: 'idle' | 'recording' | 'stopped';
  isBusy: boolean;
  routeNumber: 'R503';
  windowCode: WindowCode;
  tripId: string | null;
  pointsCount: number;
  eventsCount: number;
  segmentsCount: number;
  startedAtMs: number | null;
  elapsedSeconds: number;
  totalDistanceM: number;
  avgSpeedMps: number | null;
  currentSpeedMps: number | null;
  gpsAccuracyM: number | null;
  lastFix: {
    timestampMs: number;
    timestampIso: string;
    lat: number;
    lon: number;
    accuracyM: number | null;
    speedMps: number | null;
    headingDeg: number | null;
  } | null;
  nearestStopName: string | null;
  nearestStopDistanceM: number | null;
  insideStopName: string | null;
  expectedNextStopName: string | null;
  insideState: 'INSIDE' | 'OUTSIDE';
  exportPath: string | null;
  lastExportTimestampIso: string | null;
  shareAvailable: boolean | null;
  shareHint: string | null;
  chartsMode: boolean;
  debugOverlayEnabled: boolean;
  lastFilterReason: string | null;
  healthLegacyPoints: number;
  healthV1Points: number;
  healthStopEvents: number;
  healthAuditLines: number;
  healthLastWriteIso: string | null;
  healthLastWriteMs: number | null;
  healthAuditPath: string | null;
  lastError: string | null;
  logs: string[];
  // System Status fields
  dbReady: boolean;
  foregroundPermissionGranted: boolean | null;
  backgroundPermissionGranted: boolean | null;
  locationServicesEnabled: boolean | null;
  batteryOptimizationWhitelisted: boolean | null;
  foregroundServiceActive: boolean;
  wakeLockHeld: boolean;
  taskRestartCount: number;
  variantLabel: string;
  variantSamplingMs: number;
  variantId: string;
  variantUseForegroundService: boolean;
  backgroundPermissionRevoked: boolean;
  lastTaskErrorAt: number | null;
  lastTaskErrorMessage: string | null;
  recoveredOrphans: DanglingTripRecovery[];
}

class TripController {
  private state: UITripState = {
    status: 'idle',
    isBusy: false,
    routeNumber: 'R503',
    windowCode: 'OFF',
    tripId: null,
    pointsCount: 0,
    eventsCount: 0,
    segmentsCount: 0,
    startedAtMs: null,
    elapsedSeconds: 0,
    totalDistanceM: 0,
    avgSpeedMps: null,
    currentSpeedMps: null,
    gpsAccuracyM: null,
    lastFix: null,
    nearestStopName: null,
    nearestStopDistanceM: null,
    insideStopName: null,
    expectedNextStopName: null,
    insideState: 'OUTSIDE',
    exportPath: null,
    lastExportTimestampIso: null,
    shareAvailable: null,
    shareHint: null,
    chartsMode: true,
    debugOverlayEnabled: false,
    lastFilterReason: null,
    healthLegacyPoints: 0,
    healthV1Points: 0,
    healthStopEvents: 0,
    healthAuditLines: 0,
    healthLastWriteIso: null,
    healthLastWriteMs: null,
    healthAuditPath: null,
    lastError: null,
    logs: [],
    dbReady: false,
    foregroundPermissionGranted: null,
    backgroundPermissionGranted: null,
    locationServicesEnabled: null,
    batteryOptimizationWhitelisted: null,
    foregroundServiceActive: false,
    wakeLockHeld: false,
    taskRestartCount: 0,
    variantLabel: SENSING_CONFIG.label,
    variantSamplingMs: SENSING_CONFIG.samplingIntervalMs,
    variantId: VARIANT,
    variantUseForegroundService: SENSING_CONFIG.useForegroundService,
    backgroundPermissionRevoked: false,
    lastTaskErrorAt: null,
    lastTaskErrorMessage: null,
    recoveredOrphans: [],
  };

  private listeners = new Set<(state: UITripState) => void>();
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private batteryStartPct: number | null = null;
  private taskRestartStartCount = 0;
  private appState: AppStateStatus = AppState.currentState;
  private backgroundedAtMs: number | null = null;
  private lastResubscribeAtMs = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private notificationTimer: ReturnType<typeof setInterval> | null = null;
  private batterySamplerTimer: ReturnType<typeof setInterval> | null = null;
  private systemStatusTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    setTripUpdateListener((update) => {
      this.handleBackgroundTripUpdate(update);
    });
    AppState.addEventListener('change', (nextState) => {
      void this.handleAppStateChange(nextState);
    });
    void this.bootstrap();
  }

  subscribe(listener: (state: UITripState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): UITripState {
    return this.state;
  }

  async setDebugOverlayEnabled(enabled: boolean): Promise<void> {
    await saveSettings({ debugOverlayEnabled: enabled });
    this.setState({ debugOverlayEnabled: enabled });
  }

  async setChartsMode(chartsMode: boolean): Promise<void> {
    await saveSettings({ chartsMode });
    this.setState({ chartsMode });
  }

  setWindowCode(windowCode: WindowCode): void {
    if (this.state.status === 'recording') {
      return;
    }
    this.setState({ windowCode });
  }

  async startTrip(): Promise<void> {
    if (this.state.status === 'recording' || this.state.isBusy) {
      return;
    }

    // Check whether current Manila time falls inside the selected service window.
    // Alert is shown before isBusy so the UI stays responsive during the prompt.
    const { hour, timeStr } = getManilaTime(Date.now());
    const outsideOperationalWindow = !isInsideOperationalWindow(this.state.windowCode, hour);
    if (outsideOperationalWindow) {
      const proceed = await showOutsideWindowAlert(this.state.windowCode, timeStr);
      if (!proceed) return;
    }

    this.setState({ isBusy: true, lastError: null });
    this.appendLog('Starting v1.0 trip session...');

    let tripIdForRollback: string | null = null;

    try {
      const db = await getDb();
      const startedAtMs = Date.now();
      const tripId = createUuidV4();
      tripIdForRollback = tripId;

      await db.runAsync(
        `INSERT INTO trip (trip_id, started_at_ms, ended_at_ms, route_number, direction_code, window_code, status)
         VALUES (?, ?, NULL, ?, ?, ?, ?);`,
        [tripId, startedAtMs, this.state.routeNumber, 'A', this.state.windowCode, 'recording'],
      );

      await insertSessionMetadata({
        tripId,
        directionCode: 'A',
        windowCode: this.state.windowCode,
        appVersion: APP_VERSION,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startTimestampMs: startedAtMs,
        taskRestartCount: 0,
        outsideOperationalWindow,
      });
      this.taskRestartStartCount = 0;
      const batteryStartLevel = await Battery.getBatteryLevelAsync();
      this.batteryStartPct = Number.isFinite(batteryStartLevel) ? Math.round(batteryStartLevel * 100) : null;
      await updateTripBatteryMetrics({
        tripId,
        batteryStartPct: this.batteryStartPct,
        batteryEndPct: null,
        batteryDrainPct: null,
      });

      const session: ActiveTripSession = {
        tripId,
        routeNumber: 'R503',
        directionCode: 'A',
        windowCode: this.state.windowCode,
        startedAtMs,
        variantId: resolveVariantId('A', this.state.windowCode),
        detectorState: createInitialStopDetectorState(),
        v1StopState: createInitialStopDetectionState(),
        lastFix: null,
      };
      await saveActiveTripSession(session);

      await this.verifyBatteryWhitelist();
      await ensureBackgroundLocationReady();
      await startBackgroundTracking();
      // RNBG's native foreground service acquires its own PARTIAL_WAKE_LOCK —
      // we no longer need expo-keep-awake for the bg-degraded experiment comparison.
      this.setState({
        foregroundServiceActive: SENSING_CONFIG.useForegroundService,
        // wakeLockHeld tracks RNBG's internal lock (true when FG service is active)
        wakeLockHeld: SENSING_CONFIG.useForegroundService,
        foregroundPermissionGranted: true,
        backgroundPermissionGranted: true,
        locationServicesEnabled: true,
        backgroundPermissionRevoked: false,
      });
      if (SENSING_CONFIG.useForegroundService) {
        this.appendLog('[WAKELOCK] RNBG native wake lock acquired via foreground service');
      }

      // Start watchdog (variant-tuned), notification updater, battery sampler
      this.startWatchdog(tripId);
      this.startNotificationUpdater();
      this.startBatterySampler(tripId);

      this.setState({
        status: 'recording',
        tripId,
        startedAtMs,
        elapsedSeconds: 0,
        totalDistanceM: 0,
        avgSpeedMps: null,
        currentSpeedMps: null,
        gpsAccuracyM: null,
        pointsCount: 0,
        eventsCount: 0,
        segmentsCount: 0,
        lastFix: null,
        nearestStopName: null,
        nearestStopDistanceM: null,
        insideStopName: null,
        expectedNextStopName: null,
        insideState: 'OUTSIDE',
        exportPath: null,
        lastExportTimestampIso: null,
        shareHint: null,
        lastFilterReason: null,
        healthLegacyPoints: 0,
        healthV1Points: 0,
        healthStopEvents: 0,
        healthAuditLines: 0,
        healthLastWriteIso: null,
        healthAuditPath: null,
        lastError: null,
      });

      this.startElapsedTimer();
      this.startHealthTimer();
      const shareAvailable = await isSharingAvailable();
      this.setState({ shareAvailable, isBusy: false });
      this.appendLog(`Trip started: ${tripId}`);
    } catch (error) {
      await this.safeBackgroundCleanup();

      if (tripIdForRollback) {
        try {
          const db = await getDb();
          await db.runAsync('UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?;', [
            Date.now(),
            'start_failed',
            tripIdForRollback,
          ]);
          // Atomically finalize the trip_sessions row so A1's bootstrap sweep
          // does not need to clean it up next launch.
          await markSessionEnded(tripIdForRollback, Date.now(), 'start_failed');
        } catch {
          // Keep primary failure surfaced.
        }
      }

      const message = getErrorMessage(error);
      this.stopElapsedTimer();
      this.batteryStartPct = null;
      this.setState({
        status: 'idle',
        isBusy: false,
        tripId: null,
        startedAtMs: null,
        lastError: message,
        foregroundServiceActive: false,
        wakeLockHeld: false,
      });
      this.appendLog(`Start failed: ${message}`);
      void clearTripNotification();
    }
  }

  async stopTrip(): Promise<void> {
    if (this.state.isBusy) {
      return;
    }
    if (this.state.status !== 'recording' || !this.state.tripId) {
      this.appendLog('Stop requested while not recording; ignored.');
      return;
    }

    this.setState({ isBusy: true, lastError: null });
    this.appendLog('Stopping trip...');

    try {
      await stopBackgroundTracking();
      this.setState({ foregroundServiceActive: false, wakeLockHeld: false });
      this.appendLog('[WAKELOCK] RNBG native wake lock released with foreground service');
      await flushPointBuffer();
      this.stopNotificationUpdater();
      this.stopBatterySampler();
      void clearTripNotification();

      const db = await getDb();
      const endedAtMs = Date.now();
      await db.runAsync('UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?;', [
        endedAtMs,
        'stopped',
        this.state.tripId,
      ]);
      await markSessionEnded(this.state.tripId, endedAtMs, 'user_stop');
      const batteryEndLevel = await Battery.getBatteryLevelAsync();
      const batteryEndPct = Number.isFinite(batteryEndLevel) ? Math.round(batteryEndLevel * 100) : null;
      const storedBattery = await db.getFirstAsync<{ battery_start_pct: number | null }>(
        'SELECT battery_start_pct FROM trip_sessions WHERE trip_id = ?;',
        [this.state.tripId],
      );
      const batteryStartPct = this.batteryStartPct ?? storedBattery?.battery_start_pct ?? null;
      const batteryDrainPct =
        batteryStartPct != null && batteryEndPct != null ? Math.max(0, batteryStartPct - batteryEndPct) : null;
      const restartRow = await db.getFirstAsync<{ task_restart_count: number | null }>(
        'SELECT task_restart_count FROM trip_sessions WHERE trip_id = ?;',
        [this.state.tripId],
      );
      const taskRestartCount = restartRow?.task_restart_count ?? 0;
      await updateTripBatteryMetrics({
        tripId: this.state.tripId,
        batteryStartPct,
        batteryEndPct,
        batteryDrainPct,
      });
      this.appendLog(
        `Battery drain (${SENSING_CONFIG.label}/${VARIANT}): start=${batteryStartPct ?? '-'} end=${batteryEndPct ?? '-'} drain=${batteryDrainPct ?? '-'}pp; task_restarts=${taskRestartCount}`,
      );
      await clearActiveTripSession();

      this.stopElapsedTimer();
      this.stopHealthTimer();
      this.stopWatchdog();
      await this.refreshTrackingHealth();
      this.setState({
        status: 'stopped',
        isBusy: false,
      });
      this.batteryStartPct = null;
      this.taskRestartStartCount = 0;
      this.appendLog(`Trip stopped: ${this.state.tripId}`);
    } catch (error) {
      const message = getErrorMessage(error);
      this.setState({ isBusy: false, lastError: message });
      this.appendLog(`Stop failed: ${message}`);
    }
  }

  async exportTrip(): Promise<void> {
    if (!this.state.tripId || this.state.isBusy) {
      return;
    }

    this.setState({ isBusy: true, lastError: null });
    this.appendLog('Exporting trip JSON...');

    try {
      await flushPointBuffer();
      const db = await getDb();
      const tripId = this.state.tripId;

      const trip = await db.getFirstAsync<TripRow>('SELECT * FROM trip WHERE trip_id = ?;', [tripId]);
      if (!trip) {
        throw new Error('Trip not found for export.');
      }

      const canonicalTripId = trip.trip_id;

      const gpsPointRows = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
        [canonicalTripId],
      );
      const gpsPoints = gpsPointRows.map(normalizeGpsPointRow);
      const stopEvents = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM stop_events WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
        [canonicalTripId],
      );
      const segmentTimes = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC;',
        [canonicalTripId],
      );
      const tripSessions = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM trip_sessions WHERE trip_id = ?;',
        [canonicalTripId],
      );
      const stops = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM stops ORDER BY variant_id ASC, stop_order ASC;',
      );

      const payload = {
        trip,
        gps_points: gpsPoints,
        stop_events: stopEvents,
        segment_times: segmentTimes,
        trip_sessions: tripSessions,
        stops,
        config: {
          route_number: 'R503',
          ...getStopDetectionConfig(),
        },
      };

      const baseDir = FileSystem.documentDirectory;
      if (!baseDir) {
        throw new Error('documentDirectory is unavailable.');
      }

      const safeTripId = canonicalTripId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputPath = `${baseDir}r503_trip_${safeTripId}.json`;
      await FileSystem.writeAsStringAsync(outputPath, JSON.stringify(payload, null, 2));

      const shareAvailable = await isSharingAvailable();
      this.setState({
        exportPath: outputPath,
        lastExportTimestampIso: new Date().toISOString(),
        shareAvailable,
        shareHint: shareAvailable ? null : 'Sharing unavailable in this runtime.',
        isBusy: false,
      });
      this.appendLog(`Export complete: ${outputPath}`);
    } catch (error) {
      const message = getErrorMessage(error);
      this.setState({ isBusy: false, lastError: message });
      this.appendLog(`Export failed: ${message}`);
    }
  }

  async exportBundle(): Promise<void> {
    if (!this.state.tripId || this.state.isBusy) {
      return;
    }

    this.setState({ isBusy: true, lastError: null });
    this.appendLog('Building CSV/JSON export bundle...');
    try {
      const result = await exportTripBundle(this.state.tripId);
      this.setState({
        exportPath: result.sharePath,
        lastExportTimestampIso: new Date().toISOString(),
        shareAvailable: true,
        shareHint: null,
        isBusy: false,
      });
      this.appendLog(`Bundle ready: ${result.sharePath}`);
    } catch (error) {
      const message = getErrorMessage(error);
      this.setState({ isBusy: false, lastError: message });
      this.appendLog(`Bundle export failed: ${message}`);
    }
  }

  async shareExport(): Promise<void> {
    if (!this.state.exportPath || this.state.isBusy) {
      return;
    }

    this.setState({ isBusy: true, lastError: null });
    try {
      const available = await isSharingAvailable();
      if (!available) {
        this.setState({
          isBusy: false,
          shareAvailable: false,
          shareHint: 'Sharing unavailable. Export by adb pull/debug workflow.',
        });
        return;
      }

      const result = await tryShareFile(this.state.exportPath);
      if (!result.shared) {
        this.setState({
          isBusy: false,
          shareAvailable: false,
          shareHint: 'Sharing failed in this environment.',
        });
        return;
      }

      this.setState({ isBusy: false, shareAvailable: true, shareHint: null });
      this.appendLog('Share action completed.');
    } catch (error) {
      const message = getErrorMessage(error);
      this.setState({ isBusy: false, lastError: message });
      this.appendLog(`Share failed: ${message}`);
    }
  }

  private async bootstrap(): Promise<void> {
    // Register RNBG headless task before DB init so the native service can
    // deliver locations even if the JS process was restarted from scratch.
    registerRNBGHeadlessTask();

    try {
      await getDb();
      this.setState({ dbReady: true });
      const settings = await loadSettings();
      this.setState({
        chartsMode: settings.chartsMode,
        debugOverlayEnabled: settings.debugOverlayEnabled,
      });
      const shareAvailable = await isSharingAvailable();
      this.setState({ shareAvailable });
    } catch (error) {
      this.appendLog(`Bootstrap warning: ${getErrorMessage(error)}`);
    }

    // Auto-finalize any orphan trips from a prior crash before recovering.
    try {
      const activeSession = await loadActiveTripSession();
      const recovered = await finalizeDanglingTrips(activeSession?.tripId ?? null);
      if (recovered.length > 0) {
        this.setState({ recoveredOrphans: recovered });
        for (const orphan of recovered) {
          this.appendLog(
            `[RECOVERY] Auto-finalized orphan trip ${orphan.tripId.slice(0, 8)} (${orphan.pointCount} pts)`,
          );
        }
      }
    } catch (error) {
      this.appendLog(`Orphan cleanup warning: ${getErrorMessage(error)}`);
    }

    await this.refreshSystemStatus();
    this.startSystemStatusTimer();

    // Init RNBG plugin — configures native service, attaches onLocation listener.
    // Must run after DB is ready and before recoverActiveTrip starts tracking.
    try {
      await initBackgroundGeolocation();
    } catch (error) {
      this.appendLog(`RNBG init warning: ${getErrorMessage(error)}`);
    }

    await this.recoverActiveTrip();

    // Register out-of-process watchdog so the OS can revive GPS even if our
    // JS context is suspended. Fires every ~15min subject to OS throttling.
    void registerBackgroundWatchdog();
  }

  private async recoverActiveTrip(): Promise<void> {
    try {
      const session = await loadActiveTripSession();
      if (!session) {
        return;
      }

      const db = await getDb();
      const trip = await db.getFirstAsync<TripRow>('SELECT * FROM trip WHERE trip_id = ?;', [session.tripId]);
      if (!trip || trip.status !== 'recording') {
        await this.safeBackgroundCleanup();
        return;
      }

      const snapshot = await this.loadTripSnapshot(session.tripId);

      this.setState({
        status: 'recording',
        tripId: session.tripId,
        windowCode: session.windowCode,
        startedAtMs: trip.started_at_ms,
        pointsCount: snapshot.pointsCount,
        eventsCount: snapshot.eventsCount,
        segmentsCount: snapshot.segmentsCount,
        lastFix: snapshot.lastFix,
        totalDistanceM: snapshot.totalDistanceM,
        avgSpeedMps: snapshot.avgSpeedMps,
        currentSpeedMps: snapshot.lastFix?.speedMps ?? null,
        gpsAccuracyM: snapshot.lastFix?.accuracyM ?? null,
        nearestStopName: null,
        nearestStopDistanceM: null,
        insideStopName: null,
        expectedNextStopName: null,
        insideState: 'OUTSIDE',
      });

      this.startElapsedTimer();
      this.startHealthTimer();
      await this.refreshTrackingHealth();
      const running = await isBackgroundTrackingRunning();
      if (!running) {
        await startBackgroundTracking();
        this.appendLog('Recovered trip and restarted background tracking.');
      } else {
        this.appendLog('Recovered active trip after app restart.');
      }
      this.setState({
        foregroundServiceActive: SENSING_CONFIG.useForegroundService,
        // RNBG's native service holds its own wake lock; mirror that state here.
        wakeLockHeld: SENSING_CONFIG.useForegroundService,
      });
      if (SENSING_CONFIG.useForegroundService) {
        this.appendLog('[WAKELOCK] RNBG native wake lock held via recovered foreground service');
      }
      this.startWatchdog(session.tripId);
      this.startNotificationUpdater();
      this.startBatterySampler(session.tripId);
    } catch (error) {
      this.appendLog(`Recovery warning: ${getErrorMessage(error)}`);
    }
  }

  private async verifyBatteryWhitelist(): Promise<void> {
    // Run on EVERY trip start — the user may have re-enabled battery
    // optimization in system settings since we last asked. We only PROMPT
    // once (to avoid pestering), but we always loudly warn if not whitelisted
    // so the System Status card can surface the risk.
    try {
      const ignoring = await isIgnoringBatteryOptimizations();
      this.setState({ batteryOptimizationWhitelisted: ignoring });
      if (ignoring) {
        return;
      }
      const settings = await loadSettings();
      if (!settings.batteryOptimizationPrompted) {
        await saveSettings({ batteryOptimizationPrompted: true });
        const granted = await requestIgnoreBatteryOptimizations();
        this.setState({ batteryOptimizationWhitelisted: granted });
        this.appendLog(granted ? 'Battery optimization whitelist confirmed.' : 'Battery optimization whitelist not granted.');
        return;
      }
      this.appendLog('[BATTERY] Not whitelisted — task may be killed by Doze. Open system settings to re-enable.');
    } catch (error) {
      this.appendLog(`Battery optimization check warning: ${getErrorMessage(error)}`);
    }
  }

  private async refreshSystemStatus(): Promise<void> {
    try {
      const dbReady = await isDbInitialized();
      this.setState({ dbReady });
    } catch {
      // best-effort
    }
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      this.setState({ foregroundPermissionGranted: fg.status === 'granted' });
    } catch {
      this.setState({ foregroundPermissionGranted: null });
    }
    try {
      const bg = await Location.getBackgroundPermissionsAsync();
      this.setState({ backgroundPermissionGranted: bg.status === 'granted' });
    } catch {
      this.setState({ backgroundPermissionGranted: null });
    }
    try {
      const services = await Location.hasServicesEnabledAsync();
      this.setState({ locationServicesEnabled: services });
    } catch {
      this.setState({ locationServicesEnabled: null });
    }
    try {
      const ignoring = await isIgnoringBatteryOptimizations();
      this.setState({ batteryOptimizationWhitelisted: ignoring });
    } catch {
      this.setState({ batteryOptimizationWhitelisted: null });
    }
    // Truth check: is the background task registration actually alive?
    // If we believe we're recording but the system says no task is running,
    // the OS killed our foreground service (common on MIUI/EMUI). Surface
    // it via the System card indicator going red; don't overwrite an
    // existing lastError, but log the transition.
    if (this.state.status === 'recording') {
      try {
        const taskAlive = await isBackgroundTrackingRunning();
        const wasAlive = this.state.foregroundServiceActive;
        this.setState({ foregroundServiceActive: taskAlive });
        if (wasAlive && !taskAlive) {
          this.appendLog('[SERVICE-DEATH] Background task is no longer registered. Trying foreground restart.');
          // We are foregrounded (status refresh runs in foreground), so a
          // restart is allowed by Android. Kick off the resubscribe path.
          void this.resubscribeBackgroundTracking('service-death-detected');
        }
      } catch {
        // best-effort
      }
    }

    // While recording: detect permission revocation and pause cleanly.
    if (this.state.status === 'recording' && this.state.backgroundPermissionGranted === false) {
      if (!this.state.backgroundPermissionRevoked) {
        this.appendLog('[PERMISSION] Background location revoked — pausing recording');
        this.setState({
          backgroundPermissionRevoked: true,
          lastError: 'Background location permission revoked — recording paused. Re-grant "Allow all the time".',
        });
        await this.safeBackgroundCleanup();
        this.setState({ foregroundServiceActive: false, wakeLockHeld: false });

      }
    } else if (this.state.backgroundPermissionRevoked && this.state.backgroundPermissionGranted) {
      // User re-granted — clear the banner.
      this.setState({ backgroundPermissionRevoked: false });
    }
  }

  private startSystemStatusTimer(): void {
    this.stopSystemStatusTimer();
    this.systemStatusTimer = setInterval(() => {
      void this.refreshSystemStatus();
    }, SYSTEM_STATUS_REFRESH_INTERVAL_MS);
  }

  private stopSystemStatusTimer(): void {
    if (this.systemStatusTimer) {
      clearInterval(this.systemStatusTimer);
      this.systemStatusTimer = null;
    }
  }

  private startNotificationUpdater(): void {
    this.stopNotificationUpdater();
    void this.publishLiveNotification();
    this.notificationTimer = setInterval(() => {
      void this.publishLiveNotification();
    }, NOTIFICATION_UPDATE_INTERVAL_MS);
  }

  private stopNotificationUpdater(): void {
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer);
      this.notificationTimer = null;
    }
  }

  private async publishLiveNotification(): Promise<void> {
    if (this.state.status !== 'recording' || !this.state.tripId) {
      return;
    }
    const lastMs = this.state.healthLastWriteMs ?? this.state.lastFix?.timestampMs ?? null;
    const ageSec = lastMs != null ? Math.max(0, Math.floor((Date.now() - lastMs) / 1000)) : null;
    try {
      await publishTripNotification({
        tripId: this.state.tripId,
        elapsedSec: this.state.elapsedSeconds,
        pointsCount: this.state.pointsCount,
        lastGpsAgeSec: ageSec,
        taskRestartCount: this.state.taskRestartCount,
        variantLabel: this.state.variantLabel,
        wakeLockHeld: this.state.wakeLockHeld,
      });
    } catch {
      // best-effort
    }
  }

  private startBatterySampler(tripId: string): void {
    this.stopBatterySampler();
    void this.sampleBatteryNow(tripId);
    this.batterySamplerTimer = setInterval(() => {
      void this.sampleBatteryNow(tripId);
    }, BATTERY_SAMPLE_INTERVAL_MS);
  }

  private stopBatterySampler(): void {
    if (this.batterySamplerTimer) {
      clearInterval(this.batterySamplerTimer);
      this.batterySamplerTimer = null;
    }
  }

  private async sampleBatteryNow(tripId: string): Promise<void> {
    try {
      const level = await Battery.getBatteryLevelAsync();
      if (!Number.isFinite(level)) {
        return;
      }
      const pct = Math.round(level * 100);
      await insertBatterySample(tripId, Date.now(), pct);
    } catch {
      // best-effort
    }
  }

  private async handleAppStateChange(nextState: AppStateStatus): Promise<void> {
    const previousState = this.appState;
    this.appState = nextState;

    if (nextState === 'background' || nextState === 'inactive') {
      this.backgroundedAtMs = Date.now();
      // Flush any pending buffered points before the OS suspends us so they
      // are durably persisted even if our JS context gets killed.
      try {
        await flushPointBuffer();
      } catch {
        // best-effort
      }
      return;
    }

    if (nextState !== 'active' || previousState === 'active') {
      return;
    }

    // On every active resume, refresh system status (permissions may have
    // changed while we were backgrounded).
    void this.refreshSystemStatus();

    if (this.state.status !== 'recording') {
      return;
    }

    // Variant-tuned gap check on resume: if the last GPS write is older than
    // our threshold, force a re-subscribe immediately. Drops the previous
    // 60s flat gate which was too coarse for high/medium variants.
    try {
      const db = await getDb();
      const row = await db.getFirstAsync<{ timestamp_ms: number | null }>(
        'SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?;',
        [this.state.tripId],
      );
      const lastMs = row?.timestamp_ms ?? null;
      const ageMs = lastMs != null ? Date.now() - lastMs : Date.now() - (this.state.startedAtMs ?? Date.now());
      if (ageMs >= getWatchdogThresholdMs()) {
        await this.resubscribeBackgroundTracking('foreground-resume');
      }
    } catch {
      // best-effort
    }
  }

  private async resubscribeBackgroundTracking(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastResubscribeAtMs < 30_000) {
      return;
    }
    this.lastResubscribeAtMs = now;
    try {
      await restartBackgroundTracking();
      this.appendLog(`Background GPS re-subscribed (${reason}).`);
    } catch (error) {
      this.appendLog(`GPS re-subscribe warning (${reason}): ${getErrorMessage(error)}`);
    }
  }

  private async loadTripSnapshot(tripId: string): Promise<{
    pointsCount: number;
    eventsCount: number;
    segmentsCount: number;
    totalDistanceM: number;
    avgSpeedMps: number | null;
    lastFix: UITripState['lastFix'];
  }> {
    const db = await getDb();

    const pointsRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?;', [tripId]);
    const eventsRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?;', [tripId]);
    const segmentRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM segment_times WHERE trip_id = ?;', [tripId]);
    const latestRow = await db.getFirstAsync<{
      timestamp_ms: number;
      lat: number;
      lon: number;
      accuracy_m: number | null;
      speed_mps: number | null;
      heading_deg: number | null;
    }>(
      'SELECT timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1;',
      [tripId],
    );
    const firstRow = await db.getFirstAsync<{ timestamp_ms: number }>(
      'SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC LIMIT 1;',
      [tripId],
    );

    const pathRows = await db.getAllAsync<{ lat: number; lon: number }>(
      'SELECT lat, lon FROM gps_points WHERE trip_id = ? AND is_filtered = 0 ORDER BY timestamp_ms ASC;',
      [tripId],
    );
    let distance = 0;
    for (let index = 1; index < pathRows.length; index += 1) {
      const prev = pathRows[index - 1];
      const curr = pathRows[index];
      distance += haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    }

    const elapsedSec =
      latestRow && firstRow ? Math.max(1, Math.round((latestRow.timestamp_ms - firstRow.timestamp_ms) / 1000)) : null;

    return {
      pointsCount: pointsRow?.count ?? 0,
      eventsCount: eventsRow?.count ?? 0,
      segmentsCount: segmentRow?.count ?? 0,
      totalDistanceM: distance,
      avgSpeedMps: elapsedSec ? distance / elapsedSec : null,
      lastFix: latestRow
        ? {
            timestampMs: latestRow.timestamp_ms,
            timestampIso: new Date(latestRow.timestamp_ms).toISOString(),
            lat: latestRow.lat,
            lon: latestRow.lon,
            accuracyM: latestRow.accuracy_m,
            speedMps: latestRow.speed_mps,
            headingDeg: latestRow.heading_deg,
          }
        : null,
    };
  }

  private handleBackgroundTripUpdate(update: BackgroundTripUpdate): void {
    if (update.type === 'task-error') {
      const message = `Background task error: ${update.message}`;
      this.setState({
        lastError: message,
        lastTaskErrorAt: update.ts,
        lastTaskErrorMessage: update.message,
      });
      this.appendLog(`[TASK-ERROR] ${update.message}`);
      return;
    }

    if (!this.state.tripId || update.tripId !== this.state.tripId) {
      return;
    }

    const previousFix = this.state.lastFix;
    const incrementDistance =
      previousFix == null ? 0 : haversineMeters(previousFix.lat, previousFix.lon, update.lastFix.lat, update.lastFix.lon);
    const totalDistanceM = this.state.totalDistanceM + incrementDistance;
    const elapsedSeconds =
      this.state.startedAtMs == null ? this.state.elapsedSeconds : Math.max(0, Math.floor((Date.now() - this.state.startedAtMs) / 1000));
    const avgSpeedMps = elapsedSeconds > 0 ? totalDistanceM / elapsedSeconds : null;

    this.setState({
      pointsCount: this.state.pointsCount + update.pointsInserted,
      eventsCount: this.state.eventsCount + update.eventsInserted,
      segmentsCount: this.state.segmentsCount + update.segmentUpdates,
      elapsedSeconds,
      totalDistanceM,
      avgSpeedMps,
      currentSpeedMps: update.lastFix.speedMps,
      gpsAccuracyM: update.lastFix.accuracyM,
      lastFix: {
        timestampMs: update.lastFix.timestampMs,
        timestampIso: new Date(update.lastFix.timestampMs).toISOString(),
        lat: update.lastFix.lat,
        lon: update.lastFix.lon,
        accuracyM: update.lastFix.accuracyM,
        speedMps: update.lastFix.speedMps,
        headingDeg: update.lastFix.headingDeg,
      },
      nearestStopName: update.nearestStopName,
      nearestStopDistanceM: update.nearestStopDistanceM,
      insideStopName: update.insideStopName,
      expectedNextStopName: update.expectedNextStopName,
      insideState: update.insideState,
      lastFilterReason: update.lastFilterReason,
    });
    void this.refreshTrackingHealth();
  }

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (this.state.status !== 'recording' || this.state.startedAtMs == null) {
        return;
      }
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.state.startedAtMs) / 1000));
      const avgSpeedMps = elapsedSeconds > 0 ? this.state.totalDistanceM / elapsedSeconds : null;
      this.setState({ elapsedSeconds, avgSpeedMps });
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  private startHealthTimer(): void {
    this.stopHealthTimer();
    this.healthTimer = setInterval(() => {
      void this.refreshTrackingHealth();
    }, 5000);
  }

  private stopHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private startWatchdog(tripId: string): void {
    this.stopWatchdog();
    const thresholdMs = getWatchdogThresholdMs();
    const intervalMs = getWatchdogIntervalMs();
    this.appendLog(
      `[WATCHDOG] Started (threshold=${Math.round(thresholdMs / 1000)}s, interval=${Math.round(intervalMs / 1000)}s, variant=${VARIANT})`,
    );
    this.watchdogTimer = setInterval(async () => {
      try {
        const db = await getDb();
        const row = await db.getFirstAsync<{ timestamp_ms: number | null }>(
          'SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?;',
          [tripId],
        );
        const lastMs = row?.timestamp_ms ?? null;
        const startedMs = this.state.startedAtMs ?? Date.now();
        const ageMs = lastMs != null ? Date.now() - lastMs : Date.now() - startedMs;
        if (ageMs >= thresholdMs) {
          this.appendLog(`[WATCHDOG] Stale GPS (age=${Math.round(ageMs / 1000)}s) — resubscribing`);
          await this.resubscribeBackgroundTracking('watchdog');
        }
      } catch {
        // best-effort
      }
    }, intervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async safeBackgroundCleanup(): Promise<void> {
    try {
      await stopBackgroundTracking();
    } catch {
      // Best effort.
    }
    try {
      await clearActiveTripSession();
    } catch {
      // Best effort.
    }
    this.stopHealthTimer();
    this.stopWatchdog();
    this.stopNotificationUpdater();
    this.stopBatterySampler();
    void clearTripNotification();
  }

  private appendLog(message: string): void {
    const entry = `${new Date().toISOString()} ${message}`;
    this.setState({
      logs: [entry, ...this.state.logs].slice(0, MAX_LOG_LINES),
    });
  }

  private setState(patch: Partial<UITripState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };

    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  async refreshDebugInfo(): Promise<void> {
    if (!this.state.tripId) {
      return;
    }
    const debug = await loadTripDebug(this.state.tripId);
    this.setState({
      segmentsCount: debug.segmentsCount,
      lastFilterReason: debug.lastFilterReason,
    });
  }

  async refreshTrackingHealth(): Promise<void> {
    if (!this.state.tripId) {
      return;
    }
    try {
      const [dbHealth, audit] = await Promise.all([loadTrackingHealth(this.state.tripId), getAuditStats()]);
      const db = await getDb();
      const restartRow = await db.getFirstAsync<{ task_restart_count: number | null }>(
        'SELECT task_restart_count FROM trip_sessions WHERE trip_id = ?;',
        [this.state.tripId],
      );
      const lastWriteMs = dbHealth.lastV1TsIso != null ? new Date(dbHealth.lastV1TsIso).getTime() : dbHealth.lastLegacyTsMs;
      this.setState({
        healthLegacyPoints: dbHealth.legacyPoints,
        healthV1Points: dbHealth.v1Points,
        healthStopEvents: dbHealth.stopEvents,
        healthAuditLines: audit.lines,
        healthLastWriteIso: dbHealth.lastV1TsIso ?? (dbHealth.lastLegacyTsMs ? new Date(dbHealth.lastLegacyTsMs).toISOString() : null),
        healthLastWriteMs: lastWriteMs ?? null,
        healthAuditPath: audit.path,
        taskRestartCount: restartRow?.task_restart_count ?? 0,
      });
      if (this.state.status === 'recording') {
        const thresholdMs = getWatchdogThresholdMs();
        const staleMs = lastWriteMs != null && Number.isFinite(lastWriteMs) ? Date.now() - lastWriteMs : null;
        const noPointYetMs = this.state.startedAtMs != null ? Date.now() - this.state.startedAtMs : null;
        if ((staleMs != null && staleMs > thresholdMs) || (lastWriteMs == null && noPointYetMs != null && noPointYetMs > thresholdMs)) {
          await this.resubscribeBackgroundTracking('gps-watchdog');
        }
      }
    } catch (error) {
      this.appendLog(`Health refresh warning: ${getErrorMessage(error)}`);
    }
  }
}

// Asia/Manila is UTC+8 with no DST — simple fixed offset is correct.
function getManilaTime(nowMs: number): { hour: number; timeStr: string } {
  const manilaMs = nowMs + 8 * 60 * 60 * 1000;
  const d = new Date(manilaMs);
  const hour = d.getUTCHours();
  const min = d.getUTCMinutes();
  return { hour, timeStr: `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

function isInsideOperationalWindow(windowCode: WindowCode, hour: number): boolean {
  if (windowCode === 'AM') return hour >= 6 && hour < 10;   // 06:00–10:00 Manila
  if (windowCode === 'PM') return hour >= 16 && hour < 21;  // 16:00–21:00 Manila
  return true; // 'OFF' has no window constraint
}

function showOutsideWindowAlert(windowCode: string, currentTime: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Outside service window',
      `You selected the ${windowCode} window but the current time is ${currentTime} (Manila time). Are you sure you want to continue?`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue Anyway', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

function normalizeGpsPointRow(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const ts = String(row.ts ?? '');
  const tsMs = new Date(ts).getTime();
  const timestampMs =
    row.timestamp_ms != null && Number.isFinite(Number(row.timestamp_ms))
      ? Number(row.timestamp_ms)
      : Number.isFinite(tsMs)
      ? tsMs
      : null;

  return {
    ...row,
    id: row.id ?? index + 1,
    timestamp_ms: timestampMs,
    lon: row.lon ?? row.lng ?? null,
    heading_deg: row.heading_deg ?? row.bearing_deg ?? null,
    smoothed_lon: row.smoothed_lon ?? row.smoothed_lng ?? null,
  };
}

export const tripController = new TripController();
