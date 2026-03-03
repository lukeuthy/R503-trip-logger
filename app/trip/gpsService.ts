import * as Location from 'expo-location';

export interface GPSFix {
  timestampMs: number;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
}

export type GPSFixCallback = (fix: GPSFix) => void;

export async function ensureForegroundLocationReady(): Promise<void> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') {
    throw new Error('Location permission denied.');
  }

  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    throw new Error('Location services are OFF. Please enable GPS/location services.');
  }
}

export async function startGPSWatch(onFix: GPSFixCallback): Promise<Location.LocationSubscription> {
  await ensureForegroundLocationReady();

  try {
    return await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
        distanceInterval: 0,
        mayShowUserSettingsDialog: true,
      },
      (position) => {
        const coords = position.coords;
        onFix({
          timestampMs: position.timestamp,
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracyM: coords.accuracy ?? null,
          speedMps: coords.speed ?? null,
          headingDeg: coords.heading ?? null,
        });
      },
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to start GPS watch: ${error.message}`);
    }
    throw new Error('Failed to start GPS watch due to an unknown error.');
  }
}
