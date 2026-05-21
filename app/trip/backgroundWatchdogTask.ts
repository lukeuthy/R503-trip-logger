import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import BackgroundGeolocation from 'react-native-background-geolocation';

import { getDb, waitForDbInitialized } from '../database/db';
import { appendAuditLog } from '../src/services/location/fileAudit';
import { SENSING_CONFIG } from '../src/utils/experimentConfig';
import { loadActiveTripSession } from './activeTripStore';

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

      // With RNBG, start() is idempotent — safe to call even if already running.
      // RNBG's START_STICKY service restarts itself natively; this is a belt-and-
      // suspenders nudge from the out-of-process watchdog.
      const rnbgState = await BackgroundGeolocation.getState();

      if (rnbgState.enabled) {
        await appendAuditLog({
          scope: 'background-watchdog',
          action: 'rnbg-already-running',
          trip_id: session.tripId,
          age_ms: ageMs,
        });
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }

      await BackgroundGeolocation.start();

      await db.runAsync(
        `UPDATE trip_sessions
         SET task_restart_count = COALESCE(task_restart_count, 0) + 1
         WHERE trip_id = ?;`,
        [session.tripId],
      );

      await appendAuditLog({
        scope: 'background-watchdog',
        action: 'rnbg-restarted',
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
