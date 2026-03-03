import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';

import { getDb } from '../database/db';
import type { GPSPointRow } from '../models/GPSPoint';
import type { StopEventRow } from '../models/StopEvent';
import type { TripRow, DirectionCode, WindowCode } from '../models/Trip';
import { isSharingAvailable, tryShareFile } from '../utils/share';
import { startGPSWatch, type GPSFix } from './gpsService';
import { calculateSpeedMps } from './speedCalculator';
import {
  createInitialStopDetectorState,
  evaluateStopDetection,
  getStopDetectionConfig,
  type StopDetectorState,
  type StopInfo,
} from './stopDetector';

export interface UITripState {
  status: 'idle' | 'recording' | 'stopped';
  isBusy: boolean;
  routeNumber: 'R503';
  directionCode: DirectionCode;
  windowCode: WindowCode;
  tripId: string | null;
  pointsCount: number;
  eventsCount: number;
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
  insideState: 'INSIDE' | 'OUTSIDE';
  exportPath: string | null;
  lastExportTimestampIso: string | null;
  shareAvailable: boolean | null;
  shareHint: string | null;
  lastError: string | null;
  logs: string[];
}

const MAX_LOG_LINES = 30;

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
    lastFix: null,
    nearestStopName: null,
    nearestStopDistanceM: null,
    insideStopName: null,
    insideState: 'OUTSIDE',
    exportPath: null,
    lastExportTimestampIso: null,
    shareAvailable: null,
    shareHint: null,
    lastError: null,
    logs: [],
  };

  private listeners = new Set<(state: UITripState) => void>();
  private locationSub: Location.LocationSubscription | null = null;
  private stops: StopInfo[] = [];
  private detectorState: StopDetectorState = createInitialStopDetectorState();
  private processing: Promise<void> = Promise.resolve();

  subscribe(listener: (state: UITripState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): UITripState {
    return this.state;
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
    this.appendLog('Starting trip...');

    let tripIdForRollback: string | null = null;

    try {
      await this.stopLocationWatch();

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

      this.detectorState = createInitialStopDetectorState();
      this.setState({
        status: 'recording',
        tripId,
        pointsCount: 0,
        eventsCount: 0,
        lastFix: null,
        nearestStopName: null,
        nearestStopDistanceM: null,
        insideStopName: null,
        insideState: 'OUTSIDE',
        exportPath: null,
        lastExportTimestampIso: null,
        shareHint: null,
        lastError: null,
      });

      this.locationSub = await startGPSWatch((fix) => {
        this.processing = this.processing
          .then(() => this.persistFix(fix))
          .catch((error: unknown) => {
            const message = getErrorMessage(error);
            this.setState({ lastError: message });
            this.appendLog(`GPS processing error: ${message}`);
          });
      });

      const shareAvailable = await isSharingAvailable();
      this.setState({ shareAvailable, isBusy: false });
      this.appendLog(`Trip started: ${tripId}`);
    } catch (error) {
      if (tripIdForRollback) {
        try {
          const db = await getDb();
          await db.runAsync(
            'UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?;',
            [Date.now(), 'start_failed', tripIdForRollback],
          );
        } catch {
          // Keep the primary failure surfaced to UI.
        }
      }

      const message = getErrorMessage(error);
      this.setState({
        status: 'idle',
        isBusy: false,
        tripId: null,
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
      await this.stopLocationWatch();
      await this.processing;

      const db = await getDb();
      await db.runAsync('UPDATE trip SET ended_at_ms = ?, status = ? WHERE trip_id = ?;', [
        Date.now(),
        'stopped',
        this.state.tripId,
      ]);

      this.setState({
        status: 'stopped',
        isBusy: false,
      });
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
      const db = await getDb();
      const tripId = this.state.tripId;

      const trip = await db.getFirstAsync<TripRow>('SELECT * FROM trip WHERE trip_id = ?;', [tripId]);
      if (!trip) {
        throw new Error('Trip not found for export.');
      }

      const gpsPoints = await db.getAllAsync<GPSPointRow>(
        'SELECT * FROM gps_point WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
        [tripId],
      );
      const stopEvents = await db.getAllAsync<StopEventRow>(
        'SELECT * FROM stop_event WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
        [tripId],
      );
      const stops = await db.getAllAsync<StopInfo>(
        'SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code FROM stop ORDER BY stop_sequence ASC;',
      );

      const payload = {
        trip,
        gps_points: gpsPoints,
        stop_events: stopEvents,
        stops,
        config: {
          route_number: 'R503',
          watch_interval_ms: 1000,
          ...getStopDetectionConfig(),
        },
      };

      const baseDir = FileSystem.documentDirectory;
      if (!baseDir) {
        throw new Error('documentDirectory is unavailable.');
      }

      const safeTripId = tripId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputPath = `${baseDir}r503_trip_${safeTripId}.json`;
      await FileSystem.writeAsStringAsync(outputPath, JSON.stringify(payload, null, 2));

      const shareAvailable = await isSharingAvailable();
      this.setState({
        exportPath: outputPath,
        lastExportTimestampIso: new Date().toISOString(),
        shareAvailable,
        shareHint: shareAvailable
          ? null
          : 'Sharing is unavailable in this runtime. Copy the JSON via USB from app storage.',
        isBusy: false,
      });
      this.appendLog(`Export complete: ${outputPath}`);
    } catch (error) {
      const message = getErrorMessage(error);
      this.setState({ isBusy: false, lastError: message });
      this.appendLog(`Export failed: ${message}`);
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
          shareHint: 'Sharing is unavailable. Copy exported JSON via USB.',
        });
        return;
      }

      const result = await tryShareFile(this.state.exportPath);
      if (!result.shared) {
        this.setState({
          isBusy: false,
          shareAvailable: false,
          shareHint: 'Sharing failed in this environment. Copy exported JSON via USB.',
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

  private async persistFix(fix: GPSFix): Promise<void> {
    const tripId = this.state.tripId;
    if (!tripId) {
      return;
    }

    const previous = this.state.lastFix
      ? {
          lat: this.state.lastFix.lat,
          lon: this.state.lastFix.lon,
          timestampMs: this.state.lastFix.timestampMs,
        }
      : null;
    const computedSpeed = calculateSpeedMps(
      previous,
      { lat: fix.latitude, lon: fix.longitude, timestampMs: fix.timestampMs },
      fix.speedMps,
    );

    const db = await getDb();

    try {
      await db.runAsync(
        `INSERT INTO gps_point (trip_id, timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [tripId, fix.timestampMs, fix.latitude, fix.longitude, fix.accuracyM, computedSpeed, fix.headingDeg],
      );
    } catch (error) {
      throw new Error(`GPS insert failed: ${getErrorMessage(error)}`);
    }

    const detection = evaluateStopDetection(this.detectorState, this.stops, {
      lat: fix.latitude,
      lon: fix.longitude,
      timestampMs: fix.timestampMs,
    });
    this.detectorState = detection.nextState;

    let insertedEvents = 0;
    for (const event of detection.events) {
      try {
        await db.runAsync(
          `INSERT INTO stop_event (trip_id, stop_id, event_type, timestamp_ms, dist_m, lat, lon)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [tripId, event.stop_id, event.event_type, event.timestamp_ms, event.dist_m, event.lat, event.lon],
        );
        insertedEvents += 1;
      } catch (error) {
        this.setState({ lastError: `Stop event insert failed: ${getErrorMessage(error)}` });
      }
    }

    this.setState({
      lastFix: {
        timestampMs: fix.timestampMs,
        timestampIso: new Date(fix.timestampMs).toISOString(),
        lat: fix.latitude,
        lon: fix.longitude,
        accuracyM: fix.accuracyM,
        speedMps: computedSpeed,
        headingDeg: fix.headingDeg,
      },
      nearestStopName: detection.nearestStop?.stop_name ?? null,
      nearestStopDistanceM: detection.nearestDistanceM,
      insideStopName: detection.insideStop?.stop_name ?? null,
      insideState: detection.insideState,
      pointsCount: this.state.pointsCount + 1,
      eventsCount: this.state.eventsCount + insertedEvents,
    });
  }

  private async stopLocationWatch(): Promise<void> {
    try {
      this.locationSub?.remove();
    } catch {
      // Remove can throw if the native subscription is already disposed.
    }
    this.locationSub = null;
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
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

function createUuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

export const tripController = new TripController();
