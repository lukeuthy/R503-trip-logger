import * as FileSystem from 'expo-file-system/legacy';

import type { DirectionCode, WindowCode } from '../models/Trip';
import type { StopDetectorState } from './stopDetector';

export interface PersistedFix {
  timestampMs: number;
  lat: number;
  lon: number;
  speedMps: number | null;
}

export interface ActiveTripSession {
  tripId: string;
  routeNumber: 'R503';
  directionCode: DirectionCode;
  windowCode: WindowCode;
  startedAtMs: number;
  detectorState: StopDetectorState;
  lastFix: PersistedFix | null;
}

const SESSION_FILE_NAME = 'active_trip_session.json';

function getSessionPath(): string {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error('documentDirectory is unavailable.');
  }
  return `${baseDir}${SESSION_FILE_NAME}`;
}

export async function loadActiveTripSession(): Promise<ActiveTripSession | null> {
  const path = getSessionPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return null;
  }

  const raw = await FileSystem.readAsStringAsync(path);
  const parsed = JSON.parse(raw) as ActiveTripSession;

  if (!parsed?.tripId) {
    return null;
  }
  return parsed;
}

export async function saveActiveTripSession(session: ActiveTripSession): Promise<void> {
  const path = getSessionPath();
  await FileSystem.writeAsStringAsync(path, JSON.stringify(session));
}

export async function clearActiveTripSession(): Promise<void> {
  const path = getSessionPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return;
  }
  await FileSystem.deleteAsync(path, { idempotent: true });
}
