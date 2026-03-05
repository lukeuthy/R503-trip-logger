import { haversineMeters } from './filters';

export interface RouteStop {
  stopId: string;
  stopOrder: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface StopDetectionState {
  expectedIndex: number;
  activeStopId: string | null;
  enteredAtMs: number | null;
  departCandidateSinceMs: number | null;
}

export interface StopDetectionConfig {
  enterRadiusM: number;
  exitRadiusM: number;
  arriveSpeedMps: number;
  departSpeedMps: number;
  dwellMs: number;
  departSpeedHoldMs: number;
}

export interface StopEventCandidate {
  stopId: string;
  eventType: 'arrive' | 'depart';
  timestampMs: number;
  distToStopM: number;
  speedMps: number | null;
  accuracyM: number | null;
}

export interface StopDetectionOutput {
  nextState: StopDetectionState;
  nearestStopId: string | null;
  nearestDistanceM: number | null;
  activeStopId: string | null;
  events: StopEventCandidate[];
}

export const DEFAULT_STOP_CONFIG: StopDetectionConfig = {
  enterRadiusM: 40,
  exitRadiusM: 60,
  arriveSpeedMps: 3,
  departSpeedMps: 5,
  dwellMs: 10_000,
  departSpeedHoldMs: 5_000,
};

export function createInitialStopDetectionState(): StopDetectionState {
  return {
    expectedIndex: 0,
    activeStopId: null,
    enteredAtMs: null,
    departCandidateSinceMs: null,
  };
}

export function evaluateSequencedStopDetection(
  state: StopDetectionState,
  stops: RouteStop[],
  point: {
    timestampMs: number;
    lat: number;
    lon: number;
    speedMps: number | null;
    accuracyM: number | null;
  },
  config: StopDetectionConfig = DEFAULT_STOP_CONFIG,
): StopDetectionOutput {
  if (stops.length === 0) {
    return {
      nextState: state,
      nearestStopId: null,
      nearestDistanceM: null,
      activeStopId: null,
      events: [],
    };
  }

  const nearest = getNearestStop(stops, point.lat, point.lon);
  const expectedStop = stops[Math.min(state.expectedIndex, stops.length - 1)] ?? null;
  const targetStop = expectedStop ?? nearest.stop;
  const distToTargetM = targetStop ? haversineMeters(point.lat, point.lon, targetStop.lat, targetStop.lng) : null;

  const next: StopDetectionState = { ...state };
  const events: StopEventCandidate[] = [];

  if (!targetStop || distToTargetM == null) {
    return {
      nextState: next,
      nearestStopId: nearest.stop?.stopId ?? null,
      nearestDistanceM: nearest.distanceM,
      activeStopId: next.activeStopId,
      events,
    };
  }

  const lowSpeed = (point.speedMps ?? 0) < config.arriveSpeedMps;
  if (next.activeStopId == null && distToTargetM <= config.enterRadiusM) {
    if (next.enteredAtMs == null) {
      next.enteredAtMs = point.timestampMs;
    }
    const dwellMs = point.timestampMs - next.enteredAtMs;
    if (lowSpeed || dwellMs >= config.dwellMs) {
      next.activeStopId = targetStop.stopId;
      next.departCandidateSinceMs = null;
      events.push({
        stopId: targetStop.stopId,
        eventType: 'arrive',
        timestampMs: point.timestampMs,
        distToStopM: distToTargetM,
        speedMps: point.speedMps,
        accuracyM: point.accuracyM,
      });
    }
  } else if (next.activeStopId) {
    const activeStop = stops.find((stop) => stop.stopId === next.activeStopId);
    if (activeStop) {
      const activeDistM = haversineMeters(point.lat, point.lon, activeStop.lat, activeStop.lng);
      const highSpeed = (point.speedMps ?? 0) > config.departSpeedMps;

      if (highSpeed) {
        if (next.departCandidateSinceMs == null) {
          next.departCandidateSinceMs = point.timestampMs;
        }
      } else {
        next.departCandidateSinceMs = null;
      }

      const speedHeldLongEnough =
        next.departCandidateSinceMs != null && point.timestampMs - next.departCandidateSinceMs >= config.departSpeedHoldMs;

      if (activeDistM >= config.exitRadiusM || speedHeldLongEnough) {
        events.push({
          stopId: activeStop.stopId,
          eventType: 'depart',
          timestampMs: point.timestampMs,
          distToStopM: activeDistM,
          speedMps: point.speedMps,
          accuracyM: point.accuracyM,
        });
        next.activeStopId = null;
        next.enteredAtMs = null;
        next.departCandidateSinceMs = null;
        next.expectedIndex = Math.min(next.expectedIndex + 1, stops.length - 1);
      }
    }
  } else {
    next.enteredAtMs = null;
  }

  return {
    nextState: next,
    nearestStopId: nearest.stop?.stopId ?? null,
    nearestDistanceM: nearest.distanceM,
    activeStopId: next.activeStopId,
    events,
  };
}

function getNearestStop(
  stops: RouteStop[],
  lat: number,
  lon: number,
): {
  stop: RouteStop | null;
  distanceM: number | null;
} {
  let nearest: RouteStop | null = null;
  let nearestDistanceM: number | null = null;

  for (const stop of stops) {
    const distanceM = haversineMeters(lat, lon, stop.lat, stop.lng);
    if (nearestDistanceM == null || distanceM < nearestDistanceM) {
      nearest = stop;
      nearestDistanceM = distanceM;
    }
  }

  return {
    stop: nearest,
    distanceM: nearestDistanceM,
  };
}
