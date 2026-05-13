import * as BackgroundFetch from 'expo-background-fetch';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import { AppState } from 'react-native';

import { getDb, waitForDbInitialized } from '../database/db';
import { appendAuditLog } from '../src/services/location/fileAudit';
import { SENSING_CONFIG } from '../src/utils/experimentConfig';
import { R503_BACKGROUND_TASK } from './backgroundLocationTask';
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
      const gapThresholdMs = Math.max(
        90_000,
        SENSING_CONFIG.samplingIntervalMs * 60,
      );

      if (ageMs < gapThresholdMs) {
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      const running = await Location.hasStartedLocationUpdatesAsync(R503_BACKGROUND_TASK);
      try {
        await activateKeepAwakeAsync('r503-gps');
      } catch {
        // best-effort
      }

      // If the task registration is still alive, do nothing destructive —
      // the OS will continue delivering callbacks. We do NOT call stop here
      // because we cannot restart a foreground service from the background.
      if (running) {
        await appendAuditLog({
          scope: 'background-watchdog',
          action: 'reacquired-wakelock',
          trip_id: session.tripId,
          age_ms: ageMs,
        });
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }

      // Task registration is gone. Foreground service restart only works
      // while the app is foregrounded (Android 12+ restriction). If we're
      // backgrounded, log the gap and wait for the user to open the app —
      // attempting startLocationUpdatesAsync here will throw
      // ForegroundServiceStartNotAllowedException and waste a wake-up slot.
      const appForeground = AppState.currentState === 'active';
      if (!appForeground && SENSING_CONFIG.useForegroundService) {
        await appendAuditLog({
          scope: 'background-watchdog',
          action: 'restart-skipped',
          trip_id: session.tripId,
          reason: 'app-backgrounded-fg-service-restricted',
          age_ms: ageMs,
        });
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      await Location.startLocationUpdatesAsync(R503_BACKGROUND_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: SENSING_CONFIG.samplingIntervalMs,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        ...(SENSING_CONFIG.useForegroundService
          ? {
              foregroundService: {
                notificationTitle: 'R503 Logger',
                notificationBody: 'Recovering GPS tracking',
                killServiceOnDestroy: false,
              } as Location.LocationTaskServiceOptions,
            }
          : {}),
      });

      await db.runAsync(
        `UPDATE trip_sessions
         SET task_restart_count = COALESCE(task_restart_count, 0) + 1
         WHERE trip_id = ?;`,
        [session.tripId],
      );

      await appendAuditLog({
        scope: 'background-watchdog',
        action: 'resubscribed',
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
