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
  jumpDistanceM: number | null;
}

export interface SmoothedFix {
  lat: number;
  lon: number;
  speedMps: number | null;
}

const MAX_BUS_SPEED_MPS = 45;
const MAX_ALLOWED_ACCURACY_M = 50;
const MAX_SHORT_BOUNCE_DISTANCE_M = 120;

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
    return { isFiltered: true, reason: 'invalid-coordinates', impliedSpeedMps: null, jumpDistanceM: null };
  }
  if (current.accuracyM != null && current.accuracyM > MAX_ALLOWED_ACCURACY_M) {
    return { isFiltered: true, reason: 'low-quality-accuracy', impliedSpeedMps: null, jumpDistanceM: null };
  }
  if (!previous) {
    return { isFiltered: false, reason: null, impliedSpeedMps: null, jumpDistanceM: null };
  }

  const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
  if (dtSec <= 0 || dtSec > 600) {
    return { isFiltered: true, reason: 'invalid-timestamp-gap', impliedSpeedMps: null, jumpDistanceM: null };
  }

  const distanceM = haversineMeters(previous.lat, previous.lon, current.lat, current.lon);
  const impliedSpeedMps = distanceM / dtSec;
  if (impliedSpeedMps > MAX_BUS_SPEED_MPS) {
    return { isFiltered: true, reason: 'teleport-jump', impliedSpeedMps, jumpDistanceM: distanceM };
  }
  if (dtSec <= 2 && distanceM > MAX_SHORT_BOUNCE_DISTANCE_M) {
    return { isFiltered: true, reason: 'short-interval-bounce', impliedSpeedMps, jumpDistanceM: distanceM };
  }
  if (previous.accuracyM != null && current.accuracyM != null && current.accuracyM > previous.accuracyM * 2 && impliedSpeedMps > 15) {
    return { isFiltered: true, reason: 'accuracy-spike-motion', impliedSpeedMps, jumpDistanceM: distanceM };
  }

  return { isFiltered: false, reason: null, impliedSpeedMps, jumpDistanceM: distanceM };
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

export function deriveHeadingDeg(
  previous: { lat: number; lon: number } | null,
  current: { lat: number; lon: number },
): number | null {
  if (!previous) {
    return null;
  }
  const lat1 = toRadians(previous.lat);
  const lat2 = toRadians(current.lat);
  const dLon = toRadians(current.lon - previous.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  const normalized = (bearing + 360) % 360;
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return normalized;
}
