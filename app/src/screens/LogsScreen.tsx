import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { GlassCard } from '../components/GlassCard';
import { colors, spacing } from '../theme/tokens';
import { getAuditFilePath } from '../services/location/fileAudit';
import { tryShareFile } from '../../utils/share';
import { useTripState } from './useTripState';

const AUDIT_TAIL_LINES = 200;
const REFRESH_INTERVAL_MS = 5_000;

export function LogsScreen() {
  const state = useTripState();
  const [auditLines, setAuditLines] = useState<string[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const path = getAuditFilePath();
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) {
          if (!cancelled) {
            setAuditLines([]);
            setAuditError('audit log not created yet');
          }
          return;
        }
        const raw = await FileSystem.readAsStringAsync(path);
        const all = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
        const tail = all.slice(-AUDIT_TAIL_LINES).reverse();
        if (!cancelled) {
          setAuditLines(tail);
          setAuditError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setAuditError(error instanceof Error ? error.message : 'read failed');
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onShareAudit = async () => {
    try {
      await tryShareFile(getAuditFilePath());
    } catch {
      // best-effort
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Logs</Text>
          <Pressable style={styles.shareButton} onPress={() => void onShareAudit()}>
            <Text style={styles.shareButtonText}>Share audit log</Text>
          </Pressable>
        </View>
        <Text style={styles.sub}>
          Live controller log (newest first) plus audit log tail. Auto-refreshes every 5s.
        </Text>
      </GlassCard>

      <GlassCard>
        <Text style={styles.section}>Controller log ({state.logs.length})</Text>
        {state.logs.length === 0 ? (
          <Text style={styles.empty}>no entries yet</Text>
        ) : (
          state.logs.map((line, index) => (
            <Text key={`ctrl-${index}`} style={styles.logLine}>
              {line}
            </Text>
          ))
        )}
      </GlassCard>

      <GlassCard>
        <Text style={styles.section}>
          Audit log tail ({auditLines.length})
          {auditError ? ` — ${auditError}` : ''}
        </Text>
        {auditLines.length === 0 ? (
          <Text style={styles.empty}>no entries yet</Text>
        ) : (
          auditLines.map((line, index) => (
            <Text key={`aud-${index}`} style={styles.logLine}>
              {prettyAuditLine(line)}
            </Text>
          ))
        )}
      </GlassCard>
    </ScrollView>
  );
}

function prettyAuditLine(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const ts = obj.logged_at ?? obj.ts ?? '';
    const scope = obj.scope ?? '?';
    const action = obj.action ?? '';
    const tripId = typeof obj.trip_id === 'string' ? ` trip=${obj.trip_id.slice(0, 8)}` : '';
    const message = obj.message ?? obj.reason ?? '';
    return `${String(ts).slice(11, 19)} [${scope}/${action}]${tripId} ${message}`.trim();
  } catch {
    return raw;
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  sub: {
    color: colors.textMuted,
    marginTop: 6,
    fontSize: 12,
  },
  section: {
    color: colors.text,
    fontWeight: '700',
    marginBottom: 8,
  },
  empty: {
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  logLine: {
    color: colors.text,
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  shareButton: {
    backgroundColor: colors.panelStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  shareButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
