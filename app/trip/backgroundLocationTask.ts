import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState } from 'react-native';

import { getDb, waitForDbInitialized } from '../database/db';
import type { DirectionCode } from '../models/Trip';
import {
  flushPointBuffer,
  loadStopsForVariant,
  persistPoint,
  persistStopEvent,
  rebuildSegmentsForTrip,
  resolveVariantId,
} from '../src/db/queries';
import { deriveHeadingDeg, haversineMeters } from '../src/services/location/filters';
import type { RouteStop } from '../src/services/location/stopDetector';
import { appendAuditLog } from '../src/services/location/fileAudit';
import { SENSING_CONFIG } from '../src/utils/experimentConfig';
import { loadActiveTripSession, saveActiveTripSession, type ActiveTripSession } from './activeTripStore';

export const R503_BACKGROUND_TASK = 'R503_BACKGROUND_LOCATION_TASK';

const EXIT_CONSECUTIVE_POINTS = 3;
const EMA_ALPHA = 0.3;
const LOW_ACCURACY_M = 40;
const GAP_RESET_MS = 60_000;

type TripUpdateListener = (update: BackgroundTripUpdate) => void;

export interface BackgroundTripPointUpdate {
  type: 'point-update';
  tripId: string;
  pointsInserted: number;
  eventsInserted: number;
  segmentUpdates: number;
  lastFix: {
    timestampMs: number;
    lat: number;
    lon: number;
    accuracyM: number | null;
    speedMps: number | null;
    headingDeg: number | null;
  };
  nearestStopName: string | null;
  nearestStopDistanceM: number | null;
  insideStopName: string | null;
  insideState: 'INSIDE' | 'OUTSIDE';
  lastFilterReason: string | null;
  expectedNextStopName: string | null;
}

export interface BackgroundTripErrorUpdate {
  type: 'task-error';
  tripId: string | null;
  message: string;
  ts: number;
}

export type BackgroundTripUpdate = BackgroundTripPointUpdate | BackgroundTripErrorUpdate;

interface StoredGpsPoint {
  timestamp_ms: number;
  lat: number;
  lon: number | null;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  is_filtered: number;
  smoothed_lat: number | null;
  smoothed_lon: number | null;
  smoothed_speed_mps: number | null;
}

interface InsertedGpsPoint {
  timestampMs: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  derivedSpeedMps: number | null;
  derivedHeadingDeg: number | null;
  isFiltered: boolean;
  filterReason: string | null;
  smoothedLat: number;
  smoothedLon: number;
  smoothedSpeedMps: number | null;
}

interface StopStateRow {
  state: 'OUTSIDE' | 'NEAR' | 'ARRIVED' | 'DWELLING' | 'EXITED';
  entered_at_ms: number | null;
  dwell_at_ms: number | null;
  exit_candidate_count: number;
}

let tripUpdateListener: TripUpdateListener | null = null;
const countedTaskRuntimeTripIds = new Set<string>();
const taskRuntimeStartedAtMs = Date.now();

export function setTripUpdateListener(listener: TripUpdateListener | null): void {
  tripUpdateListener = listener;
}

export async function ensureBackgroundLocationReady(): Promise<void> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    fg = await Location.requestForegroundPermissionsAsync();
  }
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission denied.');
  }

  let bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    bg = await Location.requestBackgroundPermissionsAsync();
  }
  if (bg.status !== 'granted') {
    throw new Error('Background location permission denied. Set location access to "Allow all the time".');
  }

  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    throw new Error('Location services are OFF. Please enable GPS/location services.');
  }
}

export async function isBackgroundTrackingRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(R503_BACKGROUND_TASK);
}

export async function startBackgroundTracking(): Promise<void> {
  const running = await isBackgroundTrackingRunning();
  if (running) {
    return;
  }
  try {
    await activateKeepAwakeAsync('r503-gps');
  } catch {
    // best-effort
  }
  await Location.startLocationUpdatesAsync(R503_BACKGROUND_TASK, getLocationTaskOptions());
}

export async function restartBackgroundTracking(): Promise<void> {
  await resubscribeGPS();
}

export async function stopBackgroundTracking(): Promise<void> {
  const running = await isBackgroundTrackingRunning();
  if (running) {
    try {
      await Location.stopLocationUpdatesAsync(R503_BACKGROUND_TASK);
    } catch {
      // continue to unregister below
    }
  }
  // Defensively unregister the TaskManager binding so OS-level callbacks
  // don't fire against a stopped trip if expo-location leaks a registration.
  // The defineTask binding at module scope is preserved and will pick up
  // again on the next startBackgroundTracking().
  try {
    if (await TaskManager.isTaskRegisteredAsync(R503_BACKGROUND_TASK)) {
      await TaskManager.unregisterTaskAsync(R503_BACKGROUND_TASK);
    }
  } catch {
    // best-effort
  }
  try {
    deactivateKeepAwake('r503-gps');
  } catch {
    // best-effort
  }
}

function getLocationTaskOptions(): Location.LocationTaskOptions {
  const base: Location.LocationTaskOptions = {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: SENSING_CONFIG.samplingIntervalMs,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  };
  if (SENSING_CONFIG.useForegroundService) {
    base.foregroundService = {
      notificationTitle: 'R503 Logger',
      notificationBody: `Recording ${SENSING_CONFIG.label} trip`,
      killServiceOnDestroy: false,
    } as Location.LocationTaskServiceOptions;
  }
  return base;
}

async function resubscribeGPS(): Promise<void> {
  // CRITICAL Android 12+ constraint: a foreground service cannot be started
  // while the app is in the background — startLocationUpdatesAsync with a
  // foregroundService config throws ForegroundServiceStartNotAllowedException.
  //
  // Previously this function did stop -> start, which guaranteed that if the
  // task fired while the app was backgrounded (e.g. taskBody.error inside
  // Doze), we'd kill the running service and then fail to restart it,
  // producing 21-minute GPS blackouts. Field log showed 11+ occurrences of
  // "Couldn't start the foreground service" with task_restart_count climbing.
  //
  // New strategy:
  //   1. Never call stopLocationUpdatesAsync from this recovery path.
  //   2. If the task is already running, just re-acquire the wake lock and
  //      return — the OS will keep delivering callbacks.
  //   3. Only attempt startLocationUpdatesAsync if NOT already running AND
  //      the app is in the foreground; if backgrounded, log and bail so the
  //      foreground watchdog / AppState resume picks it up.
  try {
    await activateKeepAwakeAsync('r503-gps');
  } catch {
    // best-effort
  }
  const running = await isBackgroundTrackingRunning();
  if (running) {
    return;
  }
  const appForeground = AppState.currentState === 'active';
  if (!appForeground) {
    await appendAuditLog({
      scope: 'background-task',
      action: 'resubscribe-skipped',
      reason: 'app-backgrounded-fg-service-restricted',
    });
    return;
  }
  try {
    await Location.startLocationUpdatesAsync(R503_BACKGROUND_TASK, getLocationTaskOptions());
  } catch (error) {
    await appendAuditLog({
      scope: 'background-task',
      action: 'resubscribe-failed',
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

if (!TaskManager.isTaskDefined(R503_BACKGROUND_TASK)) {
  TaskManager.defineTask(R503_BACKGROUND_TASK, async (taskBody: TaskManager.TaskManagerTaskBody<{ locations?: Location.LocationObject[] }>) => {
    const session = await loadActiveTripSession();
    try {
      try {
        await activateKeepAwakeAsync('r503-gps');
      } catch {
        // best-effort
      }
      if (taskBody.error) {
        if (session) {
          await incrementTripRestartCount(session.tripId);
        }
        await resubscribeGPS();
        await appendAuditLog({
          scope: 'background-task',
          action: 'task-error',
          message: taskBody.error.message,
        });
        if (tripUpdateListener) {
          tripUpdateListener({
            type: 'task-error',
            tripId: session?.tripId ?? null,
            message: taskBody.error.message,
            ts: Date.now(),
          });
        }
        return;
      }

      if (!session) {
        return;
      }

      if (!(await waitForDbInitialized())) {
        await appendAuditLog({
          scope: 'background-task',
          action: 'db-not-initialized-timeout',
          trip_id: session.tripId,
        });
        return;
      }

      if (!countedTaskRuntimeTripIds.has(session.tripId) && session.startedAtMs < taskRuntimeStartedAtMs - 10_000) {
        countedTaskRuntimeTripIds.add(session.tripId);
        await incrementTripRestartCount(session.tripId);
        await resubscribeGPS();
      }

      const locations = (taskBody.data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
      if (locations.length === 0) {
        return;
      }

      const variantId = session.variantId ?? resolveVariantId(session.directionCode, session.windowCode);
      const stops = await loadStopsForVariant(variantId);
      let mutableSession: ActiveTripSession = { ...session, variantId };
      let pointsInserted = 0;
      let eventsInserted = 0;
      let segmentUpdates = 0;
      let lastUpdate: BackgroundTripPointUpdate | null = null;

      for (const location of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
        // Discard GPS callbacks that fired before the trip was officially started.
        // The background task may already be running from a previous session,
        // so its first few callbacks can predate startedAtMs by several minutes.
        if (location.timestamp < mutableSession.startedAtMs) {
          continue;
        }
        const point = await insertGPSPoint(mutableSession.tripId, location);
        pointsInserted += 1;

        let detection: StopDetectionResult = {
          eventsInserted: 0,
          segmentsUpdated: 0,
          nearestStopName: null,
          nearestDistanceM: null,
          insideStopName: null,
          insideState: 'OUTSIDE',
          expectedNextStopName: null,
        };
        if (!point.isFiltered) {
          detection = await runStopDetection(mutableSession.tripId, stops, point);
          eventsInserted += detection.eventsInserted;
          segmentUpdates += detection.segmentsUpdated;
        }

        mutableSession = {
          ...mutableSession,
          lastFix: {
            timestampMs: point.timestampMs,
            lat: point.lat,
            lon: point.lon,
            accuracyM: point.accuracyM,
            speedMps: point.speedMps,
            smoothedLat: point.smoothedLat,
            smoothedLon: point.smoothedLon,
            smoothedSpeedMps: point.smoothedSpeedMps,
          },
        };
        lastUpdate = {
          type: 'point-update',
          tripId: mutableSession.tripId,
          pointsInserted,
          eventsInserted,
          segmentUpdates,
          lastFix: {
            timestampMs: point.timestampMs,
            lat: point.lat,
            lon: point.lon,
            accuracyM: point.accuracyM,
            speedMps: point.speedMps,
            headingDeg: point.headingDeg,
          },
          nearestStopName: detection.nearestStopName,
          nearestStopDistanceM: detection.nearestDistanceM,
          insideStopName: detection.insideStopName,
          insideState: detection.insideState,
          lastFilterReason: point.filterReason,
          expectedNextStopName: detection.expectedNextStopName,
        };
      }

      // Flush any buffered points before saving the session — guarantees
      // foreground listeners and segment rebuilds see the latest data.
      try {
        await flushPointBuffer();
      } catch {
        // already audit-logged inside flushPointBuffer
      }
      await saveActiveTripSession(mutableSession);
      if (lastUpdate && tripUpdateListener) {
        tripUpdateListener(lastUpdate);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await appendAuditLog({
        scope: 'background-task',
        action: 'exception',
        trip_id: session?.tripId ?? null,
        message,
      });
      if (tripUpdateListener) {
        tripUpdateListener({
          type: 'task-error',
          tripId: session?.tripId ?? null,
          message,
          ts: Date.now(),
        });
      }
    }
  });
}

async function incrementTripRestartCount(tripId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE trip_sessions
     SET task_restart_count = COALESCE(task_restart_count, 0) + 1
     WHERE trip_id = ?;`,
    [tripId],
  );
}

async function insertGPSPoint(tripId: string, location: Location.LocationObject): Promise<InsertedGpsPoint> {
  const db = await getDb();
  const coords = location.coords;
  const timestampMs = location.timestamp;
  const lat = coords.latitude;
  const lon = coords.longitude;
  const accuracyM = coords.accuracy ?? null;
  const speedMps = coords.speed != null && Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null;
  const headingDeg = coords.heading != null && Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : null;

  const previousPoint = await db.getFirstAsync<StoredGpsPoint>(
    `SELECT timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg, is_filtered, smoothed_lat, smoothed_lon, smoothed_speed_mps
     FROM gps_points
     WHERE trip_id = ?
     ORDER BY timestamp_ms DESC
     LIMIT 1;`,
    [tripId],
  );
  const previousValidPoint = await db.getFirstAsync<StoredGpsPoint>(
    `SELECT timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg, is_filtered, smoothed_lat, smoothed_lon, smoothed_speed_mps
     FROM gps_points
     WHERE trip_id = ? AND (is_filtered = 0 OR filter_reason = 'post-gap-reset') AND timestamp_ms < ?
     ORDER BY timestamp_ms DESC
     LIMIT 1;`,
    [tripId, timestampMs],
  );

  let isFiltered = false;
  let filterReason: string | null = null;
  let derivedSpeedMps: number | null = null;
  let derivedHeadingDeg: number | null = null;
  let smoothedLat = lat;
  let smoothedLon = lon;
  let smoothedSpeedMps = speedMps;

  if (previousPoint && timestampMs === previousPoint.timestamp_ms) {
    isFiltered = true;
    filterReason = 'duplicate-timestamp';
  } else if (previousPoint && timestampMs < previousPoint.timestamp_ms) {
    isFiltered = true;
    filterReason = 'out-of-order-timestamp';
  } else if (previousPoint && timestampMs - previousPoint.timestamp_ms > GAP_RESET_MS) {
    // Gap check must come before cold_start so that the first point after a
    // CPU-sleep blackout is tagged post-gap-reset (not cold_start_zero_values).
    // This resets the EMA to the recovery position and allows the next valid
    // point to compute derived_speed_mps from the correct baseline.
    isFiltered = true;
    filterReason = 'post-gap-reset';
  } else if (
    speedMps === 0 &&
    headingDeg === 0 &&
    (
      // Only treat speed=0+heading=0 as a "cold start" garbage fix when:
      //   (a) accuracy is suspicious — provider hasn't locked yet
      //   (b) the previous point was itself filtered (post-gap recovery context)
      // Otherwise it is most likely a legitimate stationary fix (red light,
      // bus dwelling at a stop), and we MUST keep it for arrive/dwell detection.
      // Previous version filtered ANY 0/0 point, which silently dropped almost
      // every stop dwell sample and corrupted segment stats.
      (accuracyM != null && accuracyM > 20) ||
      (previousPoint != null && previousPoint.is_filtered === 1)
    )
  ) {
    isFiltered = true;
    filterReason = 'cold_start_zero_values';
  } else if (accuracyM != null && accuracyM > LOW_ACCURACY_M) {
    isFiltered = true;
    filterReason = 'low-accuracy';
  } else if (previousValidPoint) {
    const prevLon = previousValidPoint.lon ?? lon;
    const dtSec = (timestampMs - previousValidPoint.timestamp_ms) / 1000;
    // Only compute derived fields when the time delta is plausible.
    // A delta >= GAP_RESET_MS means the previousValidPoint is from before a
    // blackout; the resulting near-zero speed would corrupt quality metrics.
    if (dtSec > 0 && dtSec < GAP_RESET_MS / 1000) {
      derivedSpeedMps = haversineMeters(previousValidPoint.lat, prevLon, lat, lon) / dtSec;
      derivedHeadingDeg = deriveHeadingDeg({ lat: previousValidPoint.lat, lon: prevLon }, { lat, lon });
    }
    smoothedLat =
      previousValidPoint.smoothed_lat == null ? lat : EMA_ALPHA * lat + (1 - EMA_ALPHA) * previousValidPoint.smoothed_lat;
    smoothedLon =
      previousValidPoint.smoothed_lon == null ? lon : EMA_ALPHA * lon + (1 - EMA_ALPHA) * previousValidPoint.smoothed_lon;
    smoothedSpeedMps =
      previousValidPoint.smoothed_speed_mps == null || speedMps == null
        ? speedMps
        : EMA_ALPHA * speedMps + (1 - EMA_ALPHA) * previousValidPoint.smoothed_speed_mps;
  }

  if (isFiltered && filterReason !== 'post-gap-reset' && previousPoint) {
    smoothedLat = previousPoint.smoothed_lat ?? previousPoint.lat;
    smoothedLon = previousPoint.smoothed_lon ?? previousPoint.lon ?? lon;
    smoothedSpeedMps = previousPoint.smoothed_speed_mps ?? previousPoint.speed_mps;
  }

  const point: InsertedGpsPoint = {
    timestampMs,
    lat,
    lon,
    accuracyM,
    speedMps,
    headingDeg,
    derivedSpeedMps,
    derivedHeadingDeg,
    isFiltered,
    filterReason,
    smoothedLat,
    smoothedLon,
    smoothedSpeedMps,
  };

  await persistPoint({
    tripId,
    timestampMs,
    lat,
    lon,
    accuracyM,
    altitudeM: coords.altitude ?? null,
    speedMps,
    headingDeg,
    derivedSpeedMps,
    derivedHeadingDeg,
    providerSpeedMps: speedMps,
    providerHeadingDeg: headingDeg,
    isFiltered,
    filterReason,
    smoothedLat,
    smoothedLng: smoothedLon,
    smoothedSpeedMps,
  });

  await appendAuditLog({
    scope: 'gps-write',
    trip_id: tripId,
    ts: timestampMs,
    lat,
    lon,
    speed_mps: speedMps,
    heading_deg: headingDeg,
    is_filtered: isFiltered ? 1 : 0,
    filter_reason: filterReason,
  });

  return point;
}

interface StopDetectionResult {
  eventsInserted: number;
  segmentsUpdated: number;
  nearestStopName: string | null;
  nearestDistanceM: number | null;
  insideStopName: string | null;
  insideState: 'INSIDE' | 'OUTSIDE';
  expectedNextStopName: string | null;
}

async function runStopDetection(tripId: string, stops: RouteStop[], point: InsertedGpsPoint): Promise<StopDetectionResult> {
  if (stops.length === 0) {
    return {
      eventsInserted: 0,
      segmentsUpdated: 0,
      nearestStopName: null,
      nearestDistanceM: null,
      insideStopName: null,
      insideState: 'OUTSIDE',
      expectedNextStopName: null,
    };
  }

  const nearest = getNearestStop(stops, point.smoothedLat, point.smoothedLon);
  let target = await getTargetStop(tripId, stops);

  // Skip-stop: if the bus is within SENSING_CONFIG.departureRadiusM of a stop that is ahead of the
  // current target, the bus has passed the target without stopping. Mark the target
  // as EXITED (skipped) and advance. Repeats if multiple stops were skipped.
  if (target && nearest.stop && nearest.distanceM != null &&
      nearest.stop.stopOrder > target.stopOrder &&
      nearest.distanceM <= SENSING_CONFIG.departureRadiusM) {
    const db = await getDb();
    const targetState = await loadStopState(tripId, target.stopId);
    if (targetState.state !== 'ARRIVED' && targetState.state !== 'DWELLING') {
      await db.runAsync(
        `INSERT INTO stop_states (trip_id, stop_id, state, entered_at_ms, dwell_at_ms, exit_candidate_count, updated_at_ms)
         VALUES (?, ?, 'EXITED', NULL, NULL, 0, ?)
         ON CONFLICT(trip_id, stop_id) DO UPDATE SET
           state = 'EXITED', updated_at_ms = excluded.updated_at_ms;`,
        [tripId, target.stopId, point.timestampMs],
      );
      await appendAuditLog({
        scope: 'stop-detection',
        action: 'skip-stop-advanced',
        trip_id: tripId,
        stop_id: target.stopId,
        ts: point.timestampMs,
        message: `Skipped ${target.name}; nearest is ${nearest.stop.name} (order ${nearest.stop.stopOrder} > ${target.stopOrder})`,
      });
      target = await getTargetStop(tripId, stops);
    }
  }

  if (!target) {
    return {
      eventsInserted: 0,
      segmentsUpdated: 0,
      nearestStopName: nearest.stop?.name ?? null,
      nearestDistanceM: nearest.distanceM,
      insideStopName: null,
      insideState: 'OUTSIDE',
      expectedNextStopName: null,
    };
  }

  const db = await getDb();
  const distM = haversineMeters(point.smoothedLat, point.smoothedLon, target.lat, target.lng);
  const state = await loadStopState(tripId, target.stopId);
  let eventsInserted = 0;
  let segmentsUpdated = 0;
  let nextState = state.state;
  let enteredAtMs = state.entered_at_ms;
  let dwellAtMs = state.dwell_at_ms;
  let exitCandidateCount = state.exit_candidate_count ?? 0;

  if ((state.state === 'OUTSIDE' || state.state === 'NEAR') && distM <= SENSING_CONFIG.geofenceRadiusM) {
    nextState = 'ARRIVED';
    enteredAtMs = point.timestampMs;
    exitCandidateCount = 0;
    if (await insertStopEventIfAllowed(tripId, target, 'arrive', point, distM)) {
      eventsInserted += 1;
      await rebuildSegmentsForTrip(tripId);
      segmentsUpdated += 1;
    }
  } else if (state.state === 'ARRIVED' || state.state === 'DWELLING') {
    if (distM <= SENSING_CONFIG.geofenceRadiusM) {
      exitCandidateCount = 0;
      if (state.state === 'ARRIVED' && enteredAtMs != null && point.timestampMs - enteredAtMs >= SENSING_CONFIG.dwellTimeMs) {
        nextState = 'DWELLING';
        dwellAtMs = point.timestampMs;
        if (await insertStopEventIfAllowed(tripId, target, 'dwell', point, distM)) {
          eventsInserted += 1;
        }
      }
    } else if (distM >= SENSING_CONFIG.departureRadiusM) {
      exitCandidateCount += 1;
      if (exitCandidateCount >= EXIT_CONSECUTIVE_POINTS) {
        nextState = 'EXITED';
        if (await insertStopEventIfAllowed(tripId, target, 'exit', point, distM)) {
          eventsInserted += 1;
          await rebuildSegmentsForTrip(tripId);
          segmentsUpdated += 1;
        }
      }
    } else {
      exitCandidateCount = 0;
    }
  }

  await db.runAsync(
    `INSERT INTO stop_states (trip_id, stop_id, state, entered_at_ms, dwell_at_ms, exit_candidate_count, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trip_id, stop_id) DO UPDATE SET
       state = excluded.state,
       entered_at_ms = excluded.entered_at_ms,
       dwell_at_ms = excluded.dwell_at_ms,
       exit_candidate_count = excluded.exit_candidate_count,
       updated_at_ms = excluded.updated_at_ms;`,
    [tripId, target.stopId, nextState, enteredAtMs, dwellAtMs, exitCandidateCount, point.timestampMs],
  );

  return {
    eventsInserted,
    segmentsUpdated,
    nearestStopName: nearest.stop?.name ?? null,
    nearestDistanceM: nearest.distanceM,
    insideStopName: distM <= SENSING_CONFIG.geofenceRadiusM ? target.name : null,
    insideState: distM <= SENSING_CONFIG.geofenceRadiusM ? 'INSIDE' : 'OUTSIDE',
    expectedNextStopName: target.name,
  };
}

async function insertStopEventIfAllowed(
  tripId: string,
  stop: RouteStop,
  eventType: 'arrive' | 'dwell' | 'exit',
  point: InsertedGpsPoint,
  distM: number,
): Promise<boolean> {
  const db = await getDb();
  if (eventType !== 'arrive') {
    const arrive = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ? AND stop_id = ? AND event_type = ?;',
      [tripId, stop.stopId, 'arrive'],
    );
    if ((arrive?.count ?? 0) === 0) {
      return false;
    }
  }
  return persistStopEvent({
    tripId,
    stopId: stop.stopId,
    eventType,
    timestampMs: point.timestampMs,
    distToStopM: distM,
    lat: point.smoothedLat,
    lon: point.smoothedLon,
    speedMps: point.speedMps,
    accuracyM: point.accuracyM,
  });
}

async function getTargetStop(tripId: string, stops: RouteStop[]): Promise<RouteStop | null> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ stop_id: string; state: string }>(
    'SELECT stop_id, state FROM stop_states WHERE trip_id = ?;',
    [tripId],
  );
  const statesByStopId = new Map(rows.map((row) => [row.stop_id, row.state]));
  const active = stops.find((stop) => {
    const state = statesByStopId.get(stop.stopId);
    return state === 'ARRIVED' || state === 'DWELLING' || state === 'NEAR';
  });
  if (active) {
    return active;
  }
  return stops.find((stop) => statesByStopId.get(stop.stopId) !== 'EXITED') ?? null;
}

async function loadStopState(tripId: string, stopId: string): Promise<StopStateRow> {
  const db = await getDb();
  const row = await db.getFirstAsync<StopStateRow>(
    'SELECT state, entered_at_ms, dwell_at_ms, exit_candidate_count FROM stop_states WHERE trip_id = ? AND stop_id = ?;',
    [tripId, stopId],
  );
  return row ?? { state: 'OUTSIDE', entered_at_ms: null, dwell_at_ms: null, exit_candidate_count: 0 };
}

function getNearestStop(
  stops: RouteStop[],
  lat: number,
  lon: number,
): {
  stop: RouteStop | null;
  distanceM: number | null;
} {
  let nearestStop: RouteStop | null = null;
  let nearestDistanceM: number | null = null;
  for (const stop of stops) {
    const distanceM = haversineMeters(lat, lon, stop.lat, stop.lng);
    if (nearestDistanceM == null || distanceM < nearestDistanceM) {
      nearestStop = stop;
      nearestDistanceM = distanceM;
    }
  }
  return { stop: nearestStop, distanceM: nearestDistanceM };
}

export async function loadLegacyStopsForDirection(directionCode: DirectionCode): Promise<never[]> {
  void directionCode;
  return [];
}
