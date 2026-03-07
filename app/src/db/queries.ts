import { Platform } from 'react-native';

import { getDb } from '../../database/db';
import { deriveSegments } from '../services/location/segmentBuilder';
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

let pointWriteBuffer: PersistPointInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export interface PersistStopEventInput {
  tripId: string;
  stopId: string;
  eventType: 'arrive' | 'depart';
  timestampMs: number;
  distToStopM: number;
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

export function resolveVariantId(directionCode: DirectionCode, windowCode: WindowCode): string {
  if (windowCode === 'PM') {
    return 'r503_pm';
  }
  if (windowCode === 'AM') {
    return 'r503_am';
  }
  return directionCode === 'B' ? 'r503_pm' : 'r503_off';
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
      (trip_id, device_id, variant_id, started_at, ended_at, timezone, app_version, time_bucket, notes, experiment_variant)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?);`,
    [input.tripId, deviceId, variantId, startedAtIso, input.timezone, input.appVersion, timeBucket, VARIANT],
  );
}

export async function markSessionEnded(tripId: string, endedAtMs: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE trip_sessions SET ended_at = ? WHERE trip_id = ?;', [new Date(endedAtMs).toISOString(), tripId]);
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

export async function persistPoint(input: PersistPointInput): Promise<void> {
  pointWriteBuffer.push(input);
  if (pointWriteBuffer.length >= Math.max(1, SENSING_CONFIG.writeBufferSize)) {
    await flushPointBuffer();
    return;
  }
  if (SENSING_CONFIG.writeBufferTimeoutMs > 0 && !flushTimer) {
    flushTimer = setTimeout(() => {
      void flushPointBuffer();
    }, SENSING_CONFIG.writeBufferTimeoutMs);
  }
}

export async function flushPointBuffer(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pointWriteBuffer.length === 0) {
    return;
  }
  const batch = [...pointWriteBuffer];
  pointWriteBuffer = [];
  const db = await getDb();
  for (const point of batch) {
    await insertPointNow(db, point);
  }
}

async function insertPointNow(db: Awaited<ReturnType<typeof getDb>>, input: PersistPointInput): Promise<void> {
  const pointId = createUuidV4();
  await db.runAsync(
    `INSERT INTO gps_points
      (point_id, trip_id, ts, lat, lng, accuracy_m, altitude_m, speed_mps, bearing_deg, derived_speed_mps, derived_heading_deg, provider_speed_mps, provider_heading_deg, is_filtered, filter_reason, smoothed_lat, smoothed_lng, smoothed_speed_mps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      pointId,
      input.tripId,
      new Date(input.timestampMs).toISOString(),
      input.lat,
      input.lon,
      input.accuracyM,
      input.altitudeM,
      input.speedMps,
      input.headingDeg,
      input.derivedSpeedMps,
      input.derivedHeadingDeg,
      input.providerSpeedMps,
      input.providerHeadingDeg,
      input.isFiltered ? 1 : 0,
      input.filterReason,
      input.smoothedLat,
      input.smoothedLng,
      input.smoothedSpeedMps,
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

export async function persistStopEvent(input: PersistStopEventInput): Promise<boolean> {
  const db = await getDb();
  const lastForStop = await db.getFirstAsync<{ event_type: 'arrive' | 'depart'; ts: string }>(
    `SELECT event_type, ts FROM stop_events
     WHERE trip_id = ? AND stop_id = ?
     ORDER BY ts DESC
     LIMIT 1;`,
    [input.tripId, input.stopId],
  );
  if (lastForStop) {
    const lastTs = new Date(lastForStop.ts).getTime();
    if (input.timestampMs <= lastTs) {
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
    `INSERT INTO stop_events (event_id, trip_id, stop_id, event_type, ts, dist_to_stop_m, speed_mps, accuracy_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      eventId,
      input.tripId,
      input.stopId,
      input.eventType,
      new Date(input.timestampMs).toISOString(),
      input.distToStopM,
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
    event_type: 'arrive' | 'depart';
    ts: string;
  }>('SELECT stop_id, event_type, ts FROM stop_events WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);
  const points = await db.getAllAsync<{
    ts: string;
    lat: number;
    lng: number;
    speed_mps: number | null;
    accuracy_m: number | null;
  }>('SELECT ts, lat, lng, speed_mps, accuracy_m FROM gps_points WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);

  const derivedResult = deriveSegments(
    events.map((event) => ({
      stopId: event.stop_id,
      eventType: event.event_type,
      timestampMs: new Date(event.ts).getTime(),
    })),
    points.map((point) => ({
      timestampMs: new Date(point.ts).getTime(),
      lat: point.lat,
      lon: point.lng,
      speedMps: point.speed_mps,
      accuracyM: point.accuracy_m,
    })),
    stopOrderByStopId,
  );
  const derived = derivedResult.segments;

  await db.runAsync('DELETE FROM segment_times WHERE trip_id = ?;', [tripId]);
  for (const segment of derived) {
    await db.runAsync(
      `INSERT INTO segment_times
        (segment_id, trip_id, from_stop_id, to_stop_id, start_ts, end_ts, travel_time_sec, distance_m, avg_speed_mps, p95_speed_mps, mean_accuracy_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        createUuidV4(),
        tripId,
        segment.fromStopId,
        segment.toStopId,
        new Date(segment.startTsMs).toISOString(),
        new Date(segment.endTsMs).toISOString(),
        segment.travelTimeSec,
        segment.distanceM,
        segment.avgSpeedMps,
        segment.p95SpeedMps,
        segment.meanAccuracyM,
      ],
    );
    await appendAuditLog({
      scope: 'segment',
      action: 'completed',
      trip_id: tripId,
      from_stop_id: segment.fromStopId,
      to_stop_id: segment.toStopId,
      start_ts: segment.startTsMs,
      end_ts: segment.endTsMs,
    });
  }
  for (const item of derivedResult.meta.suppressed) {
    await appendAuditLog({
      scope: 'segment',
      action: 'suppressed',
      trip_id: tripId,
      reason: item.reason,
      from_stop_id: item.fromStopId ?? null,
      to_stop_id: item.toStopId ?? null,
      ts: item.atTsMs,
    });
  }
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
     ORDER BY ts DESC
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
  const lastV1 = await db.getFirstAsync<{ ts: string }>('SELECT ts FROM gps_points WHERE trip_id = ? ORDER BY ts DESC LIMIT 1;', [tripId]);

  return {
    legacyPoints: legacyPoints?.count ?? 0,
    v1Points: v1Points?.count ?? 0,
    stopEvents: stopEvents?.count ?? 0,
    lastLegacyTsMs: lastLegacy?.timestamp_ms ?? null,
    lastV1TsIso: lastV1?.ts ?? null,
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
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  batteryDrainPct: number | null;
}> {
  const db = await getDb();
  const schema = await db.getFirstAsync<{ schema_version: number }>('SELECT schema_version FROM schema_meta LIMIT 1;');
  const session = await db.getFirstAsync<{
    app_version: string;
    device_id: string;
    variant_id: string;
    experiment_variant: string | null;
    battery_start_pct: number | null;
    battery_end_pct: number | null;
    battery_drain_pct: number | null;
  }>(
    'SELECT app_version, device_id, variant_id, experiment_variant, battery_start_pct, battery_end_pct, battery_drain_pct FROM trip_sessions WHERE trip_id = ?;',
    [tripId],
  );
  return {
    schemaVersion: schema?.schema_version ?? 0,
    appVersion: session?.app_version ?? 'unknown',
    deviceId: session?.device_id ?? 'unknown',
    variantId: session?.variant_id ?? 'unknown',
    experimentVariant: session?.experiment_variant ?? null,
    batteryStartPct: session?.battery_start_pct ?? null,
    batteryEndPct: session?.battery_end_pct ?? null,
    batteryDrainPct: session?.battery_drain_pct ?? null,
  };
}
