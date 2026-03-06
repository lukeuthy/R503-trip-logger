import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { getDb } from '../database/db';
import type { DirectionCode } from '../models/Trip';
import {
  loadStopsForVariant,
  persistPoint,
  persistStopEvent,
  rebuildSegmentsForTrip,
  resolveVariantId,
} from '../src/db/queries';
import { applyEmaSmoothing, filterRawPoint } from '../src/services/location/filters';
import {
  createInitialStopDetectionState,
  DEFAULT_STOP_CONFIG,
  evaluateSequencedStopDetection,
  type RouteStop,
} from '../src/services/location/stopDetector';
import { appendAuditLog } from '../src/services/location/fileAudit';
import { loadSettings } from '../src/utils/settingsStore';
import { calculateSpeedMps } from './speedCalculator';
import type { ActiveTripSession, PersistedFix } from './activeTripStore';
import { loadActiveTripSession, saveActiveTripSession } from './activeTripStore';
import { evaluateStopDetection, type StopInfo } from './stopDetector';

export const R503_BACKGROUND_TASK = 'R503_BACKGROUND_LOCATION_TASK';

export interface BackgroundTripUpdate {
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

type TripUpdateListener = (update: BackgroundTripUpdate) => void;

let tripUpdateListener: TripUpdateListener | null = null;

export function setTripUpdateListener(listener: TripUpdateListener | null): void {
  tripUpdateListener = listener;
}

export async function ensureBackgroundLocationReady(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission denied.');
  }

  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    throw new Error('Background location permission denied. Set "Allow all the time" in app settings.');
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

  await Location.startLocationUpdatesAsync(R503_BACKGROUND_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 2000,
    distanceInterval: 5,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'R503 logger running',
      notificationBody: 'Trip recording in background.',
      notificationColor: '#0f766e',
    },
  });
}

export async function stopBackgroundTracking(): Promise<void> {
  const running = await isBackgroundTrackingRunning();
  if (!running) {
    return;
  }
  await Location.stopLocationUpdatesAsync(R503_BACKGROUND_TASK);
}

if (!TaskManager.isTaskDefined(R503_BACKGROUND_TASK)) {
  TaskManager.defineTask(R503_BACKGROUND_TASK, async (taskBody: TaskManager.TaskManagerTaskBody<{ locations?: Location.LocationObject[] }>) => {
    try {
      const { data, error } = taskBody;
      if (error) {
        await appendAuditLog({
          scope: 'background-task',
          type: 'task-error',
          message: error.message,
        });
        return;
      }

      const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
      if (locations.length === 0) {
        return;
      }

      const session = await loadActiveTripSession();
      if (!session) {
        return;
      }

      const legacyStops = await loadLegacyStopsForDirection(session.directionCode);
      const variantId = session.variantId ?? resolveVariantId(session.directionCode, session.windowCode);
      const v1Stops = await loadStopsForVariant(variantId);

      let pointsInserted = 0;
      let eventsInserted = 0;
      let segmentUpdates = 0;
      let lastUpdate: BackgroundTripUpdate | null = null;
      let mutableSession: ActiveTripSession = {
        ...session,
        variantId,
        v1StopState: session.v1StopState ?? createInitialStopDetectionState(),
      };

      for (const position of locations) {
        const result = await persistLocationForSession(mutableSession, legacyStops, v1Stops, position);
        mutableSession = result.session;
        pointsInserted += result.pointsInserted;
        eventsInserted += result.eventsInserted;
        segmentUpdates += result.segmentUpdates;
        lastUpdate = {
          tripId: mutableSession.tripId,
          pointsInserted,
          eventsInserted,
          segmentUpdates,
          lastFix: result.lastFix,
          nearestStopName: result.nearestStopName,
          nearestStopDistanceM: result.nearestStopDistanceM,
          insideStopName: result.insideStopName,
          insideState: result.insideState,
          lastFilterReason: result.lastFilterReason,
          expectedNextStopName: result.expectedNextStopName,
        };
      }

      await saveActiveTripSession(mutableSession);
      if (lastUpdate && tripUpdateListener) {
        tripUpdateListener(lastUpdate);
      }
    } catch (taskError) {
      await appendAuditLog({
        scope: 'background-task',
        type: 'exception',
        message: taskError instanceof Error ? taskError.message : 'unknown error',
      });
    }
  });
}

async function loadLegacyStopsForDirection(directionCode: DirectionCode): Promise<StopInfo[]> {
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

async function persistLocationForSession(
  session: ActiveTripSession,
  legacyStops: StopInfo[],
  v1Stops: RouteStop[],
  position: Location.LocationObject,
): Promise<{
  session: ActiveTripSession;
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
}> {
  const db = await getDb();
  const coords = position.coords;
  const previous = session.lastFix
    ? {
        lat: session.lastFix.lat,
        lon: session.lastFix.lon,
        timestampMs: session.lastFix.timestampMs,
      }
    : null;

  const computedSpeed = calculateSpeedMps(
    previous,
    {
      lat: coords.latitude,
      lon: coords.longitude,
      timestampMs: position.timestamp,
    },
    coords.speed ?? null,
  );

  const rawPoint = {
    timestampMs: position.timestamp,
    lat: coords.latitude,
    lon: coords.longitude,
    accuracyM: coords.accuracy ?? null,
    speedMps: computedSpeed,
  };
  const filter = filterRawPoint(
    session.lastFix
      ? {
          timestampMs: session.lastFix.timestampMs,
          lat: session.lastFix.lat,
          lon: session.lastFix.lon,
          accuracyM: session.lastFix.accuracyM ?? null,
          speedMps: session.lastFix.speedMps,
        }
      : null,
    rawPoint,
  );
  const settings = await loadSettings();
  const smoothed = applyEmaSmoothing(
    session.lastFix
      ? {
          lat: session.lastFix.smoothedLat ?? session.lastFix.lat,
          lon: session.lastFix.smoothedLon ?? session.lastFix.lon,
          speedMps: session.lastFix.smoothedSpeedMps ?? session.lastFix.speedMps,
        }
      : null,
    {
      lat: rawPoint.lat,
      lon: rawPoint.lon,
      speedMps: rawPoint.speedMps,
    },
    settings.smoothingAlpha,
  );

  await db.runAsync(
    `INSERT INTO gps_point (trip_id, timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg, is_filtered, filter_reason, smoothed_lat, smoothed_lon, smoothed_speed_mps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      session.tripId,
      position.timestamp,
      coords.latitude,
      coords.longitude,
      coords.accuracy ?? null,
      computedSpeed,
      coords.heading ?? null,
      filter.isFiltered ? 1 : 0,
      filter.reason,
      smoothed.lat,
      smoothed.lon,
      smoothed.speedMps,
    ],
  );

  await persistPoint({
    tripId: session.tripId,
    timestampMs: position.timestamp,
    lat: coords.latitude,
    lon: coords.longitude,
    accuracyM: coords.accuracy ?? null,
    altitudeM: coords.altitude ?? null,
    speedMps: computedSpeed,
    headingDeg: coords.heading ?? null,
    isFiltered: filter.isFiltered,
    filterReason: filter.reason,
    smoothedLat: smoothed.lat,
    smoothedLng: smoothed.lon,
    smoothedSpeedMps: smoothed.speedMps,
  });
  await appendAuditLog({
    scope: 'gps-write',
    trip_id: session.tripId,
    ts: position.timestamp,
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy_m: coords.accuracy ?? null,
    speed_mps: computedSpeed,
    is_filtered: filter.isFiltered ? 1 : 0,
    filter_reason: filter.reason,
  });

  const legacyDetection = evaluateStopDetection(session.detectorState, legacyStops, {
    lat: coords.latitude,
    lon: coords.longitude,
    timestampMs: position.timestamp,
  });

  const v1Detection = evaluateSequencedStopDetection(
    session.v1StopState ?? createInitialStopDetectionState(),
    v1Stops,
    {
      timestampMs: position.timestamp,
      lat: filter.isFiltered ? smoothed.lat : coords.latitude,
      lon: filter.isFiltered ? smoothed.lon : coords.longitude,
      speedMps: computedSpeed,
      accuracyM: coords.accuracy ?? null,
    },
    {
      ...DEFAULT_STOP_CONFIG,
      enterRadiusM: settings.enterRadiusM,
      exitRadiusM: settings.exitRadiusM,
    },
  );

  let insertedEvents = 0;
  let segmentUpdates = 0;

  for (const event of legacyDetection.events) {
    await db.runAsync(
      `INSERT INTO stop_event (trip_id, stop_id, event_type, timestamp_ms, dist_m, lat, lon)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [session.tripId, event.stop_id, event.event_type, event.timestamp_ms, event.dist_m, event.lat, event.lon],
    );
    insertedEvents += 1;
  }

  for (const event of v1Detection.events) {
    await persistStopEvent({
      tripId: session.tripId,
      stopId: event.stopId,
      eventType: event.eventType,
      timestampMs: event.timestampMs,
      distToStopM: event.distToStopM,
      speedMps: event.speedMps,
      accuracyM: event.accuracyM,
    });
    insertedEvents += 1;
    segmentUpdates += 1;
  }

  if (segmentUpdates > 0) {
    await rebuildSegmentsForTrip(session.tripId);
  }

  const lastFix: BackgroundTripUpdate['lastFix'] = {
    timestampMs: position.timestamp,
    lat: coords.latitude,
    lon: coords.longitude,
    accuracyM: coords.accuracy ?? null,
    speedMps: computedSpeed,
    headingDeg: coords.heading ?? null,
  };

  const nextSession: ActiveTripSession = {
    ...session,
    detectorState: legacyDetection.nextState,
    v1StopState: v1Detection.nextState,
    lastFix: {
      timestampMs: lastFix.timestampMs,
      lat: lastFix.lat,
      lon: lastFix.lon,
      accuracyM: lastFix.accuracyM,
      speedMps: lastFix.speedMps,
      smoothedLat: smoothed.lat,
      smoothedLon: smoothed.lon,
      smoothedSpeedMps: smoothed.speedMps,
    } satisfies PersistedFix,
  };

  const nextStop = v1Stops[v1Detection.nextState.expectedIndex] ?? null;

  return {
    session: nextSession,
    pointsInserted: 1,
    eventsInserted: insertedEvents,
    segmentUpdates,
    lastFix,
    nearestStopName: legacyDetection.nearestStop?.stop_name ?? null,
    nearestStopDistanceM: legacyDetection.nearestDistanceM,
    insideStopName: legacyDetection.insideStop?.stop_name ?? null,
    insideState: legacyDetection.insideState,
    lastFilterReason: filter.reason,
    expectedNextStopName: nextStop?.name ?? null,
  };
}
