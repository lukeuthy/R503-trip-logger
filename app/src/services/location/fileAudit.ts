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
  await FileSystem.writeAsStringAsync(path, line, {
    encoding: FileSystem.EncodingType.UTF8,
    append: true,
  });
}

export async function getAuditStats(): Promise<{ path: string; lines: number; bytes: number }> {
  const path = getAuditFilePath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return { path, lines: 0, bytes: 0 };
  }
  const raw = await FileSystem.readAsStringAsync(path);
  const lines = raw.trim().length === 0 ? 0 : raw.trim().split('\n').length;
  return { path, lines, bytes: info.size ?? raw.length };
}
