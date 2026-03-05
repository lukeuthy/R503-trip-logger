import {
  ensureBackgroundLocationReady,
  isBackgroundTrackingRunning,
  startBackgroundTracking,
  stopBackgroundTracking,
} from '../../../trip/backgroundLocationTask';

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
