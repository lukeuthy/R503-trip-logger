import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DirectionCode, WindowCode } from './models/Trip';
import { type UITripState, tripController } from './trip/TripController';

function formatNumber(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) {
    return '-';
  }
  return value.toFixed(digits);
}

function renderSelector<T extends string>(
  label: string,
  value: T,
  options: T[],
  disabled: boolean,
  onChange: (next: T) => void,
) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>{label}</Text>
      <View style={styles.selectorRow}>
        {options.map((option) => (
          <Pressable
            key={`${label}-${option}`}
            style={[
              styles.selectorChip,
              value === option && styles.selectorChipActive,
              disabled && styles.selectorChipDisabled,
            ]}
            onPress={() => onChange(option)}
            disabled={disabled}
          >
            <Text style={[styles.selectorChipText, value === option && styles.selectorChipTextActive]}>{option}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function Explore() {
  const [state, setState] = useState<UITripState>(tripController.getState());

  useEffect(() => tripController.subscribe(setState), []);

  const hasTrip = state.tripId != null;
  const isRecording = state.status === 'recording';
  const controlsLocked = isRecording || state.isBusy;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>R503 Logger (Testing) v0.2</Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Route</Text>
          <Text style={styles.valueStrong}>R503 (locked)</Text>
        </View>

        {renderSelector<DirectionCode>('Direction', state.directionCode, ['A', 'B'], controlsLocked, (value) => {
          tripController.setDirectionCode(value);
        })}

        {renderSelector<WindowCode>('Service Window', state.windowCode, ['AM', 'PM', 'OFF'], controlsLocked, (value) => {
          tripController.setWindowCode(value);
        })}

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.button, styles.startButton, controlsLocked && styles.buttonDisabled]}
            onPress={() => {
              void tripController.startTrip();
            }}
            disabled={controlsLocked}
          >
            <Text style={styles.buttonText}>Start Trip</Text>
          </Pressable>

          <Pressable
            style={[styles.button, styles.stopButton, (!isRecording || state.isBusy) && styles.buttonDisabled]}
            onPress={() => {
              void tripController.stopTrip();
            }}
            disabled={!isRecording || state.isBusy}
          >
            <Text style={styles.buttonText}>Stop Trip</Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.button, styles.exportButton, (!hasTrip || state.isBusy) && styles.buttonDisabled]}
          onPress={() => {
            void tripController.exportTrip();
          }}
          disabled={!hasTrip || state.isBusy}
        >
          <Text style={styles.buttonText}>Export JSON</Text>
        </Pressable>

        {state.exportPath && state.shareAvailable && (
          <Pressable
            style={[styles.button, styles.shareButton, state.isBusy && styles.buttonDisabled]}
            onPress={() => {
              void tripController.shareExport();
            }}
            disabled={state.isBusy}
          >
            <Text style={styles.buttonText}>Share Export</Text>
          </Pressable>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Trip Status</Text>
          <Text style={styles.label}>Status: {state.status}</Text>
          <Text style={styles.label}>Busy: {state.isBusy ? 'YES' : 'NO'}</Text>
          <Text style={styles.label}>Trip ID: {state.tripId ?? '-'}</Text>
          <Text style={styles.label}>Points Count: {state.pointsCount}</Text>
          <Text style={styles.label}>Events Count: {state.eventsCount}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Live Telemetry</Text>
          <Text style={styles.label}>Timestamp: {state.lastFix?.timestampIso ?? '-'}</Text>
          <Text style={styles.label}>Latitude: {formatNumber(state.lastFix?.lat ?? null, 6)}</Text>
          <Text style={styles.label}>Longitude: {formatNumber(state.lastFix?.lon ?? null, 6)}</Text>
          <Text style={styles.label}>Accuracy (m): {formatNumber(state.lastFix?.accuracyM ?? null, 1)}</Text>
          <Text style={styles.label}>Speed (m/s): {formatNumber(state.lastFix?.speedMps ?? null, 2)}</Text>
          <Text style={styles.label}>Heading (deg): {formatNumber(state.lastFix?.headingDeg ?? null, 1)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Nearest Stop</Text>
          <Text style={styles.label}>Name: {state.nearestStopName ?? '-'}</Text>
          <Text style={styles.label}>Distance (m): {formatNumber(state.nearestStopDistanceM, 1)}</Text>
          <Text style={styles.label}>State: {state.insideState}</Text>
          <Text style={styles.label}>Inside Stop: {state.insideStopName ?? '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Export Result</Text>
          <Text style={styles.label}>File Path: {state.exportPath ?? '-'}</Text>
          <Text style={styles.label}>Last Export: {state.lastExportTimestampIso ?? '-'}</Text>
          <Text style={styles.label}>{state.shareHint ?? 'If Share button is unavailable, copy via USB.'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Last Error</Text>
          <Text style={styles.errorText}>{state.lastError ?? '-'}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Field Logs</Text>
          {state.logs.length === 0 ? (
            <Text style={styles.label}>-</Text>
          ) : (
            state.logs.slice(0, 10).map((logLine) => (
              <Text key={logLine} style={styles.logLine}>
                {logLine}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#eef2ff',
  },
  container: {
    padding: 14,
    gap: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderColor: '#cbd5e1',
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 2,
  },
  valueStrong: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  selectorRow: {
    flexDirection: 'row',
    gap: 8,
  },
  selectorChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#94a3b8',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  selectorChipActive: {
    borderColor: '#0f766e',
    backgroundColor: '#ccfbf1',
  },
  selectorChipDisabled: {
    opacity: 0.5,
  },
  selectorChipText: {
    color: '#1e293b',
    fontWeight: '600',
    fontSize: 15,
  },
  selectorChipTextActive: {
    color: '#0f766e',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  startButton: {
    flex: 1,
    backgroundColor: '#0f766e',
  },
  stopButton: {
    flex: 1,
    backgroundColor: '#b91c1c',
  },
  exportButton: {
    backgroundColor: '#1d4ed8',
  },
  shareButton: {
    backgroundColor: '#0369a1',
  },
  buttonDisabled: {
    backgroundColor: '#94a3b8',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  label: {
    color: '#111827',
    fontSize: 14,
  },
  errorText: {
    color: '#b91c1c',
    fontSize: 14,
  },
  logLine: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#0f172a',
  },
});
