import { haversineMeters } from './filters';

const CONGESTION_SPEED_MPS = 3.0;

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
  derivedSpeedMps: number | null;
  accuracyM: number | null;
  isFiltered: boolean;
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
  qualityFlag: 'good' | 'degraded' | 'poor';
  pointCount: number;
  maxGapSec: number | null;
  p95AccuracyM: number | null;
  minAccuracyM: number | null;
  /** Time from arrive to depart at the from-stop. Null when from-stop had no arrive event. */
  dwellTimeSec: number | null;
  /** Fraction of valid points where effective speed < 3 m/s. */
  congestionRatio: number | null;
  /** Population standard deviation of effective speeds. */
  stdSpeedMps: number | null;
  /** Stops between from and to that were not visited (0 for consecutive). */
  stopsSkipped: number;
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
  // Track arrive timestamps so we can compute dwell at the departure stop.
  const lastArriveByStopId = new Map<string, number>();

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

    // --- arrive event ---
    lastArriveByStopId.set(event.stopId, event.timestampMs);

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

    // Only reject backward or same-stop transitions. Forward skips (toOrder > fromOrder + 1)
    // are valid: the bus simply didn't stop at the intermediate stops.
    if (toOrder <= fromOrder) {
      suppressed.push({
        reason: 'backward-transition',
        fromStopId: pendingDepart.stopId,
        toStopId: event.stopId,
        atTsMs: event.timestampMs,
      });
      // Consume the depart so subsequent arrives can pair with a fresh depart.
      pendingDepart = null;
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
    const validPoints = windowPoints.filter((point) => !point.isFiltered);
    const distanceM = getPolylineDistance(validPoints);

    // Use derived speed (position-delta based) where available; fall back to provider speed.
    const effectiveSpeeds = validPoints
      .map((p) => p.derivedSpeedMps ?? p.speedMps)
      .filter((v): v is number => v != null);
    const accuracyValues = validPoints
      .map((point) => point.accuracyM)
      .filter((value): value is number => value != null && Number.isFinite(value));
    const pointCount = validPoints.length;
    const maxGapSec = getMaxGapSec(validPoints);
    const meanAccuracy = mean(accuracyValues);
    const p95Accuracy = percentile(accuracyValues, 95);
    const minAccuracy = min(accuracyValues);
    const qualityFlag = getQualityFlag({ pointCount, maxGapSec, meanAccuracyM: meanAccuracy });

    // Dwell time at the departure stop.
    const fromArriveMs = lastArriveByStopId.get(pendingDepart.stopId) ?? null;
    const dwellTimeSec =
      fromArriveMs != null && fromArriveMs < pendingDepart.timestampMs
        ? (pendingDepart.timestampMs - fromArriveMs) / 1000
        : null;

    // Congestion ratio: fraction of valid points at crawl speed.
    const congestionRatio =
      effectiveSpeeds.length > 0
        ? effectiveSpeeds.filter((v) => v < CONGESTION_SPEED_MPS).length / effectiveSpeeds.length
        : null;

    // Speed standard deviation (population formula).
    const stdSpeedMps = stdDev(effectiveSpeeds);

    segments.push({
      fromStopId: pendingDepart.stopId,
      toStopId: event.stopId,
      startTsMs: pendingDepart.timestampMs,
      endTsMs: event.timestampMs,
      travelTimeSec: Math.max(1, Math.round((event.timestampMs - pendingDepart.timestampMs) / 1000)),
      distanceM,
      avgSpeedMps: mean(effectiveSpeeds),
      p95SpeedMps: percentile(effectiveSpeeds, 95),
      meanAccuracyM: meanAccuracy,
      qualityFlag,
      pointCount,
      maxGapSec,
      p95AccuracyM: p95Accuracy,
      minAccuracyM: minAccuracy,
      dwellTimeSec,
      congestionRatio,
      stdSpeedMps,
      stopsSkipped: toOrder - fromOrder - 1,
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

function stdDev(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((percentileRank / 100) * (sorted.length - 1));
  return sorted[index] ?? null;
}

function min(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.min(...values);
}

function getMaxGapSec(points: SegmentInputPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }
  let maxGapMs = 0;
  for (let i = 1; i < points.length; i += 1) {
    maxGapMs = Math.max(maxGapMs, points[i].timestampMs - points[i - 1].timestampMs);
  }
  return maxGapMs / 1000;
}

function getQualityFlag(input: { pointCount: number; maxGapSec: number | null; meanAccuracyM: number | null }): 'good' | 'degraded' | 'poor' {
  if (input.pointCount < 3) {
    return 'poor';
  }
  if ((input.maxGapSec ?? 0) > 30) {
    return 'poor';
  }
  if ((input.meanAccuracyM ?? 999) > 80) {
    return 'poor';
  }
  if ((input.maxGapSec ?? 0) > 15) {
    return 'degraded';
  }
  if ((input.meanAccuracyM ?? 999) >= 40) {
    return 'degraded';
  }
  return 'good';
}
