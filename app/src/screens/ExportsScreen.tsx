import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { tripController } from '../../trip/TripController';
import { GlassCard } from '../components/GlassCard';
import { colors, spacing } from '../theme/tokens';
import { useTripState } from './useTripState';

export function ExportsScreen() {
  const state = useTripState();
  const disabled = !state.tripId || state.isBusy;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <Text style={styles.title}>Exports</Text>
        <Text style={styles.sub}>CSV + JSON + bundle.zip for local model training workflows.</Text>
      </GlassCard>

      <Pressable style={[styles.button, disabled && styles.disabled]} disabled={disabled} onPress={() => void tripController.exportTrip()}>
        <Text style={styles.buttonText}>Export Legacy JSON</Text>
      </Pressable>
      <Pressable
        style={[styles.button, disabled && styles.disabled]}
        disabled={disabled}
        onPress={() => void tripController.exportBundle()}
      >
        <Text style={styles.buttonText}>Export Bundle (CSV/JSON/ZIP)</Text>
      </Pressable>
      <Pressable
        style={[styles.button, (!state.exportPath || state.isBusy) && styles.disabled]}
        disabled={!state.exportPath || state.isBusy}
        onPress={() => void tripController.shareExport()}
      >
        <Text style={styles.buttonText}>Share Export</Text>
      </Pressable>

      <GlassCard>
        <Text style={styles.info}>Last Export: {state.lastExportTimestampIso ?? '-'}</Text>
        <Text style={styles.info}>Path: {state.exportPath ?? '-'}</Text>
        <Text style={styles.info}>Share: {state.shareAvailable ? 'Available' : 'Unavailable'}</Text>
        <Text style={styles.info}>Hint: {state.shareHint ?? '-'}</Text>
      </GlassCard>
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
    marginTop: 6,
  },
  button: {
    backgroundColor: colors.panelStrong,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: colors.text,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
  info: {
    color: colors.text,
    marginBottom: 4,
  },
});
