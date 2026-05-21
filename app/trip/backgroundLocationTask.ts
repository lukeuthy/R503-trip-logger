import BackgroundGeolocation, {
  type Location as BGLocation,
  DesiredAccuracy,
  LogLevel,
} from 'react-native-background-geolocation';

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
let rnbgInitialized = false;
// Tracks trips already counted for restart (survives JS reloads within same process)
const countedTaskRuntimeTripIds = new Set<string>();
const taskRuntimeStartedAtMs = Date.now();

export function setTripUpdateListener(listener: TripUpdateListener | null): void {
  tripUpdateListener = listener;
}

// ---------------------------------------------------------------------------
// RNBG initialisation — call once from TripController bootstrap
// ---------------------------------------------------------------------------

export async function initBackgroundGeolocation(): Promise<void> {
  if (rnbgInitialized) return;
  rnbgInitialized = true;

  // v5 uses a nested config structure: { geolocation, activity, app, logger }
  await BackgroundGeolocation.ready({
    geolocation: {
      // Best GPS accuracy (uses hardware GPS, not just WiFi/cell)
      desiredAccuracy: DesiredAccuracy.High,
      // Time-based sampling: distanceFilter=0 activates locationUpdateInterval
      distanceFilter: 0,
      locationUpdateInterval: SENSING_CONFIG.samplingIntervalMs,
      fastestLocationUpdateInterval: SENSING_CONFIG.samplingIntervalMs,
    },
    activity: {
      // Disable motion-detection stop: bus may sit at red lights without triggering "stationary"
      disableMotionActivityUpdates: true,
      disableStopDetection: true,
    },
    app: {
      // Don't persist across app restarts — we start/stop explicitly
      stopOnTerminate: true,
      startOnBoot: false,
      heartbeatInterval: 60,
      // Foreground notification (Android foreground service with START_STICKY)
      ...(SENSING_CONFIG.useForegroundService
        ? {
            notification: {
              title: 'R503 Logger',
              text: `GPS active (${SENSING_CONFIG.label})`,
              sticky: true,
            },
          }
        : {}),
    },
    logger: {
      debug: false,
      logLevel: LogLevel.Off,
    },
  });

  BackgroundGeolocation.onLocation(handleLocationUpdate, handleLocationError);
  BackgroundGeolocation.onHeartbeat(handleHeartbeat);
  BackgroundGeolocation.onProviderChange((event) => {
    void appendAuditLog({
      scope: 'rnbg',
      action: 'provider-change',
      enabled: event.enabled,
      status: event.status,
    });
  });
}

// ---------------------------------------------------------------------------
// Headless task — fires when app process is restarted by RNBG's native service
// ---------------------------------------------------------------------------

export function registerRNBGHeadlessTask(): void {
  BackgroundGeolocation.registerHeadlessTask(async (event) => {
    if (event.name === 'location') {
      await handleLocationUpdate(event.params as BGLocation);
    } else if (event.name === 'heartbeat') {
      await handleHeartbeat();
    }
  });
}

// ---------------------------------------------------------------------------
// GPS tracking lifecycle
// ---------------------------------------------------------------------------

export async function ensureBackgroundLocationReady(): Promise<void> {
  const status = await BackgroundGeolocation.requestPermission();
  // status: 3 = AUTHORIZATION_STATUS_ALWAYS, 2 = AUTHORIZATION_STATUS_WHEN_IN_USE
  if (status < 3) {
    throw new Error('Background location permission denied. Set location access to "Allow all the time".');
  }
}

export async function isBackgroundTrackingRunning(): Promise<boolean> {
  const state = await BackgroundGeolocation.getState();
  return state.enabled;
}

export async function startBackgroundTracking(): Promise<void> {
  const state = await BackgroundGeolocation.getState();
  if (state.enabled) return;
  await BackgroundGeolocation.start();
}

export async function restartBackgroundTracking(): Promise<void> {
  // RNBG start() is idempotent — safe to call when already running
  await BackgroundGeolocation.start();
}

export async function stopBackgroundTracking(): Promise<void> {
  await BackgroundGeolocation.stop();
}

// ---------------------------------------------------------------------------
// Core location handler — called for every GPS fix
// ---------------------------------------------------------------------------

async function handleLocationUpdate(location: BGLocation): Promise<void> {
  const session = await loadActiveTripSession();
  if (!session) return;

  try {
    if (!(await waitForDbInitialized())) {
      await appendAuditLog({
        scope: 'rnbg',
        action: 'db-not-initialized',
        trip_id: session.tripId,
      });
      return;
    }

    // Detect service restarts: if the JS runtime started after the trip began,
    // this is a restart. Increment the counter once per trip per JS runtime.
    if (!countedTaskRuntimeTripIds.has(session.tripId) && session.startedAtMs < taskRuntimeStartedAtMs - 10_000) {
      countedTaskRuntimeTripIds.add(session.tripId);
      await incrementTripRestartCount(session.tripId);
    }

    // RNBG timestamp is an ISO-8601 string; convert to ms
    const timestampMs = new Date(location.timestamp).getTime();

    // Discard fixes that predate the trip (can happen on first start)
    if (timestampMs < session.startedAtMs) return;

    const variantId = session.variantId ?? resolveVariantId(session.directionCode, session.windowCode);
    const stops = await loadStopsForVariant(variantId);
    const mutableSession: ActiveTripSession = { ...session, variantId };

    const point = await insertGPSPoint(session.tripId, location, timestampMs);
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
      detection = await runStopDetection(session.tripId, stops, point);
    }

    mutableSession.lastFix = {
      timestampMs: point.timestampMs,
      lat: point.lat,
      lon: point.lon,
      accuracyM: point.accuracyM,
      speedMps: point.speedMps,
      smoothedLat: point.smoothedLat,
      smoothedLon: point.smoothedLon,
      smoothedSpeedMps: point.smoothedSpeedMps,
    };

    try {
      await flushPointBuffer();
    } catch {
      // already audit-logged inside flushPointBuffer
    }
    await saveActiveTripSession(mutableSession);

    if (tripUpdateListener) {
      tripUpdateListener({
        type: 'point-update',
        tripId: session.tripId,
        pointsInserted: 1,
        eventsInserted: detection.eventsInserted,
        segmentUpdates: detection.segmentsUpdated,
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
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    await appendAuditLog({
      scope: 'rnbg',
      action: 'location-handler-exception',
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
}

function handleLocationError(code: number): void {
  // LocationError in RNBG v5 is a numeric code (not an object)
  void appendAuditLog({
    scope: 'rnbg',
    action: 'location-error',
    code,
  });
  if (tripUpdateListener) {
    void loadActiveTripSession().then((session) => {
      tripUpdateListener?.({
        type: 'task-error',
        tripId: session?.tripId ?? null,
        message: `GPS error code ${code}`,
        ts: Date.now(),
      });
    });
  }
}

async function handleHeartbeat(): Promise<void> {
  const session = await loadActiveTripSession();
  if (!session) return;
  await appendAuditLog({
    scope: 'rnbg',
    action: 'heartbeat',
    trip_id: session.tripId,
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function incrementTripRestartCount(tripId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE trip_sessions
     SET task_restart_count = COALESCE(task_restart_count, 0) + 1
     WHERE trip_id = ?;`,
    [tripId],
  );
}

async function insertGPSPoint(tripId: string, location: BGLocation, timestampMs: number): Promise<InsertedGpsPoint> {
  const db = await getDb();
  const coords = location.coords;
  const lat = coords.latitude;
  const lon = coords.longitude;
  // RNBG uses -1 for unknown; convert to null for DB nullability consistency
  const accuracyM = coords.accuracy >= 0 ? coords.accuracy : null;
  const speedMps =
    coords.speed != null && Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null;
  const headingDeg =
    coords.heading != null && Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : null;

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
    isFiltered = true;
    filterReason = 'post-gap-reset';
  } else if (
    speedMps === 0 &&
    headingDeg === 0 &&
    (
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

  // Skip-stop: if the bus is within departureRadiusM of a stop that is ahead of the
  // current target, the bus has passed the target without stopping.
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
    // Dedupe: only one dwell/exit per (trip_id, stop_id). Guards against the race
    // where two consecutive GPS points both pass the EXIT_CONSECUTIVE_POINTS threshold
    // before the stop_state row is updated to 'EXITED'.
    const existing = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ? AND stop_id = ? AND event_type = ?;',
      [tripId, stop.stopId, eventType],
    );
    if ((existing?.count ?? 0) > 0) {
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
