export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusM = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculateSpeedMps(
  previous: { lat: number; lon: number; timestampMs: number } | null,
  current: { lat: number; lon: number; timestampMs: number },
  sensorSpeedMps: number | null,
): number | null {
  if (sensorSpeedMps != null && Number.isFinite(sensorSpeedMps) && sensorSpeedMps >= 0) {
    return sensorSpeedMps;
  }

  if (!previous) {
    return null;
  }

  const dtSeconds = (current.timestampMs - previous.timestampMs) / 1000;
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return null;
  }

  const distanceM = haversineMeters(previous.lat, previous.lon, current.lat, current.lon);
  return distanceM / dtSeconds;
}
