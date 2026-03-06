import * as FileSystem from 'expo-file-system/legacy';

const AUDIT_FILE = 'r503_tracking_audit.log';

export function getAuditFilePath(): string {
  const baseDir = FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error('documentDirectory unavailable.');
  }
  return `${baseDir}${AUDIT_FILE}`;
}

export async function appendAuditLog(entry: Record<string, unknown>): Promise<void> {
  const path = getAuditFilePath();
  const line = `${JSON.stringify({ ...entry, logged_at: new Date().toISOString() })}\n`;
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.writeAsStringAsync(path, line);
    return;
  }
  const previous = await FileSystem.readAsStringAsync(path);
  await FileSystem.writeAsStringAsync(path, `${previous}${line}`);
}
