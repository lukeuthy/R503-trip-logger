import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { tripController } from '../../trip/TripController';
import { GlassCard } from '../components/GlassCard';
import { colors, spacing } from '../theme/tokens';
import { SENSING_CONFIG, VARIANT } from '../utils/experimentConfig';
import { useTripState } from './useTripState';

export function SettingsScreen() {
  const state = useTripState();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.sub}>Tracking quality and diagnostics controls.</Text>
        <Text style={styles.variant}>Build: {SENSING_CONFIG.label} ({VARIANT})</Text>
      </GlassCard>

      <Pressable
        style={styles.toggle}
        onPress={() => {
          void tripController.setChartsMode(!state.chartsMode);
        }}
      >
        <Text style={styles.toggleText}>Visualization Mode: {state.chartsMode ? 'Charts' : 'Text'}</Text>
      </Pressable>

      <Pressable
        style={styles.toggle}
        onPress={() => {
          void tripController.setDebugOverlayEnabled(!state.debugOverlayEnabled);
        }}
      >
        <Text style={styles.toggleText}>Debug Overlay: {state.debugOverlayEnabled ? 'ON' : 'OFF'}</Text>
      </Pressable>

      {state.debugOverlayEnabled ? (
        <GlassCard>
          <Text style={styles.debug}>Raw Accuracy: {state.gpsAccuracyM == null ? '-' : `${state.gpsAccuracyM.toFixed(1)} m`}</Text>
          <Text style={styles.debug}>
            Nearest Stop Distance: {state.nearestStopDistanceM == null ? '-' : `${state.nearestStopDistanceM.toFixed(1)} m`}
          </Text>
          <Text style={styles.debug}>Stop State: {state.insideState}</Text>
          <Text style={styles.debug}>Last Filter Reason: {state.lastFilterReason ?? '-'}</Text>
        </GlassCard>
      ) : null}
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
    fontSize: 20,
    fontWeight: '700',
  },
  sub: {
    color: colors.textMuted,
    marginTop: 4,
  },
  toggle: {
    backgroundColor: colors.panelStrong,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  toggleText: {
    color: colors.text,
    fontWeight: '600',
  },
  debug: {
    color: colors.text,
    marginBottom: 4,
  },
  variant: {
    color: '#9ca3af',
    marginTop: 6,
    fontSize: 11,
  },
});
