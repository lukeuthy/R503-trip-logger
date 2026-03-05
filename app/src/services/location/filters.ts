export interface GeoFix {
  timestampMs: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
}

export interface FilterResult {
  isFiltered: boolean;
  reason: string | null;
  impliedSpeedMps: number | null;
}

export interface SmoothedFix {
  lat: number;
  lon: number;
  speedMps: number | null;
}

const MAX_BUS_SPEED_MPS = 45;
const MAX_ALLOWED_ACCURACY_M = 50;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function filterRawPoint(previous: GeoFix | null, current: GeoFix): FilterResult {
  if (!Number.isFinite(current.lat) || !Number.isFinite(current.lon)) {
    return { isFiltered: true, reason: 'invalid-coordinates', impliedSpeedMps: null };
  }
  if (current.accuracyM != null && current.accuracyM > MAX_ALLOWED_ACCURACY_M) {
    return { isFiltered: true, reason: 'low-quality-accuracy', impliedSpeedMps: null };
  }
  if (!previous) {
    return { isFiltered: false, reason: null, impliedSpeedMps: null };
  }

  const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
  if (dtSec <= 0 || dtSec > 600) {
    return { isFiltered: true, reason: 'invalid-timestamp-gap', impliedSpeedMps: null };
  }

  const distanceM = haversineMeters(previous.lat, previous.lon, current.lat, current.lon);
  const impliedSpeedMps = distanceM / dtSec;
  if (impliedSpeedMps > MAX_BUS_SPEED_MPS) {
    return { isFiltered: true, reason: 'teleport-jump', impliedSpeedMps };
  }

  return { isFiltered: false, reason: null, impliedSpeedMps };
}

export function applyEmaSmoothing(
  previous: SmoothedFix | null,
  current: { lat: number; lon: number; speedMps: number | null },
  alpha = 0.25,
): SmoothedFix {
  if (!previous) {
    return { lat: current.lat, lon: current.lon, speedMps: current.speedMps };
  }
  const clampedAlpha = Math.max(0.05, Math.min(0.95, alpha));
  const nextSpeed =
    previous.speedMps == null || current.speedMps == null
      ? current.speedMps
      : clampedAlpha * current.speedMps + (1 - clampedAlpha) * previous.speedMps;
  return {
    lat: clampedAlpha * current.lat + (1 - clampedAlpha) * previous.lat,
    lon: clampedAlpha * current.lon + (1 - clampedAlpha) * previous.lon,
    speedMps: nextSpeed,
  };
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}
