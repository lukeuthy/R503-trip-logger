import { haversineMeters } from './speedCalculator';

const ENTER_DISTANCE_M = 35;
const EXIT_DISTANCE_M = 60;
const DWELL_MS = 10_000;

export interface StopInfo {
  stop_id: number;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
  direction_code: string;
}

export interface StopDetectorState {
  currentStopId: number | null;
  enteredAtMs: number | null;
  dwellConfirmedStopId: number | null;
}

export interface DetectedStopEvent {
  stop_id: number;
  event_type: 'arrive' | 'depart' | 'dwell';
  timestamp_ms: number;
  dist_m: number;
  lat: number | null;
  lon: number | null;
}

export interface StopDetectorResult {
  nearestStop: StopInfo | null;
  nearestDistanceM: number | null;
  insideStop: StopInfo | null;
  insideState: 'INSIDE' | 'OUTSIDE';
  events: DetectedStopEvent[];
  nextState: StopDetectorState;
}

export function getStopDetectionConfig(): {
  enterDistanceM: number;
  exitDistanceM: number;
  dwellMs: number;
} {
  return {
    enterDistanceM: ENTER_DISTANCE_M,
    exitDistanceM: EXIT_DISTANCE_M,
    dwellMs: DWELL_MS,
  };
}

export function createInitialStopDetectorState(): StopDetectorState {
  return {
    currentStopId: null,
    enteredAtMs: null,
    dwellConfirmedStopId: null,
  };
}

export function evaluateStopDetection(
  state: StopDetectorState,
  stops: StopInfo[],
  current: { lat: number; lon: number; timestampMs: number },
): StopDetectorResult {
  if (stops.length === 0) {
    return {
      nearestStop: null,
      nearestDistanceM: null,
      insideStop: null,
      insideState: 'OUTSIDE',
      events: [],
      nextState: state,
    };
  }

  let nearestStop = stops[0];
  let nearestDistanceM = haversineMeters(current.lat, current.lon, nearestStop.lat, nearestStop.lon);
  let activeDistanceM: number | null = null;

  for (const stop of stops) {
    const distanceM = haversineMeters(current.lat, current.lon, stop.lat, stop.lon);
    if (distanceM < nearestDistanceM) {
      nearestDistanceM = distanceM;
      nearestStop = stop;
    }
    if (state.currentStopId === stop.stop_id) {
      activeDistanceM = distanceM;
    }
  }

  const nextState: StopDetectorState = { ...state };
  const events: DetectedStopEvent[] = [];
  let insideStop: StopInfo | null = null;

  if (state.currentStopId != null && activeDistanceM != null && activeDistanceM >= EXIT_DISTANCE_M) {
    events.push({
      stop_id: state.currentStopId,
      event_type: 'depart',
      timestamp_ms: current.timestampMs,
      dist_m: activeDistanceM,
      lat: current.lat,
      lon: current.lon,
    });
    nextState.currentStopId = null;
    nextState.enteredAtMs = null;
    nextState.dwellConfirmedStopId = null;
  }

  if (nearestDistanceM <= ENTER_DISTANCE_M && nearestStop.stop_id !== nextState.currentStopId) {
    nextState.currentStopId = nearestStop.stop_id;
    nextState.enteredAtMs = current.timestampMs;
    nextState.dwellConfirmedStopId = null;
    events.push({
      stop_id: nearestStop.stop_id,
      event_type: 'arrive',
      timestamp_ms: current.timestampMs,
      dist_m: nearestDistanceM,
      lat: current.lat,
      lon: current.lon,
    });
  }

  if (nextState.currentStopId != null) {
    insideStop = stops.find((stop) => stop.stop_id === nextState.currentStopId) ?? null;
    if (insideStop) {
      const insideDistanceM = haversineMeters(current.lat, current.lon, insideStop.lat, insideStop.lon);
      if (insideDistanceM <= ENTER_DISTANCE_M) {
        if (nextState.enteredAtMs == null) {
          nextState.enteredAtMs = current.timestampMs;
        }
        const dwellMs = current.timestampMs - nextState.enteredAtMs;
        if (dwellMs >= DWELL_MS && nextState.dwellConfirmedStopId !== insideStop.stop_id) {
          nextState.dwellConfirmedStopId = insideStop.stop_id;
          events.push({
            stop_id: insideStop.stop_id,
            event_type: 'dwell',
            timestamp_ms: current.timestampMs,
            dist_m: insideDistanceM,
            lat: current.lat,
            lon: current.lon,
          });
        }
      }
    }
  }

  return {
    nearestStop,
    nearestDistanceM,
    insideStop,
    insideState: insideStop ? 'INSIDE' : 'OUTSIDE',
    events,
    nextState,
  };
}
