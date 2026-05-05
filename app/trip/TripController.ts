import * as FileSystem from 'expo-file-system/legacy';
import * as Battery from 'expo-battery';
import { AppState, type AppStateStatus } from 'react-native';

import { getDb } from '../database/db';
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
  isBackgroundTrackingRunning,
  setTripUpdateListener,
  startBackgroundTracking,
  restartBackgroundTracking,
  stopBackgroundTracking,
  type BackgroundTripUpdate,
} from './backgroundLocationTask';
import { createInitialStopDetectorState, getStopDetectionConfig, type StopInfo } from './stopDetector';
import {
  flushPointBuffer,
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
const MAX_LOG_LINES = 40;

export interface UITripState {
  status: 'idle' | 'recording' | 'stopped';
  isBusy: boolean;
  routeNumber: 'R503';
  directionCode: DirectionCode;
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
  healthAuditPath: string | null;
  lastError: string | null;
  logs: string[];
}

class TripController {
  private state: UITripState = {
    status: 'idle',
    isBusy: false,
    routeNumber: 'R503',
    directionCode: 'A',
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
    healthAuditPath: null,
    lastError: null,
    logs: [],
  };

  private listeners = new Set<(state: UITripState) => void>();
  private stops: StopInfo[] = [];
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private batteryStartPct: number | null = null;
  private taskRestartStartCount = 0;
  private appState: AppStateStatus = AppState.currentState;
  private backgroundedAtMs: number | null = null;
  private lastResubscribeAtMs = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

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

  setDirectionCode(directionCode: DirectionCode): void {
    if (this.state.status === 'recording') {
      return;
    }
    this.setState({ directionCode });
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

    this.setState({ isBusy: true, lastError: null });
    this.appendLog('Starting v1.0 trip session...');

    let tripIdForRollback: string | null = null;

    try {
      const db = await getDb();
      const startedAtMs = Date.now();
      const tripId = createUuidV4();
      tripIdForRollback = tripId;

      this.stops = await this.loadStops(this.state.directionCode);
      await db.runAsync(
        `INSERT INTO trip (trip_id, started_at_ms, ended_at_ms, route_number, direction_code, window_code, status)
         VALUES (?, ?, NULL, ?, ?, ?, ?);`,
        [tripId, startedAtMs, this.state.routeNumber, this.state.directionCode, this.state.windowCode, 'recording'],
      );

      await insertSessionMetadata({
        tripId,
        directionCode: this.state.directionCode,
        windowCode: this.state.windowCode,
        appVersion: APP_VERSION,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startTimestampMs: startedAtMs,
        taskRestartCount: 0,
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
        directionCode: this.state.directionCode,
        windowCode: this.state.windowCode,
        startedAtMs,
        variantId: resolveVariantId(this.state.directionCode, this.state.windowCode),
        detectorState: createInitialStopDetectorState(),
        v1StopState: createInitialStopDetectionState(),
        lastFix: null,
      };
      await saveActiveTripSession(session);

      await this.requestBatteryWhitelistIfNeeded();
      await ensureBackgroundLocationReady();
      await startBackgroundTracking();

      // Start watchdog to detect silent GPS stoppage
      this.startWatchdog(tripId);

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
      });
      this.appendLog(`Start failed: ${message}`);
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
      await flushPointBuffer();

      const db = await getDb();
      const endedAtMs = Date.now();
      await db.runAsync('UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?;', [
        endedAtMs,
        'stopped',
        this.state.tripId,
      ]);
      await markSessionEnded(this.state.tripId, endedAtMs);
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
    try {
      await getDb();
      const settings = await loadSettings();
      this.setState({
        chartsMode: settings.chartsMode,
        debugOverlayEnabled: settings.debugOverlayEnabled,
      });
      const shareAvailable = await isSharingAvailable();
      this.setState({ shareAvailable });
    } catch {
      // Best effort.
    }

    await this.recoverActiveTrip();
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

      this.stops = await this.loadStops(session.directionCode);
      const snapshot = await this.loadTripSnapshot(session.tripId);

      this.setState({
        status: 'recording',
        tripId: session.tripId,
        directionCode: session.directionCode,
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
        this.startWatchdog(session.tripId);
      } else {
        this.appendLog('Recovered active trip after app restart.');
        this.startWatchdog(session.tripId);
      }
    } catch (error) {
      this.appendLog(`Recovery warning: ${getErrorMessage(error)}`);
    }
  }

  private async requestBatteryWhitelistIfNeeded(): Promise<void> {
    try {
      const settings = await loadSettings();
      if (settings.batteryOptimizationPrompted) {
        return;
      }
      await saveSettings({ batteryOptimizationPrompted: true });
      const ignoring = await isIgnoringBatteryOptimizations();
      if (ignoring) {
        return;
      }
      const granted = await requestIgnoreBatteryOptimizations();
      this.appendLog(granted ? 'Battery optimization whitelist confirmed.' : 'Battery optimization whitelist not granted.');
    } catch (error) {
      this.appendLog(`Battery optimization prompt warning: ${getErrorMessage(error)}`);
    }
  }

  private async handleAppStateChange(nextState: AppStateStatus): Promise<void> {
    const previousState = this.appState;
    this.appState = nextState;

    if (nextState === 'background' || nextState === 'inactive') {
      this.backgroundedAtMs = Date.now();
      return;
    }

    if (nextState !== 'active' || previousState === 'active' || this.state.status !== 'recording') {
      return;
    }

    const backgroundDurationMs = this.backgroundedAtMs == null ? null : Date.now() - this.backgroundedAtMs;
    if (backgroundDurationMs == null || backgroundDurationMs < 60_000) {
      return;
    }

    await this.resubscribeBackgroundTracking('foreground-resume');
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

  private async loadStops(directionCode: DirectionCode): Promise<StopInfo[]> {
    const db = await getDb();
    const filtered = await db.getAllAsync<StopInfo>(
      `SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code
       FROM stop
       WHERE direction_code = ?
       ORDER BY stop_sequence ASC;`,
      [directionCode],
    );
    if (filtered.length > 0) {
      return filtered;
    }
    return db.getAllAsync<StopInfo>(
      'SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code FROM stop ORDER BY stop_sequence ASC;',
    );
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
    this.watchdogTimer = setInterval(async () => {
      try {
        const db = await getDb();
        const row = await db.getFirstAsync<{ timestamp_ms: number }>(
          'SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1',
          [tripId],
        );
        const gap = (Date.now() - (row?.timestamp_ms ?? 0)) / 1000;
        if (gap > 60) {
          await this.resubscribeBackgroundTracking('watchdog');
        }
      } catch {
        // best-effort
      }
    }, 30000);
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
      this.setState({
        healthLegacyPoints: dbHealth.legacyPoints,
        healthV1Points: dbHealth.v1Points,
        healthStopEvents: dbHealth.stopEvents,
        healthAuditLines: audit.lines,
        healthLastWriteIso: dbHealth.lastV1TsIso ?? (dbHealth.lastLegacyTsMs ? new Date(dbHealth.lastLegacyTsMs).toISOString() : null),
        healthAuditPath: audit.path,
      });
      if (this.state.status === 'recording') {
        const lastWriteMs = dbHealth.lastV1TsIso != null ? new Date(dbHealth.lastV1TsIso).getTime() : dbHealth.lastLegacyTsMs;
        const staleMs = lastWriteMs != null && Number.isFinite(lastWriteMs) ? Date.now() - lastWriteMs : null;
        const noPointYetMs = this.state.startedAtMs != null ? Date.now() - this.state.startedAtMs : null;
        if ((staleMs != null && staleMs > 45_000) || (lastWriteMs == null && noPointYetMs != null && noPointYetMs > 45_000)) {
          await this.resubscribeBackgroundTracking('gps-watchdog');
        }
      }
    } catch (error) {
      this.appendLog(`Health refresh warning: ${getErrorMessage(error)}`);
    }
  }
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
