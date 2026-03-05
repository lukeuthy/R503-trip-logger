import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DirectionCode, WindowCode } from '../../models/Trip';
import { tripController } from '../../trip/TripController';
import { GlassCard } from '../components/GlassCard';
import { colors, spacing } from '../theme/tokens';
import { useTripState } from './useTripState';

export function TripScreen() {
  const state = useTripState();
  const controlsLocked = state.status === 'recording' || state.isBusy;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <Text style={styles.title}>Trip Session</Text>
        <Text style={styles.sub}>Route: R503</Text>
      </GlassCard>

      <Selector
        label="Direction"
        value={state.directionCode}
        options={['A', 'B']}
        disabled={controlsLocked}
        onChange={(value) => tripController.setDirectionCode(value)}
      />
      <Selector
        label="Service Window"
        value={state.windowCode}
        options={['AM', 'PM', 'OFF']}
        disabled={controlsLocked}
        onChange={(value) => tripController.setWindowCode(value)}
      />

      <View style={styles.row}>
        <Pressable
          style={[styles.button, styles.startButton, controlsLocked && styles.disabled]}
          disabled={controlsLocked}
          onPress={() => void tripController.startTrip()}
        >
          <Text style={styles.buttonText}>Start Trip</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.stopButton, (state.status !== 'recording' || state.isBusy) && styles.disabled]}
          disabled={state.status !== 'recording' || state.isBusy}
          onPress={() => void tripController.stopTrip()}
        >
          <Text style={styles.buttonText}>Stop Trip</Text>
        </Pressable>
      </View>

      <GlassCard>
        <Text style={styles.metric}>Trip ID: {state.tripId ?? '-'}</Text>
        <Text style={styles.metric}>Points: {state.pointsCount}</Text>
        <Text style={styles.metric}>Events: {state.eventsCount}</Text>
        <Text style={styles.metric}>Last Error: {state.lastError ?? '-'}</Text>
      </GlassCard>
    </ScrollView>
  );
}

function Selector<T extends string>(props: {
  label: string;
  value: T;
  options: T[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <GlassCard>
      <Text style={styles.selectorLabel}>{props.label}</Text>
      <View style={styles.row}>
        {props.options.map((option) => (
          <Pressable
            key={option}
            style={[styles.selectorChip, props.value === option && styles.selectorChipActive, props.disabled && styles.disabled]}
            disabled={props.disabled}
            onPress={() => props.onChange(option)}
          >
            <Text style={styles.selectorText}>{option}</Text>
          </Pressable>
        ))}
      </View>
    </GlassCard>
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
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  button: {
    flex: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  startButton: {
    backgroundColor: '#047857',
  },
  stopButton: {
    backgroundColor: '#b91c1c',
  },
  buttonText: {
    color: colors.text,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
  selectorLabel: {
    color: colors.textMuted,
    marginBottom: 8,
  },
  selectorChip: {
    flex: 1,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  selectorChipActive: {
    backgroundColor: colors.panelStrong,
  },
  selectorText: {
    color: colors.text,
    fontWeight: '600',
  },
  metric: {
    color: colors.text,
    marginBottom: 4,
  },
});
