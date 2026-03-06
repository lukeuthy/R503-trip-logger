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

export interface SegmentDerivationMeta {
  suppressed: Array<{ reason: string; fromStopId?: string; toStopId?: string; atTsMs: number }>;
  completed: number;
}

export function deriveSegments(
  events: SegmentInputEvent[],
  points: SegmentInputPoint[],
  stopOrderByStopId: Record<string, number>,
): { segments: DerivedSegment[]; meta: SegmentDerivationMeta } {
  const orderedEvents = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const orderedPoints = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  const segments: DerivedSegment[] = [];
  const suppressed: SegmentDerivationMeta['suppressed'] = [];

  let pendingDepart: SegmentInputEvent | null = null;
  const usedKeys = new Set<string>();

  for (const event of orderedEvents) {
    const eventOrder = stopOrderByStopId[event.stopId];
    if (eventOrder == null) {
      suppressed.push({ reason: 'unknown-stop-order', fromStopId: event.stopId, atTsMs: event.timestampMs });
      continue;
    }

    if (event.eventType === 'depart') {
      if (pendingDepart && pendingDepart.stopId === event.stopId) {
        suppressed.push({ reason: 'duplicate-depart-same-stop', fromStopId: event.stopId, atTsMs: event.timestampMs });
        continue;
      }
      pendingDepart = event;
      continue;
    }

    if (!pendingDepart) {
      suppressed.push({ reason: 'arrive-without-depart', toStopId: event.stopId, atTsMs: event.timestampMs });
      continue;
    }

    const fromOrder = stopOrderByStopId[pendingDepart.stopId];
    const toOrder = stopOrderByStopId[event.stopId];
    if (fromOrder == null || toOrder == null) {
      suppressed.push({
        reason: 'missing-stop-order-on-transition',
        fromStopId: pendingDepart.stopId,
        toStopId: event.stopId,
        atTsMs: event.timestampMs,
      });
      pendingDepart = null;
      continue;
    }
    if (toOrder !== fromOrder + 1) {
      suppressed.push({
        reason: 'non-consecutive-transition',
        fromStopId: pendingDepart.stopId,
        toStopId: event.stopId,
        atTsMs: event.timestampMs,
      });
      continue;
    }
    if (event.timestampMs <= pendingDepart.timestampMs) {
      suppressed.push({
        reason: 'non-forward-time-transition',
        fromStopId: pendingDepart.stopId,
        toStopId: event.stopId,
        atTsMs: event.timestampMs,
      });
      continue;
    }

    const dedupeKey = `${pendingDepart.stopId}->${event.stopId}@${pendingDepart.timestampMs}->${event.timestampMs}`;
    if (usedKeys.has(dedupeKey)) {
      suppressed.push({
        reason: 'duplicate-segment-window',
        fromStopId: pendingDepart.stopId,
        toStopId: event.stopId,
        atTsMs: event.timestampMs,
      });
      pendingDepart = null;
      continue;
    }
    usedKeys.add(dedupeKey);

    const windowPoints = orderedPoints.filter(
      (point) => point.timestampMs >= pendingDepart!.timestampMs && point.timestampMs <= event.timestampMs,
    );
    const distanceM = getPolylineDistance(windowPoints);
    const speedValues = windowPoints.map((point) => point.speedMps).filter((value): value is number => value != null);
    const accuracyValues = windowPoints
      .map((point) => point.accuracyM)
      .filter((value): value is number => value != null && Number.isFinite(value));

    segments.push({
      fromStopId: pendingDepart.stopId,
      toStopId: event.stopId,
      startTsMs: pendingDepart.timestampMs,
      endTsMs: event.timestampMs,
      travelTimeSec: Math.max(1, Math.round((event.timestampMs - pendingDepart.timestampMs) / 1000)),
      distanceM,
      avgSpeedMps: mean(speedValues),
      p95SpeedMps: percentile(speedValues, 95),
      meanAccuracyM: mean(accuracyValues),
    });
    pendingDepart = null;
  }

  return {
    segments,
    meta: {
      suppressed,
      completed: segments.length,
    },
  };
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
