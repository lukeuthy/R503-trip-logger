import * as FileSystem from 'expo-file-system/legacy';

import { getDb } from '../../../database/db';
import { flushPointBuffer, loadExportMetadata } from '../../db/queries';
import { SENSING_CONFIG, VARIANT } from '../../utils/experimentConfig';
import { getAuditFilePath } from '../location/fileAudit';

export interface ExportBundleResult {
  rootDir: string;
  sharePath: string;
  files: string[];
}

const BUNDLE_VERSION = 2;

export async function exportTripBundle(tripId: string): Promise<ExportBundleResult> {
  await flushPointBuffer();
  const db = await getDb();
  const canonical = await db.getFirstAsync<{ trip_id: string }>('SELECT trip_id FROM trip_sessions WHERE trip_id = ?;', [tripId]);
  const canonicalTripId = canonical?.trip_id ?? tripId;
  const safeTripId = canonicalTripId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = FileSystem.cacheDirectory;
  if (!baseDir) {
    throw new Error('cacheDirectory unavailable.');
  }
  const rootDir = `${baseDir}export/r503_trip_${safeTripId}_${timestamp}/`;
  await FileSystem.makeDirectoryAsync(rootDir, { intermediates: true });

  const tripSessions = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM trip_sessions WHERE trip_id = ?;', [canonicalTripId]);
  const tripLegacy = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM trip WHERE trip_id = ?;', [canonicalTripId]);
  const gpsRaw = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM gps_points WHERE trip_id = ? ORDER BY timestamp_ms ASC;', [canonicalTripId]);
  const stopEventsRaw = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM stop_events WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
    [canonicalTripId],
  );
  const segmentTimesRaw = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC;',
    [canonicalTripId],
  );
  const stops = await db.getAllAsync<Record<string, unknown>>(
    `SELECT stop_id, variant_id, stop_order, name, lat, lng, radius_m
     FROM stops
     WHERE variant_id = 'r503_am'
     ORDER BY stop_order ASC;`,
  );
  const batterySamples = await db.getAllAsync<Record<string, unknown>>(
    'SELECT id, trip_id, timestamp_ms, level_pct FROM battery_samples WHERE trip_id = ? ORDER BY timestamp_ms ASC;',
    [canonicalTripId],
  );
  const recoveredOrphans = await db.getAllAsync<Record<string, unknown>>(
    "SELECT trip_id, started_at, ended_at, ended_reason FROM trip_sessions WHERE ended_reason = 'auto_finalized_orphan' ORDER BY started_at DESC;",
  );

  const session = (tripSessions[0] ?? {}) as {
    started_at?: string;
    ended_at?: string;
    experiment_variant?: string;
    battery_start_pct?: number | null;
    battery_end_pct?: number | null;
    battery_drain_pct?: number | null;
    task_restart_count?: number | null;
    time_bucket?: string | null;
    window_code?: string | null;
    outside_operational_window?: number | null;
    device_id?: string;
    app_version?: string;
  };
  // window_code may also come from the legacy trip table for older exports
  const tripLegacyRow = (tripLegacy[0] ?? {}) as { window_code?: string | null };
  const startedAtMs = session.started_at ? new Date(session.started_at).getTime() : null;
  const gpsRows: Record<string, unknown>[] = gpsRaw.map((row, index) => {
    const ts = String(row.ts ?? '');
    const tsMs = new Date(ts).getTime();
    const previousRow = index > 0 ? gpsRaw[index - 1] : null;
    const prevTsMs =
      previousRow?.timestamp_ms != null && Number.isFinite(Number(previousRow.timestamp_ms))
        ? Number(previousRow.timestamp_ms)
        : previousRow
        ? new Date(String(previousRow.ts ?? '')).getTime()
        : null;
    const canonicalTimestampMs =
      row.timestamp_ms != null && Number.isFinite(Number(row.timestamp_ms))
        ? Number(row.timestamp_ms)
        : Number.isFinite(tsMs)
        ? tsMs
        : null;
    return {
      ...row,
      id: row.id ?? index + 1,
      timestamp_ms: canonicalTimestampMs,
      lon: row.lon ?? row.lng ?? null,
      heading_deg: row.heading_deg ?? row.bearing_deg ?? null,
      smoothed_lon: row.smoothed_lon ?? row.smoothed_lng ?? null,
      timestamp_iso: canonicalTimestampMs != null ? new Date(canonicalTimestampMs).toISOString() : null,
      elapsed_sec: startedAtMs != null && canonicalTimestampMs != null ? Math.max(0, (canonicalTimestampMs - startedAtMs) / 1000) : null,
      inter_point_gap_sec:
        prevTsMs != null && Number.isFinite(prevTsMs) && canonicalTimestampMs != null
          ? Math.max(0, (canonicalTimestampMs - prevTsMs) / 1000)
          : null,
    };
  });
  const stopEventsRows = stopEventsRaw.map((row) => {
    const ts = String(row.ts ?? '');
    const parsedTsMs = new Date(ts).getTime();
    const tsMs =
      row.timestamp_ms != null && Number.isFinite(Number(row.timestamp_ms))
        ? Number(row.timestamp_ms)
        : Number.isFinite(parsedTsMs)
        ? parsedTsMs
        : null;
    const rawType = String(row.event_type ?? '').toLowerCase();
    const normalizedType =
      rawType === 'enter' ? 'arrive' : rawType === 'depart' ? 'exit' : rawType === 'dwell_confirmed' ? 'dwell' : rawType;
    return {
      ...row,
      event_type: normalizedType,
      timestamp_ms: tsMs,
      timestamp_iso: tsMs != null ? new Date(tsMs).toISOString() : null,
    };
  });
  const dayOfWeek = session.started_at ? new Date(session.started_at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : null;
  const isPeak = session.time_bucket != null && ['07-08', '08-09', '17-18', '18-19'].includes(String(session.time_bucket)) ? 1 : 0;
  const segmentRows = segmentTimesRaw.map((row) => ({
    ...row,
    time_bucket: session.time_bucket ?? null,
    day_of_week: dayOfWeek,
    is_peak: isPeak,
  }));

  let auditLogContent = '';
  try {
    const auditPath = getAuditFilePath();
    const info = await FileSystem.getInfoAsync(auditPath);
    if (info.exists) {
      auditLogContent = await FileSystem.readAsStringAsync(auditPath);
    }
  } catch {
    auditLogContent = '';
  }

  const metadata = await loadExportMetadata(canonicalTripId);
  const endedAtMs = session.ended_at ? new Date(session.ended_at).getTime() : null;
  const durationSec = startedAtMs != null && endedAtMs != null ? Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000)) : null;
  const filteredGpsPoints = gpsRows.filter((row) => Number((row as Record<string, unknown>).is_filtered ?? 0) === 1).length;
  const metadataObject = {
    bundle_version: BUNDLE_VERSION,
    trip_id: canonicalTripId,
    device_id: metadata.deviceId,
    app_version: metadata.appVersion,
    experiment_variant: metadata.experimentVariant ?? VARIANT,
    sensing_label: SENSING_CONFIG.label,
    sampling_interval_ms: SENSING_CONFIG.samplingIntervalMs,
    write_buffer_size: SENSING_CONFIG.writeBufferSize,
    geofence_enter_m: SENSING_CONFIG.geofenceRadiusM,
    geofence_exit_m: SENSING_CONFIG.departureRadiusM,
    dwell_ms: SENSING_CONFIG.dwellTimeMs,
    use_foreground_service: SENSING_CONFIG.useForegroundService,
    battery_start_pct: metadata.batteryStartPct,
    battery_end_pct: metadata.batteryEndPct,
    battery_drain_pct: metadata.batteryDrainPct,
    max_gap_sec: metadata.maxGapSec,
    task_restart_count: metadata.taskRestartCount,
    // window_code is the user-selected service window ("AM" | "PM" | "OFF") — never a clock-hour string.
    // time_bucket is a separate derived field ("HH-(HH+1)") computed from the trip start time.
    window_code: tripLegacyRow.window_code ?? session.window_code ?? null,
    time_bucket: session.time_bucket ?? null,
    outside_operational_window:
      session.outside_operational_window != null ? session.outside_operational_window === 1 : null,
    started_at: session.started_at ?? null,
    ended_at: session.ended_at ?? null,
    duration_sec: durationSec,
    total_gps_points: gpsRows.length,
    filtered_gps_points: filteredGpsPoints,
    stop_events_count: stopEventsRows.length,
    segments_count: segmentRows.length,
    schema_version: metadata.schemaVersion,
  };

  const issues: string[] = [];
  if (segmentRows.length === 0) {
    const hasSequence = hasPotentialCompleteSequence(stopEventsRows);
    if (hasSequence) {
      issues.push('segment_times is empty despite complete stop event sequence');
    } else {
      issues.push('segment_times is empty');
    }
  }
  if (gpsRows.length === 0) issues.push('gps_points is empty');
  if (stopEventsRows.length === 0) issues.push('stop_events is empty');
  if (!metadataObject.experiment_variant) issues.push('experiment_variant missing from metadata');
  if (issues.length > 0) {
    console.warn('[EXPORT VALIDATION]', issues);
  }

  const files = [
    { name: 'trip_sessions.csv', content: toCsv(tripSessions) },
    { name: 'trip.csv', content: toCsv(tripLegacy) },
    { name: 'gps_points.csv', content: toCsv(gpsRows) },
    { name: 'stop_events.csv', content: toCsv(stopEventsRows) },
    { name: 'segment_times.csv', content: toCsv(segmentRows) },
    { name: 'stops.csv', content: toCsv(stops) },
    { name: 'battery_samples.csv', content: toCsv(batterySamples) },
    { name: 'metadata.json', content: JSON.stringify(metadataObject, null, 2) },
    { name: 'recovery_metadata.json', content: JSON.stringify({ orphan_recoveries: recoveredOrphans }, null, 2) },
    { name: 'tracking_audit.log', content: auditLogContent },
    {
      name: 'bundle.json',
      content: JSON.stringify(
        {
          trip_sessions: tripSessions,
          trip: tripLegacy[0] ?? null,
          gps_points: gpsRows,
          stop_events: stopEventsRows,
          segment_times: segmentRows,
          stops,
          battery_samples: batterySamples,
          metadata: metadataObject,
          orphan_recoveries: recoveredOrphans,
          export_validation_issues: issues,
        },
        null,
        2,
      ),
    },
  ];

  for (const file of files) {
    await FileSystem.writeAsStringAsync(`${rootDir}${file.name}`, file.content);
  }

  const zipPath = `${rootDir}r503_trip_${safeTripId}.zip`;
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file.content);
  }
  const base64Zip = await zip.generateAsync({ type: 'base64' });
  await FileSystem.writeAsStringAsync(zipPath, base64Zip, { encoding: FileSystem.EncodingType.Base64 });

  return {
    rootDir,
    sharePath: zipPath,
    files: files.map((file) => `${rootDir}${file.name}`),
  };
}

function hasPotentialCompleteSequence(rows: Record<string, unknown>[]): boolean {
  let hasDepart = false;
  for (const row of rows) {
    const type = String(row.event_type ?? '').toLowerCase();
    if (type === 'depart') hasDepart = true;
    if (type === 'arrive' && hasDepart) return true;
  }
  return false;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return '';
  }
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map((header) => escapeCsv(row[header]));
    lines.push(values.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function escapeCsv(value: unknown): string {
  if (value == null) {
    return '';
  }
  const raw = String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}
