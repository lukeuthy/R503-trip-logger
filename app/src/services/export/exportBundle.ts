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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir = FileSystem.cacheDirectory;
  if (!baseDir) {
    throw new Error('cacheDirectory unavailable.');
  }
  const rootDir = `${baseDir}export/${timestamp}/`;
  await FileSystem.makeDirectoryAsync(rootDir, { intermediates: true });

  const tripSessions = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM trip_sessions WHERE trip_id = ?;', [tripId]);
  const tripLegacy = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM trip WHERE trip_id = ?;', [tripId]);
  const gpsRaw = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM gps_points WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);
  const stopEventsRaw = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM stop_events WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);
  const segmentTimesRaw = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC;',
    [tripId],
  );
  const stops = await db.getAllAsync<Record<string, unknown>>(
    'SELECT stop_id, stop_name, lat, lon, stop_sequence, direction_code FROM stop ORDER BY stop_sequence ASC;',
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
    device_id?: string;
    app_version?: string;
  };
  const startedAtMs = session.started_at ? new Date(session.started_at).getTime() : null;
  const gpsRows: Record<string, unknown>[] = gpsRaw.map((row, index) => {
    const ts = String(row.ts ?? '');
    const tsMs = new Date(ts).getTime();
    const prevTsMs = index > 0 ? new Date(String(gpsRaw[index - 1].ts ?? '')).getTime() : null;
    return {
      ...row,
      timestamp_ms: Number.isFinite(tsMs) ? tsMs : null,
      timestamp_iso: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
      elapsed_sec: startedAtMs != null && Number.isFinite(tsMs) ? Math.max(0, (tsMs - startedAtMs) / 1000) : null,
      inter_point_gap_sec:
        prevTsMs != null && Number.isFinite(prevTsMs) && Number.isFinite(tsMs) ? Math.max(0, (tsMs - prevTsMs) / 1000) : null,
    };
  });
  const stopEventsRows = stopEventsRaw.map((row) => {
    const ts = String(row.ts ?? '');
    const tsMs = new Date(ts).getTime();
    const rawType = String(row.event_type ?? '').toLowerCase();
    const normalizedType = rawType === 'enter' ? 'arrive' : rawType === 'exit' ? 'depart' : rawType === 'dwell_confirmed' ? 'dwell' : rawType;
    return {
      ...row,
      event_type: normalizedType,
      timestamp_ms: Number.isFinite(tsMs) ? tsMs : null,
      timestamp_iso: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
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

  const metadata = await loadExportMetadata(tripId);
  const endedAtMs = session.ended_at ? new Date(session.ended_at).getTime() : null;
  const durationSec = startedAtMs != null && endedAtMs != null ? Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000)) : null;
  const filteredGpsPoints = gpsRows.filter((row) => Number((row as Record<string, unknown>).is_filtered ?? 0) === 1).length;
  const metadataObject = {
    bundle_version: BUNDLE_VERSION,
    trip_id: tripId,
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
    task_restart_count: metadata.taskRestartCount,
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
    { name: 'metadata.json', content: JSON.stringify(metadataObject, null, 2) },
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
          metadata: metadataObject,
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

  const zipPath = `${rootDir}bundle.zip`;
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
