import {
  ensureBackgroundLocationReady,
  isBackgroundTrackingRunning,
  startBackgroundTracking,
  stopBackgroundTracking,
} from '../../../trip/backgroundLocationTask';
import { SENSING_CONFIG } from '../../utils/experimentConfig';

export function getTrackerIntervals(): { samplingIntervalMs: number; fastestIntervalMs: number } {
  return {
    samplingIntervalMs: SENSING_CONFIG.samplingIntervalMs,
    fastestIntervalMs: SENSING_CONFIG.fastestIntervalMs,
  };
}

export async function ensureTrackerReady(): Promise<void> {
  await ensureBackgroundLocationReady();
}

export async function startTracker(): Promise<void> {
  await startBackgroundTracking();
}

export async function stopTracker(): Promise<void> {
  await stopBackgroundTracking();
}

export async function isTrackerRunning(): Promise<boolean> {
  return isBackgroundTrackingRunning();
}
