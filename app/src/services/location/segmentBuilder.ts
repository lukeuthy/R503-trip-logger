import { haversineMeters } from './filters';

export interface SegmentInputEvent {
  stopId: string;
  eventType: 'arrive' | 'depart';
  timestampMs: number;
}

export interface SegmentInputPoint {
  timestampMs: number;
  lat: number;
  lon: number;
  speedMps: number | null;
  accuracyM: number | null;
}

export interface DerivedSegment {
  fromStopId: string;
  toStopId: string;
  startTsMs: number;
  endTsMs: number;
  travelTimeSec: number;
  distanceM: number;
  avgSpeedMps: number | null;
  p95SpeedMps: number | null;
  meanAccuracyM: number | null;
}

export function deriveSegments(events: SegmentInputEvent[], points: SegmentInputPoint[]): DerivedSegment[] {
  const orderedEvents = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const orderedPoints = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  const segments: DerivedSegment[] = [];

  for (let index = 0; index < orderedEvents.length - 1; index += 1) {
    const first = orderedEvents[index];
    const second = orderedEvents[index + 1];
    if (first.eventType !== 'depart' || second.eventType !== 'arrive') {
      continue;
    }
    if (second.timestampMs <= first.timestampMs) {
      continue;
    }

    const windowPoints = orderedPoints.filter(
      (point) => point.timestampMs >= first.timestampMs && point.timestampMs <= second.timestampMs,
    );

    const distanceM = getPolylineDistance(windowPoints);
    const speedValues = windowPoints.map((point) => point.speedMps).filter((value): value is number => value != null);
    const accuracyValues = windowPoints
      .map((point) => point.accuracyM)
      .filter((value): value is number => value != null && Number.isFinite(value));

    segments.push({
      fromStopId: first.stopId,
      toStopId: second.stopId,
      startTsMs: first.timestampMs,
      endTsMs: second.timestampMs,
      travelTimeSec: Math.max(1, Math.round((second.timestampMs - first.timestampMs) / 1000)),
      distanceM,
      avgSpeedMps: mean(speedValues),
      p95SpeedMps: percentile(speedValues, 95),
      meanAccuracyM: mean(accuracyValues),
    });
  }

  return segments;
}

function getPolylineDistance(points: SegmentInputPoint[]): number {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const curr = points[index];
    total += haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
  }
  return total;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((percentileRank / 100) * (sorted.length - 1));
  return sorted[index] ?? null;
}
