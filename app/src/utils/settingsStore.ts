import * as FileSystem from 'expo-file-system/legacy';

export interface AppSettings {
  deviceId: string | null;
  debugOverlayEnabled: boolean;
  chartsMode: boolean;
  smoothingAlpha: number;
  enterRadiusM: number;
  exitRadiusM: number;
}

const SETTINGS_FILE = 'trip_logger_settings.json';

const DEFAULT_SETTINGS: AppSettings = {
  deviceId: null,
  debugOverlayEnabled: false,
  chartsMode: true,
  smoothingAlpha: 0.25,
  enterRadiusM: 40,
  exitRadiusM: 60,
};

function getSettingsPath(): string {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error('documentDirectory unavailable');
  }
  return `${baseDir}${SETTINGS_FILE}`;
}

export async function loadSettings(merge?: Partial<AppSettings>): Promise<AppSettings> {
  const path = getSettingsPath();
  const info = await FileSystem.getInfoAsync(path);
  let loaded = DEFAULT_SETTINGS;
  if (info.exists) {
    try {
      const raw = await FileSystem.readAsStringAsync(path);
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      loaded = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      loaded = DEFAULT_SETTINGS;
    }
  }
  if (!merge) {
    return loaded;
  }
  const next = { ...loaded, ...merge };
  await FileSystem.writeAsStringAsync(path, JSON.stringify(next));
  return next;
}

export async function saveSettings(nextPatch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const next = { ...current, ...nextPatch };
  const path = getSettingsPath();
  await FileSystem.writeAsStringAsync(path, JSON.stringify(next));
  return next;
}
