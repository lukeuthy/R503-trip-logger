import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { getDb } from '../database/db';
import type { DirectionCode } from '../models/Trip';
import { calculateSpeedMps } from './speedCalculator';
import type { ActiveTripSession, PersistedFix } from './activeTripStore';
import { loadActiveTripSession, saveActiveTripSession } from './activeTripStore';
import { evaluateStopDetection, type StopInfo } from './stopDetector';

export const R503_BACKGROUND_TASK = 'R503_BACKGROUND_LOCATION_TASK';

export interface BackgroundTripUpdate {
  tripId: string;
  pointsInserted: number;
  eventsInserted: number;
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
    accuracy: Location.Accuracy.High,
    timeInterval: 1000,
    distanceInterval: 0,
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
  TaskManager.defineTask(R503_BACKGROUND_TASK, async (taskBody: TaskManager.TaskManagerTaskBody<{
    locations?: Location.LocationObject[];
  }>) => {
    const { data, error } = taskBody;
    if (error) {
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

    const stops = await loadStopsForDirection(session.directionCode);

    let pointsInserted = 0;
    let eventsInserted = 0;
    let lastUpdate: BackgroundTripUpdate | null = null;
    let mutableSession: ActiveTripSession = session;

    for (const position of locations) {
      const result = await persistLocationForSession(mutableSession, stops, position);
      mutableSession = result.session;
      pointsInserted += result.pointsInserted;
      eventsInserted += result.eventsInserted;
      lastUpdate = {
        tripId: mutableSession.tripId,
        pointsInserted,
        eventsInserted,
        lastFix: result.lastFix,
        nearestStopName: result.nearestStopName,
        nearestStopDistanceM: result.nearestStopDistanceM,
        insideStopName: result.insideStopName,
        insideState: result.insideState,
      };
    }

    await saveActiveTripSession(mutableSession);
    if (lastUpdate && tripUpdateListener) {
      tripUpdateListener(lastUpdate);
    }
  });
}

async function loadStopsForDirection(directionCode: DirectionCode): Promise<StopInfo[]> {
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
  stops: StopInfo[],
  position: Location.LocationObject,
): Promise<{
  session: ActiveTripSession;
  pointsInserted: number;
  eventsInserted: number;
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

  await db.runAsync(
    `INSERT INTO gps_point (trip_id, timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      session.tripId,
      position.timestamp,
      coords.latitude,
      coords.longitude,
      coords.accuracy ?? null,
      computedSpeed,
      coords.heading ?? null,
    ],
  );

  const detection = evaluateStopDetection(session.detectorState, stops, {
    lat: coords.latitude,
    lon: coords.longitude,
    timestampMs: position.timestamp,
  });

  let insertedEvents = 0;
  for (const event of detection.events) {
    await db.runAsync(
      `INSERT INTO stop_event (trip_id, stop_id, event_type, timestamp_ms, dist_m, lat, lon)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [session.tripId, event.stop_id, event.event_type, event.timestamp_ms, event.dist_m, event.lat, event.lon],
    );
    insertedEvents += 1;
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
    detectorState: detection.nextState,
    lastFix: {
      timestampMs: lastFix.timestampMs,
      lat: lastFix.lat,
      lon: lastFix.lon,
      speedMps: lastFix.speedMps,
    } satisfies PersistedFix,
  };

  return {
    session: nextSession,
    pointsInserted: 1,
    eventsInserted: insertedEvents,
    lastFix,
    nearestStopName: detection.nearestStop?.stop_name ?? null,
    nearestStopDistanceM: detection.nearestDistanceM,
    insideStopName: detection.insideStop?.stop_name ?? null,
    insideState: detection.insideState,
  };
}
