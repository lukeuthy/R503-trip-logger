import { Platform } from 'react-native';

import { getDb } from '../../database/db';
import { haversineMeters } from '../services/location/filters';
import type { RouteStop, StopDetectionState } from '../services/location/stopDetector';
import { appendAuditLog } from '../services/location/fileAudit';
import { SENSING_CONFIG, VARIANT } from '../utils/experimentConfig';
import { createUuidV4 } from '../utils/id';
import { loadSettings, saveSettings } from '../utils/settingsStore';
import type { DirectionCode, WindowCode } from '../../models/Trip';

export interface SessionMetadataInput {
  tripId: string;
  directionCode: DirectionCode;
  windowCode: WindowCode;
  appVersion: string;
  timezone: string;
  startTimestampMs: number;
  taskRestartCount?: number | null;
}

export interface PersistPointInput {
  tripId: string;
  timestampMs: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  derivedSpeedMps: number | null;
  derivedHeadingDeg: number | null;
  providerSpeedMps: number | null;
  providerHeadingDeg: number | null;
  isFiltered: boolean;
  filterReason: string | null;
  smoothedLat: number | null;
  smoothedLng: number | null;
  smoothedSpeedMps: number | null;
}

export interface PersistStopEventInput {
  tripId: string;
  stopId: string;
  eventType: 'arrive' | 'dwell' | 'exit';
  timestampMs: number;
  distToStopM: number;
  lat?: number | null;
  lon?: number | null;
  speedMps: number | null;
  accuracyM: number | null;
}

export async function ensureDeviceRegistered(): Promise<string> {
  const db = await getDb();
  const settings = await loadSettings();
  if (settings.deviceId) {
    const exists = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM devices WHERE device_id = ?;', [
      settings.deviceId,
    ]);
    if ((exists?.count ?? 0) > 0) {
      return settings.deviceId;
    }
  }

  const deviceId = createUuidV4();
  const nowIso = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO devices (device_id, created_at, platform, os_version, model)
     VALUES (?, ?, ?, ?, ?);`,
    [deviceId, nowIso, Platform.OS, String(Platform.Version), 'unknown-model'],
  );
  await saveSettings({ deviceId });
  return deviceId;
}

export function resolveVariantId(directionCode: DirectionCode, _windowCode: WindowCode): string {
  // The stops table is keyed by direction (all R503 stops are seeded with
  // direction_code='A' → 'r503_am'). The window_code (AM/PM/OFF) is a TIME
  // bucket metadata and must NOT change which stop set we look up against.
  // Previously this returned 'r503_pm' for any PM trip, which produced zero
  // stop_events because no stops exist under r503_pm (direction-B stops
  // haven't been seeded). time_bucket already preserves the window code.
  return directionCode === 'B' ? 'r503_pm' : 'r503_am';
}

export function computeTimeBucket(timestampMs: number): string {
  const date = new Date(timestampMs);
  const h = date.getHours();
  return `${String(h).padStart(2, '0')}-${String(h + 1).padStart(2, '0')}`;
}

export async function insertSessionMetadata(input: SessionMetadataInput): Promise<void> {
  const db = await getDb();
  const deviceId = await ensureDeviceRegistered();
  const variantId = resolveVariantId(input.directionCode, input.windowCode);
  const startedAtIso = new Date(input.startTimestampMs).toISOString();
  const timeBucket = computeTimeBucket(input.startTimestampMs);

  await db.runAsync(
    `INSERT OR IGNORE INTO trip_sessions
      (trip_id, device_id, variant_id, started_at, ended_at, timezone, app_version, time_bucket, notes, experiment_variant, task_restart_count)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?);`,
    [input.tripId, deviceId, variantId, startedAtIso, input.timezone, input.appVersion, timeBucket, VARIANT, input.taskRestartCount ?? null],
  );
}

export async function markSessionEnded(
  tripId: string,
  endedAtMs: number,
  endedReason: string | null = null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE trip_sessions SET ended_at = ?, ended_reason = COALESCE(?, ended_reason) WHERE trip_id = ?;',
    [new Date(endedAtMs).toISOString(), endedReason, tripId],
  );
  await updateTripMaxGapSec(tripId);
}

export interface DanglingTripRecovery {
  tripId: string;
  startedAt: string;
  endedAtMs: number;
  pointCount: number;
}

export async function finalizeDanglingTrips(excludeTripId: string | null): Promise<DanglingTripRecovery[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ trip_id: string; started_at: string }>(
    'SELECT trip_id, started_at FROM trip_sessions WHERE ended_at IS NULL;',
  );
  const recovered: DanglingTripRecovery[] = [];
  for (const row of rows) {
    if (excludeTripId && row.trip_id === excludeTripId) {
      continue;
    }
    const last = await db.getFirstAsync<{ timestamp_ms: number | null }>(
      'SELECT MAX(timestamp_ms) as timestamp_ms FROM gps_points WHERE trip_id = ?;',
      [row.trip_id],
    );
    const startMs = Date.parse(row.started_at);
    const fallbackMs = Number.isFinite(startMs) ? startMs + 1000 : Date.now();
    const endedAtMs = last?.timestamp_ms != null && Number.isFinite(last.timestamp_ms) ? last.timestamp_ms : fallbackMs;
    const pointRow = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?;',
      [row.trip_id],
    );
    await markSessionEnded(row.trip_id, endedAtMs, 'auto_finalized_orphan');
    await db.runAsync(
      "UPDATE trip SET ended_at_ms = COALESCE(ended_at_ms, ?), status = 'stopped' WHERE trip_id = ? AND (status IS NULL OR status != 'stopped');",
      [endedAtMs, row.trip_id],
    );
    await appendAuditLog({
      scope: 'recovery',
      action: 'auto-finalize-orphan',
      trip_id: row.trip_id,
      message: `Orphan trip finalized at ${new Date(endedAtMs).toISOString()} (${pointRow?.count ?? 0} pts)`,
    });
    recovered.push({
      tripId: row.trip_id,
      startedAt: row.started_at,
      endedAtMs,
      pointCount: pointRow?.count ?? 0,
    });
  }
  return recovered;
}

export async function insertBatterySample(tripId: string, timestampMs: number, levelPct: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO battery_samples (trip_id, timestamp_ms, level_pct) VALUES (?, ?, ?);',
    [tripId, timestampMs, levelPct],
  );
}

export async function loadStopsForVariant(variantId: string): Promise<RouteStop[]> {
  const db = await getDb();
  return db.getAllAsync<RouteStop>(
    `SELECT stop_id as stopId, stop_order as stopOrder, name, lat, lng, radius_m as radiusM
     FROM stops
     WHERE variant_id = ?
     ORDER BY stop_order ASC;`,
    [variantId],
  );
}

const pointBuffer: PersistPointInput[] = [];
let bufferLastFlushAtMs = Date.now();
let flushInFlight: Promise<void> | null = null;

export async function persistPoint(input: PersistPointInput): Promise<void> {
  pointBuffer.push(input);
  const overSize = pointBuffer.length >= Math.max(1, SENSING_CONFIG.writeBufferSize);
  const overTime =
    SENSING_CONFIG.writeBufferTimeoutMs > 0 &&
    Date.now() - bufferLastFlushAtMs >= SENSING_CONFIG.writeBufferTimeoutMs;
  if (overSize || overTime) {
    await flushPointBuffer();
  }
}

export async function flushPointBuffer(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    return;
  }
  if (pointBuffer.length === 0) {
    bufferLastFlushAtMs = Date.now();
    return;
  }
  const drained = pointBuffer.splice(0, pointBuffer.length);
  flushInFlight = (async () => {
    try {
      const db = await getDb();
      await db.withTransactionAsync(async () => {
        for (const input of drained) {
          await insertPointNow(db, input);
        }
      });
    } catch (error) {
      // Re-queue on failure so we don't drop data.
      pointBuffer.unshift(...drained);
      await appendAuditLog({
        scope: 'point-buffer',
        action: 'flush-failed',
        message: error instanceof Error ? error.message : 'unknown error',
        pending_count: pointBuffer.length,
      });
      throw error;
    } finally {
      bufferLastFlushAtMs = Date.now();
    }
  })();
  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

export function getPendingPointCount(): number {
  return pointBuffer.length;
}

async function insertPointNow(db: Awaited<ReturnType<typeof getDb>>, input: PersistPointInput): Promise<void> {
  await db.runAsync(
    `INSERT INTO gps_points
      (trip_id, timestamp_ms, lat, lon, accuracy_m, speed_mps, heading_deg, derived_speed_mps, derived_heading_deg, is_filtered, filter_reason, smoothed_lat, smoothed_lon, smoothed_speed_mps, ts, lng, bearing_deg, smoothed_lng, altitude_m, provider_speed_mps, provider_heading_deg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      input.tripId,
      input.timestampMs,
      input.lat,
      input.lon,
      input.accuracyM,
      input.speedMps,
      input.headingDeg,
      input.derivedSpeedMps,
      input.derivedHeadingDeg,
      input.isFiltered ? 1 : 0,
      input.filterReason,
      input.smoothedLat,
      input.smoothedLng,
      input.smoothedSpeedMps,
      new Date(input.timestampMs).toISOString(),
      input.lon,
      input.headingDeg,
      input.smoothedLng,
      input.altitudeM,
      input.providerSpeedMps,
      input.providerHeadingDeg,
    ],
  );
}

export async function updateTripBatteryMetrics(input: {
  tripId: string;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  batteryDrainPct: number | null;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE trip_sessions
     SET battery_start_pct = COALESCE(?, battery_start_pct),
         battery_end_pct = COALESCE(?, battery_end_pct),
         battery_drain_pct = COALESCE(?, battery_drain_pct)
     WHERE trip_id = ?;`,
    [
      input.batteryStartPct,
      input.batteryEndPct,
      input.batteryDrainPct,
      input.tripId,
    ],
  );
}

export async function updateTripMaxGapSec(tripId: string): Promise<number | null> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ timestamp_ms: number }>(
    'SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
    [tripId],
  );
  let maxGapSec: number | null = null;
  let previousTsMs: number | null = null;
  for (const row of rows) {
    const tsMs = row.timestamp_ms;
    if (!Number.isFinite(tsMs)) {
      continue;
    }
    if (previousTsMs != null) {
      const gapSec = Math.max(0, (tsMs - previousTsMs) / 1000);
      maxGapSec = maxGapSec == null ? gapSec : Math.max(maxGapSec, gapSec);
    }
    previousTsMs = tsMs;
  }
  await db.runAsync('UPDATE trip_sessions SET max_gap_sec = ? WHERE trip_id = ?;', [maxGapSec, tripId]);
  return maxGapSec;
}

export async function updateTripTaskRestartCount(tripId: string, taskRestartCount: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE trip_sessions SET task_restart_count = ? WHERE trip_id = ?;', [taskRestartCount, tripId]);
}

export async function persistStopEvent(input: PersistStopEventInput): Promise<boolean> {
  // Stop events trigger segment rebuilds; ensure buffered points are visible.
  await flushPointBuffer();
  const db = await getDb();
  const duplicateEvent = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM stop_events
     WHERE trip_id = ? AND stop_id = ? AND event_type = ?;`,
    [input.tripId, input.stopId, input.eventType],
  );
  if ((duplicateEvent?.count ?? 0) > 0) {
    await appendAuditLog({
      scope: 'stop-event',
      action: 'suppressed',
      reason: 'duplicate-event-for-stop',
      trip_id: input.tripId,
      stop_id: input.stopId,
      event_type: input.eventType,
      ts: input.timestampMs,
    });
    return false;
  }

  const lastForStop = await db.getFirstAsync<{ event_type: 'arrive' | 'dwell' | 'exit'; timestamp_ms: number | null; ts: string | null }>(
    `SELECT event_type, timestamp_ms, ts FROM stop_events
     WHERE trip_id = ? AND stop_id = ?
     ORDER BY COALESCE(timestamp_ms, CAST(strftime('%s', ts) AS INTEGER) * 1000) DESC
     LIMIT 1;`,
    [input.tripId, input.stopId],
  );
  if (lastForStop) {
    const lastTs = lastForStop.timestamp_ms ?? (lastForStop.ts ? new Date(lastForStop.ts).getTime() : null);
    if (lastTs != null && Number.isFinite(lastTs) && input.timestampMs <= lastTs) {
      await appendAuditLog({
        scope: 'stop-event',
        action: 'suppressed',
        reason: 'non-forward-time',
        trip_id: input.tripId,
        stop_id: input.stopId,
        event_type: input.eventType,
        ts: input.timestampMs,
      });
      return false;
    }
    if (lastForStop.event_type === 'exit') {
      await appendAuditLog({
        scope: 'stop-event',
        action: 'suppressed',
        reason: 'stop-already-exited',
        trip_id: input.tripId,
        stop_id: input.stopId,
        event_type: input.eventType,
        ts: input.timestampMs,
      });
      return false;
    }
    if (lastForStop.event_type === input.eventType) {
      await appendAuditLog({
        scope: 'stop-event',
        action: 'suppressed',
        reason: 'duplicate-consecutive-event',
        trip_id: input.tripId,
        stop_id: input.stopId,
        event_type: input.eventType,
        ts: input.timestampMs,
      });
      return false;
    }
  }

  const eventId = createUuidV4();
  await db.runAsync(
    `INSERT INTO stop_events (event_id, trip_id, stop_id, event_type, timestamp_ms, ts, dist_m, dist_to_stop_m, lat, lon, speed_mps, accuracy_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      eventId,
      input.tripId,
      input.stopId,
      input.eventType,
      input.timestampMs,
      new Date(input.timestampMs).toISOString(),
      input.distToStopM,
      input.distToStopM,
      input.lat ?? null,
      input.lon ?? null,
      input.speedMps,
      input.accuracyM,
    ],
  );
  await appendAuditLog({
    scope: 'stop-event',
    action: 'persisted',
    trip_id: input.tripId,
    stop_id: input.stopId,
    event_type: input.eventType,
    ts: input.timestampMs,
  });
  return true;
}

export async function rebuildSegmentsForTrip(tripId: string): Promise<void> {
  // Segment metrics scan gps_points; ensure buffered points are visible.
  await flushPointBuffer();
  const db = await getDb();
  const stopOrders = await db.getAllAsync<{ stop_id: string; stop_order: number }>(
    `SELECT s.stop_id, s.stop_order
     FROM stops s
     INNER JOIN trip_sessions t ON t.variant_id = s.variant_id
     WHERE t.trip_id = ?;`,
    [tripId],
  );
  const stopOrderByStopId: Record<string, number> = {};
  for (const row of stopOrders) {
    stopOrderByStopId[row.stop_id] = row.stop_order;
  }

  const events = await db.getAllAsync<{
    stop_id: string;
    event_type: 'arrive' | 'dwell' | 'exit';
    timestamp_ms: number | null;
    ts: string | null;
  }>(
    `SELECT stop_id, event_type, timestamp_ms, ts
     FROM stop_events
     WHERE trip_id = ?
     ORDER BY COALESCE(timestamp_ms, CAST(strftime('%s', ts) AS INTEGER) * 1000) ASC;`,
    [tripId],
  );

  await db.runAsync('DELETE FROM segment_times WHERE trip_id = ?;', [tripId]);
  const arrivesByStopId = new Map<string, number>();
  const exits: Array<{ stopId: string; timestampMs: number }> = [];
  for (const event of events) {
    const timestampMs = event.timestamp_ms ?? (event.ts ? new Date(event.ts).getTime() : null);
    if (timestampMs == null || !Number.isFinite(timestampMs)) {
      continue;
    }
    if (event.event_type === 'arrive' && !arrivesByStopId.has(event.stop_id)) {
      arrivesByStopId.set(event.stop_id, timestampMs);
    }
    if (event.event_type === 'exit') {
      exits.push({ stopId: event.stop_id, timestampMs });
    }
  }

  for (const exitEvent of exits) {
    const fromOrder = stopOrderByStopId[exitEvent.stopId];
    if (fromOrder == null) {
      continue;
    }

    // Skip-stop aware: find the lowest-order stop ahead of this exit that has
    // an arrive event. The original +1 lookup stalls when the bus skips a stop
    // because arrivesByStopId never gets an entry for the skipped stop.
    let toStopId: string | null = null;
    let arriveMs: number | null = null;
    let lowestAheadOrder = Infinity;

    for (const [candidateStopId, candidateArriveMs] of arrivesByStopId) {
      const candidateOrder = stopOrderByStopId[candidateStopId];
      if (candidateOrder == null || candidateOrder <= fromOrder) continue;
      if (candidateArriveMs <= exitEvent.timestampMs) continue;
      if (candidateOrder < lowestAheadOrder) {
        lowestAheadOrder = candidateOrder;
        toStopId = candidateStopId;
        arriveMs = candidateArriveMs;
      }
    }

    if (!toStopId || arriveMs == null) {
      continue;
    }

    // Dwell time at the departure stop (arrive → exit). Null when there is no
    // recorded arrive for the from-stop (e.g. first stop of the trip).
    const fromStopArriveMs = arrivesByStopId.get(exitEvent.stopId) ?? null;
    const dwellTimeSec =
      fromStopArriveMs != null && fromStopArriveMs < exitEvent.timestampMs
        ? (exitEvent.timestampMs - fromStopArriveMs) / 1000
        : null;

    // Number of stops between from_stop and to_stop that were skipped.
    const stopsSkipped = lowestAheadOrder - fromOrder - 1;

    const travelTimeS = (arriveMs - exitEvent.timestampMs) / 1000;
    const segmentMetrics = await computeSegmentMetrics(db, tripId, exitEvent.timestampMs, arriveMs);
    await db.runAsync(
      `INSERT INTO segment_times
        (segment_id, trip_id, from_stop_id, to_stop_id, depart_ms, arrive_ms,
         travel_time_s, start_ts, end_ts, travel_time_sec, distance_m,
         avg_speed_mps, p95_speed_mps, mean_accuracy_m, quality_flag,
         point_count, max_gap_sec, p95_accuracy_m, min_accuracy_m,
         dwell_time_sec, congestion_ratio, std_speed_mps, stops_skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        createUuidV4(),
        tripId,
        exitEvent.stopId,
        toStopId,
        exitEvent.timestampMs,
        arriveMs,
        travelTimeS,
        new Date(exitEvent.timestampMs).toISOString(),
        new Date(arriveMs).toISOString(),
        Math.max(1, Math.round(travelTimeS)),
        segmentMetrics.distanceM,
        segmentMetrics.avgSpeedMps,
        segmentMetrics.p95SpeedMps,
        segmentMetrics.meanAccuracyM,
        segmentMetrics.qualityFlag,
        segmentMetrics.pointCount,
        segmentMetrics.maxGapSec,
        segmentMetrics.p95AccuracyM,
        segmentMetrics.minAccuracyM,
        dwellTimeSec,
        segmentMetrics.congestionRatio,
        segmentMetrics.stdSpeedMps,
        stopsSkipped,
      ],
    );
    await appendAuditLog({
      scope: 'segment',
      action: 'completed',
      trip_id: tripId,
      from_stop_id: exitEvent.stopId,
      to_stop_id: toStopId,
      start_ts: exitEvent.timestampMs,
      end_ts: arriveMs,
    });
  }
}

// Speed below this threshold is considered "congested" (< ~10 km/h).
const CONGESTION_SPEED_MPS = 3.0;

async function computeSegmentMetrics(
  db: Awaited<ReturnType<typeof getDb>>,
  tripId: string,
  departMs: number,
  arriveMs: number,
): Promise<{
  distanceM: number;
  avgSpeedMps: number | null;
  p95SpeedMps: number | null;
  meanAccuracyM: number | null;
  qualityFlag: 'good' | 'degraded' | 'poor';
  pointCount: number;
  maxGapSec: number | null;
  p95AccuracyM: number | null;
  minAccuracyM: number | null;
  congestionRatio: number | null;
  stdSpeedMps: number | null;
}> {
  const points = await db.getAllAsync<{
    timestamp_ms: number;
    smoothed_lat: number | null;
    smoothed_lon: number | null;
    lat: number;
    lon: number | null;
    speed_mps: number | null;
    derived_speed_mps: number | null;
    accuracy_m: number | null;
  }>(
    // derived_speed_mps is preferred over provider speed_mps: Android provider
    // reports 0 at low bus speeds while the position-delta derived value is accurate.
    `SELECT timestamp_ms, smoothed_lat, smoothed_lon, lat, lon, speed_mps, derived_speed_mps, accuracy_m
     FROM gps_points
     WHERE trip_id = ? AND is_filtered = 0 AND timestamp_ms >= ? AND timestamp_ms <= ?
     ORDER BY timestamp_ms ASC;`,
    [tripId, departMs, arriveMs],
  );

  let distanceM = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const curr = points[index];
    distanceM += haversineMeters(
      prev.smoothed_lat ?? prev.lat,
      prev.smoothed_lon ?? prev.lon ?? 0,
      curr.smoothed_lat ?? curr.lat,
      curr.smoothed_lon ?? curr.lon ?? 0,
    );
  }

  // Use derived speed where available; fall back to provider speed.
  const effectiveSpeeds = points
    .map((p) => p.derived_speed_mps ?? p.speed_mps)
    .filter((v): v is number => v != null);
  const accuracyValues = points
    .map((p) => p.accuracy_m)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const maxGapSec = getMaxGapSec(points.map((p) => p.timestamp_ms));
  const meanAccuracyM = mean(accuracyValues);
  const qualityFlag: 'good' | 'degraded' | 'poor' =
    points.length < 3 || (maxGapSec ?? 0) > 60
      ? 'poor'
      : (maxGapSec ?? 0) > 30 || (meanAccuracyM ?? 0) > 40
      ? 'degraded'
      : 'good';

  // Congestion ratio: fraction of valid points at crawl speed.
  const congestionRatio =
    effectiveSpeeds.length > 0
      ? effectiveSpeeds.filter((v) => v < CONGESTION_SPEED_MPS).length / effectiveSpeeds.length
      : null;

  // Speed standard deviation using population formula.
  const stdSpeedMps = stdDev(effectiveSpeeds);

  return {
    distanceM,
    // Space mean speed (distance / time) is the correct average for ETA modelling.
    avgSpeedMps: points.length > 1 ? distanceM / Math.max(1, (arriveMs - departMs) / 1000) : null,
    p95SpeedMps: percentile(effectiveSpeeds, 95),
    meanAccuracyM,
    qualityFlag,
    pointCount: points.length,
    maxGapSec,
    p95AccuracyM: percentile(accuracyValues, 95),
    minAccuracyM: accuracyValues.length > 0 ? Math.min(...accuracyValues) : null,
    congestionRatio,
    stdSpeedMps,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
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

function getMaxGapSec(timestampsMs: number[]): number | null {
  if (timestampsMs.length < 2) {
    return null;
  }
  let maxGapMs = 0;
  for (let index = 1; index < timestampsMs.length; index += 1) {
    maxGapMs = Math.max(maxGapMs, timestampsMs[index] - timestampsMs[index - 1]);
  }
  return maxGapMs / 1000;
}

export async function reconstructStopDetectionStateFromEvents(
  tripId: string,
  stops: RouteStop[],
): Promise<StopDetectionState | null> {
  const db = await getDb();
  const events = await db.getAllAsync<{ stop_id: string; event_type: 'arrive' | 'dwell' | 'exit'; timestamp_ms: number | null; ts: string | null }>(
    `SELECT stop_id, event_type, timestamp_ms, ts
     FROM stop_events
     WHERE trip_id = ?
     ORDER BY COALESCE(timestamp_ms, CAST(strftime('%s', ts) AS INTEGER) * 1000) ASC;`,
    [tripId],
  );
  if (events.length === 0) {
    return null;
  }

  const stopIndexById: Record<string, number> = {};
  for (let index = 0; index < stops.length; index += 1) {
    stopIndexById[stops[index].stopId] = index;
  }

  let expectedIndex = 0;
  let activeStopId: string | null = null;
  let enteredAtMs: number | null = null;
  let lastProcessedTimestampMs: number | null = null;

  for (const event of events) {
    const eventTsMs = event.timestamp_ms ?? (event.ts ? new Date(event.ts).getTime() : NaN);
    if (!Number.isFinite(eventTsMs)) {
      continue;
    }
    const stopIndex = stopIndexById[event.stop_id];
    if (stopIndex == null) {
      continue;
    }
    lastProcessedTimestampMs = eventTsMs;
    if (event.event_type === 'arrive' || event.event_type === 'dwell') {
      activeStopId = event.stop_id;
      enteredAtMs = eventTsMs;
      expectedIndex = stopIndex;
      continue;
    }
    activeStopId = null;
    enteredAtMs = null;
    expectedIndex = Math.min(stopIndex + 1, Math.max(0, stops.length - 1));
  }

  return {
    expectedIndex,
    activeStopId,
    enteredAtMs,
    departCandidateSinceMs: null,
    lastProcessedTimestampMs,
  };
}

export async function loadTripDebug(tripId: string): Promise<{
  eventsCount: number;
  segmentsCount: number;
  lastFilterReason: string | null;
}> {
  const db = await getDb();
  const events = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?;', [tripId]);
  const segments = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM segment_times WHERE trip_id = ?;', [
    tripId,
  ]);
  const lastFiltered = await db.getFirstAsync<{ filter_reason: string | null }>(
     `SELECT filter_reason FROM gps_points
      WHERE trip_id = ? AND is_filtered = 1
      ORDER BY timestamp_ms DESC
      LIMIT 1;`,
    [tripId],
  );

  return {
    eventsCount: events?.count ?? 0,
    segmentsCount: segments?.count ?? 0,
    lastFilterReason: lastFiltered?.filter_reason ?? null,
  };
}

export async function loadTrackingHealth(tripId: string): Promise<{
  legacyPoints: number;
  v1Points: number;
  stopEvents: number;
  lastLegacyTsMs: number | null;
  lastV1TsIso: string | null;
}> {
  const db = await getDb();
  const legacyPoints = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM gps_point WHERE trip_id = ?;', [
    tripId,
  ]);
  const v1Points = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM gps_points WHERE trip_id = ?;', [tripId]);
  const stopEvents = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM stop_events WHERE trip_id = ?;', [tripId]);
  const lastLegacy = await db.getFirstAsync<{ timestamp_ms: number }>(
    'SELECT timestamp_ms FROM gps_point WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1;',
    [tripId],
  );
  const lastV1 = await db.getFirstAsync<{ timestamp_ms: number }>(
    'SELECT timestamp_ms FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms DESC LIMIT 1;',
    [tripId],
  );

  return {
    legacyPoints: legacyPoints?.count ?? 0,
    v1Points: v1Points?.count ?? 0,
    stopEvents: stopEvents?.count ?? 0,
    lastLegacyTsMs: lastLegacy?.timestamp_ms ?? null,
    lastV1TsIso: lastV1?.timestamp_ms != null ? new Date(lastV1.timestamp_ms).toISOString() : null,
  };
}

export async function saveDetectionState(tripId: string, state: StopDetectionState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE trip_sessions
     SET notes = ?
     WHERE trip_id = ?;`,
    [JSON.stringify({ stopState: state }), tripId],
  );
}

export async function loadDetectionState(tripId: string): Promise<StopDetectionState | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ notes: string | null }>('SELECT notes FROM trip_sessions WHERE trip_id = ?;', [tripId]);
  if (!row?.notes) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.notes) as { stopState?: StopDetectionState };
    return parsed.stopState ?? null;
  } catch {
    return null;
  }
}

export async function loadExportMetadata(tripId: string): Promise<{
  schemaVersion: number;
  appVersion: string;
  deviceId: string;
  variantId: string;
  experimentVariant: string | null;
  taskRestartCount: number | null;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  batteryDrainPct: number | null;
  maxGapSec: number | null;
}> {
  const db = await getDb();
  const schema = await db.getFirstAsync<{ schema_version: number }>('SELECT schema_version FROM schema_meta LIMIT 1;');
  const session = await db.getFirstAsync<{
    app_version: string;
    device_id: string;
    variant_id: string;
    experiment_variant: string | null;
    task_restart_count: number | null;
    battery_start_pct: number | null;
    battery_end_pct: number | null;
    battery_drain_pct: number | null;
    max_gap_sec: number | null;
  }>(
    'SELECT app_version, device_id, variant_id, experiment_variant, task_restart_count, battery_start_pct, battery_end_pct, battery_drain_pct, max_gap_sec FROM trip_sessions WHERE trip_id = ?;',
    [tripId],
  );
  return {
    schemaVersion: schema?.schema_version ?? 0,
    appVersion: session?.app_version ?? 'unknown',
    deviceId: session?.device_id ?? 'unknown',
    variantId: session?.variant_id ?? 'unknown',
    experimentVariant: session?.experiment_variant ?? null,
    taskRestartCount: session?.task_restart_count ?? null,
    batteryStartPct: session?.battery_start_pct ?? null,
    batteryEndPct: session?.battery_end_pct ?? null,
    batteryDrainPct: session?.battery_drain_pct ?? null,
    maxGapSec: session?.max_gap_sec ?? null,
  };
}
