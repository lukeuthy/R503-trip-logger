import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNEL_ID = 'r503-trip-stats';
const NOTIFICATION_ID = 'r503-trip-live-stats';

let configured = false;
let lastBody: string | null = null;

async function ensureConfigured(): Promise<void> {
  if (configured) {
    return;
  }
  configured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: false,
      shouldShowList: true,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'R503 Trip Stats',
      importance: Notifications.AndroidImportance.LOW,
      sound: null,
      vibrationPattern: null,
      enableVibrate: false,
      showBadge: false,
      description: 'Live trip recording stats. Tap to open the app.',
    });
  }

  try {
    await Notifications.requestPermissionsAsync({
      android: {},
      ios: { allowAlert: false, allowBadge: false, allowSound: false },
    });
  } catch {
    // best-effort
  }
}

export interface TripNotificationFields {
  tripId: string;
  elapsedSec: number;
  pointsCount: number;
  lastGpsAgeSec: number | null;
  taskRestartCount: number;
  variantLabel: string;
  wakeLockHeld: boolean;
}

function formatElapsed(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatGpsAge(ageSec: number | null): string {
  if (ageSec == null) {
    return 'pending';
  }
  if (ageSec < 60) {
    return `${Math.max(0, Math.floor(ageSec))}s ago`;
  }
  return `${Math.floor(ageSec / 60)}m ago`;
}

export async function publishTripNotification(fields: TripNotificationFields): Promise<void> {
  await ensureConfigured();
  const shortId = fields.tripId.slice(0, 8);
  const wakeFlag = fields.wakeLockHeld ? 'WL✓' : 'WL✗';
  const body =
    `${fields.variantLabel} · ${formatElapsed(fields.elapsedSec)} · ${fields.pointsCount} pts ` +
    `· last fix ${formatGpsAge(fields.lastGpsAgeSec)} · restarts ${fields.taskRestartCount} · ${wakeFlag}`;
  if (body === lastBody) {
    return;
  }
  lastBody = body;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: `R503 Trip ${shortId}`,
        body,
        sticky: true,
        autoDismiss: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    // best-effort
  }
}

export async function clearTripNotification(): Promise<void> {
  lastBody = null;
  try {
    await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  } catch {
    // best-effort
  }
}
