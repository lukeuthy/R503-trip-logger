import * as FileSystem from 'expo-file-system/legacy';

import { getDb } from '../../../database/db';
import { SENSING_CONFIG, VARIANT } from '../../utils/experimentConfig';
import { flushPointBuffer, loadExportMetadata } from '../../db/queries';
import { getAuditFilePath } from '../location/fileAudit';

export interface ExportBundleResult {
  rootDir: string;
  sharePath: string;
  files: string[];
}

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

  const sessions = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM trip_sessions WHERE trip_id = ?;', [tripId]);
  const gpsPoints = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM gps_points WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);
  const stopEvents = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM stop_events WHERE trip_id = ? ORDER BY ts ASC;', [tripId]);
  const segmentTimes = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM segment_times WHERE trip_id = ? ORDER BY start_ts ASC;',
    [tripId],
  );

  const metadata = await loadExportMetadata(tripId);
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
  const metadataContent = JSON.stringify(
    {
      trip_id: tripId,
      schema_version: metadata.schemaVersion,
      app_version: metadata.appVersion,
      device_id: metadata.deviceId,
      route_variant: metadata.variantId,
      experimentVariant: metadata.experimentVariant ?? VARIANT,
      sensingLabel: SENSING_CONFIG.label,
      samplingIntervalMs: SENSING_CONFIG.samplingIntervalMs,
      writeBufferSize: SENSING_CONFIG.writeBufferSize,
      geofenceRadiusM: SENSING_CONFIG.geofenceRadiusM,
      useForegroundService: SENSING_CONFIG.useForegroundService,
      batteryStartPct: metadata.batteryStartPct,
      batteryEndPct: metadata.batteryEndPct,
      batteryDrainPct: metadata.batteryDrainPct,
      exported_at: new Date().toISOString(),
      files: ['trip_sessions.csv', 'gps_points.csv', 'stop_events.csv', 'segment_times.csv', 'tracking_audit.log'],
    },
    null,
    2,
  );

  const files = [
    { name: 'trip_sessions.csv', content: toCsv(sessions) },
    { name: 'gps_points.csv', content: toCsv(gpsPoints) },
    { name: 'stop_events.csv', content: toCsv(stopEvents) },
    { name: 'segment_times.csv', content: toCsv(segmentTimes) },
    { name: 'metadata.json', content: metadataContent },
    { name: 'tracking_audit.log', content: auditLogContent },
    {
      name: 'bundle.json',
      content: JSON.stringify({ trip_sessions: sessions, gps_points: gpsPoints, stop_events: stopEvents, segment_times: segmentTimes }, null, 2),
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
