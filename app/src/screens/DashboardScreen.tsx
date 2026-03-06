import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { GlassCard } from '../components/GlassCard';
import { MetricTile } from '../components/MetricTile';
import { MiniChart } from '../components/MiniChart';
import { StopProgress } from '../components/StopProgress';
import { colors, spacing } from '../theme/tokens';
import { useTripState } from './useTripState';

function fmt(value: number | null, digits = 1): string {
  if (value == null || Number.isNaN(value)) {
    return '-';
  }
  return value.toFixed(digits);
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

const speedHistory: number[] = [];
const accuracyHistory: number[] = [];

export function DashboardScreen() {
  const state = useTripState();

  if (state.currentSpeedMps != null) {
    speedHistory.push(state.currentSpeedMps);
    if (speedHistory.length > 40) speedHistory.shift();
  }
  if (state.gpsAccuracyM != null) {
    accuracyHistory.push(state.gpsAccuracyM);
    if (accuracyHistory.length > 40) accuracyHistory.shift();
  }

  const statusColor = useMemo(() => {
    if (state.status === 'recording') return colors.success;
    if (state.status === 'stopped') return colors.warning;
    return colors.textMuted;
  }, [state.status]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <Text style={styles.title}>Trip Logger v1.0</Text>
        <Text style={[styles.status, { color: statusColor }]}>Status: {state.status.toUpperCase()}</Text>
        <Text style={styles.subtitle}>Run ID: {state.tripId ?? '-'}</Text>
      </GlassCard>

      <View style={styles.row}>
        <MetricTile label="Elapsed" value={formatElapsed(state.elapsedSeconds)} />
        <MetricTile label="Distance" value={`${fmt(state.totalDistanceM, 0)} m`} />
      </View>
      <View style={styles.row}>
        <MetricTile label="Avg Speed" value={`${fmt(state.avgSpeedMps, 2)} m/s`} />
        <MetricTile label="Current Speed" value={`${fmt(state.currentSpeedMps, 2)} m/s`} />
      </View>
      <View style={styles.row}>
        <MetricTile label="GPS Accuracy" value={`${fmt(state.gpsAccuracyM, 1)} m`} />
        <MetricTile label="Segments" value={`${state.segmentsCount}`} />
      </View>

      <GlassCard>
        <StopProgress
          currentStop={state.insideStopName}
          nextStop={state.expectedNextStopName}
          state={state.insideState}
          nearestDistanceM={state.nearestStopDistanceM}
        />
      </GlassCard>

      {state.chartsMode ? (
        <GlassCard>
          <MiniChart title="Speed Over Time" values={speedHistory} color="#34d399" />
          <MiniChart title="Accuracy Over Time" values={accuracyHistory} color="#60a5fa" />
        </GlassCard>
      ) : (
        <GlassCard>
          <Text style={styles.tableHeader}>Text/Table Mode</Text>
          <Text style={styles.cell}>Points: {state.pointsCount}</Text>
          <Text style={styles.cell}>Events: {state.eventsCount}</Text>
          <Text style={styles.cell}>Last Filter: {state.lastFilterReason ?? '-'}</Text>
          <Text style={styles.cell}>Nearest Stop: {state.nearestStopName ?? '-'}</Text>
        </GlassCard>
      )}
    </ScrollView>
  );
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
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  status: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 12,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  tableHeader: {
    color: colors.text,
    fontWeight: '700',
    marginBottom: 8,
  },
  cell: {
    color: colors.text,
    fontSize: 13,
    marginBottom: 4,
  },
});
