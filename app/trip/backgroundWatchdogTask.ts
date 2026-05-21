import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';

import { getDb, waitForDbInitialized } from '../database/db';
import { appendAuditLog } from '../src/services/location/fileAudit';
import { SENSING_CONFIG } from '../src/utils/experimentConfig';
import { loadActiveTripSession } from './activeTripStore';
import { isBackgroundTrackingRunning, restartBackgroundTracking } from './backgroundLocationTask';

export const R503_BACKGROUND_WATCHDOG_TASK = 'R503_BACKGROUND_WATCHDOG_TASK';

const MIN_INTERVAL_SEC = 15 * 60;

if (!TaskManager.isTaskDefined(R503_BACKGROUND_WATCHDOG_TASK)) {
  TaskManager.defineTask(R503_BACKGROUND_WATCHDOG_TASK, async () => {
    try {
      if (!(await waitForDbInitialized(3000))) {
        await appendAuditLog({
          scope: 'background-watchdog',
          action: 'skipped',
          reason: 'db-not-ready',
        });
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      const session = await loadActiveTripSession();
      if (!session) {
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      const db = await getDb();
      const sessionRow = await db.getFirstAsync<{ ended_at: string | null }>(
        'SELECT ended_at FROM trip_sessions WHERE trip_id = ?;',
        [session.tripId],
      );
      if (!sessionRow || sessionRow.ended_at != null) {
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      const lastRow = await db.getFirstAsync<{ timestamp_ms: number | null }>(
        'SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?;',
        [session.tripId],
      );
      const lastMs = lastRow?.timestamp_ms ?? null;
      const ageMs = lastMs != null ? Date.now() - lastMs : Date.now() - session.startedAtMs;
      const gapThresholdMs = Math.max(90_000, SENSING_CONFIG.samplingIntervalMs * 60);

      if (ageMs < gapThresholdMs) {
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      // Belt-and-suspenders nudge: if the native service is already alive (JS
      // tracking flag still true), nothing to do. Otherwise restart it.
      if (await isBackgroundTrackingRunning()) {
        await appendAuditLog({
          scope: 'background-watchdog',
          action: 'service-already-running',
          trip_id: session.tripId,
          age_ms: ageMs,
        });
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }

      await restartBackgroundTracking();

      await db.runAsync(
        `UPDATE trip_sessions
         SET task_restart_count = COALESCE(task_restart_count, 0) + 1
         WHERE trip_id = ?;`,
        [session.tripId],
      );

      await appendAuditLog({
        scope: 'background-watchdog',
        action: 'service-restarted',
        trip_id: session.tripId,
        age_ms: ageMs,
        threshold_ms: gapThresholdMs,
      });

      return BackgroundFetch.BackgroundFetchResult.NewData;
    } catch (error) {
      await appendAuditLog({
        scope: 'background-watchdog',
        action: 'exception',
        message: error instanceof Error ? error.message : 'unknown error',
      });
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
}

export async function registerBackgroundWatchdog(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(R503_BACKGROUND_WATCHDOG_TASK);
    if (isRegistered) {
      return;
    }
    await BackgroundFetch.registerTaskAsync(R503_BACKGROUND_WATCHDOG_TASK, {
      minimumInterval: MIN_INTERVAL_SEC,
      stopOnTerminate: false,
      startOnBoot: false,
    });
    await appendAuditLog({
      scope: 'background-watchdog',
      action: 'registered',
      minimum_interval_sec: MIN_INTERVAL_SEC,
    });
  } catch (error) {
    await appendAuditLog({
      scope: 'background-watchdog',
      action: 'register-failed',
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
