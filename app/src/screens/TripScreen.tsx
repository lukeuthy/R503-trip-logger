import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DirectionCode, WindowCode } from '../../models/Trip';
import { tripController, type UITripState } from '../../trip/TripController';
import { GlassCard } from '../components/GlassCard';
import { colors, spacing } from '../theme/tokens';
import { useTripState } from './useTripState';

export function TripScreen() {
  const state = useTripState();
  const readiness = useMemo(() => computeReadiness(state), [state]);
  const startDisabled = state.status === 'recording' || state.isBusy || !readiness.ready;
  const stopDisabled = state.status !== 'recording' || state.isBusy;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <GlassCard>
        <Text style={styles.title}>Trip Session</Text>
        <Text style={styles.sub}>Route: R503  ·  Variant: {state.variantLabel} ({state.variantId})</Text>
      </GlassCard>

      {state.lastTaskErrorAt != null && Date.now() - state.lastTaskErrorAt < 60_000 ? (
        <Banner tone="error" title="Background task error" message={state.lastTaskErrorMessage ?? 'See logs for details.'} />
      ) : null}

      {state.backgroundPermissionRevoked ? (
        <Banner
          tone="error"
          title="Background location revoked"
          message='Set the system location permission for this app back to "Allow all the time", then tap Start again.'
        />
      ) : null}

      {state.recoveredOrphans.length > 0 ? (
        <Banner
          tone="warn"
          title={`Recovered ${state.recoveredOrphans.length} orphan trip${state.recoveredOrphans.length > 1 ? 's' : ''}`}
          message="Auto-finalized previous unfinished trips. Open Export to retrieve their data."
        />
      ) : null}

      {state.status === 'recording' && state.taskRestartCount >= 5 ? (
        <Banner
          tone="warn"
          title={`OS throttling background service (${state.taskRestartCount} restarts)`}
          message={
            "Open Settings → Apps → R503 Logger → Battery → \"Unrestricted\". " +
            "Also Settings → Battery → Battery optimization → R503 Logger → \"Don't optimize\". " +
            "Without both, Android Doze / App Standby will keep killing GPS tracking once the screen is off."
          }
        />
      ) : null}

      {state.status === 'recording' && state.variantUseForegroundService && !state.foregroundServiceActive ? (
        <Banner
          tone="error"
          title="Foreground service not running"
          message="The OS killed the GPS service. We can only restart it while the app is open. Background restart is blocked by Android 12+. Stop & Start to fully recover."
        />
      ) : null}

      <Selector
        label="Direction"
        value={state.directionCode}
        options={['A', 'B']}
        disabled={state.status === 'recording' || state.isBusy}
        onChange={(value) => tripController.setDirectionCode(value)}
      />
      <Selector
        label="Service Window"
        value={state.windowCode}
        options={['AM', 'PM', 'OFF']}
        disabled={state.status === 'recording' || state.isBusy}
        onChange={(value) => tripController.setWindowCode(value)}
      />

      <View style={styles.row}>
        <Pressable
          style={[styles.button, styles.startButton, startDisabled && styles.disabled]}
          disabled={startDisabled}
          onPress={() => void tripController.startTrip()}
        >
          <Text style={styles.buttonText}>Start Trip</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.stopButton, stopDisabled && styles.disabled]}
          disabled={stopDisabled}
          onPress={() => void tripController.stopTrip()}
        >
          <Text style={styles.buttonText}>Stop Trip</Text>
        </Pressable>
      </View>

      {!readiness.ready && state.status !== 'recording' ? (
        <Text style={styles.readinessHint}>{readiness.reason}</Text>
      ) : null}

      <GlassCard>
        <Text style={styles.tableHeader}>Trip</Text>
        <Text style={styles.metric}>Trip ID: {state.tripId ?? '-'}</Text>
        <Text style={styles.metric}>Elapsed: {formatElapsed(state.elapsedSeconds)}</Text>
        <Text style={styles.metric}>Points: {state.pointsCount}</Text>
        <Text style={styles.metric}>Events: {state.eventsCount}</Text>
        <Text style={styles.metric}>Last Error: {state.lastError ?? '-'}</Text>
      </GlassCard>

      <GlassCard>
        <Text style={styles.tableHeader}>System</Text>
        <StatusRow label="DB ready" value={state.dbReady} />
        <StatusRow label="Foreground location" value={state.foregroundPermissionGranted} />
        <StatusRow label="Background location" value={state.backgroundPermissionGranted} />
        <StatusRow label="Location services" value={state.locationServicesEnabled} />
        <StatusRow
          label="Battery optimization"
          value={state.batteryOptimizationWhitelisted}
          okLabel="whitelisted"
          notOkLabel="not whitelisted"
        />
        <StatusRow
          label="Foreground service"
          value={state.status === 'recording' ? state.foregroundServiceActive : null}
          okLabel="running"
          notOkLabel="off"
        />
        <StatusRow
          label="Wake lock"
          value={state.status === 'recording' ? state.wakeLockHeld : null}
          okLabel="held"
          notOkLabel="released"
        />
        <Text style={styles.metric}>
          Last GPS: {formatGpsAge(state.healthLastWriteMs, state.startedAtMs, state.status)}
        </Text>
        <Text style={styles.metric}>Task restarts: {state.taskRestartCount}</Text>
        <Text style={styles.metric}>
          Sampling: {Math.round(state.variantSamplingMs / 1000)}s · FG service: {state.variantUseForegroundService ? 'yes' : 'no'}
        </Text>
      </GlassCard>
    </ScrollView>
  );
}

interface ReadinessResult {
  ready: boolean;
  reason: string;
}

function computeReadiness(state: UITripState): ReadinessResult {
  if (!state.dbReady) {
    return { ready: false, reason: 'Waiting for database to initialize…' };
  }
  if (state.foregroundPermissionGranted === false) {
    return { ready: false, reason: 'Foreground location permission required.' };
  }
  if (state.backgroundPermissionGranted === false) {
    return { ready: false, reason: 'Grant "Allow all the time" location permission to start a trip.' };
  }
  if (state.locationServicesEnabled === false) {
    return { ready: false, reason: 'Location services are OFF. Enable GPS to start.' };
  }
  return { ready: true, reason: '' };
}

function formatGpsAge(lastWriteMs: number | null, startedAtMs: number | null, status: UITripState['status']): string {
  if (status !== 'recording') {
    return '-';
  }
  if (lastWriteMs == null) {
    if (startedAtMs == null) return 'pending';
    const age = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
    return `pending (${age}s elapsed)`;
  }
  const ageSec = Math.max(0, Math.floor((Date.now() - lastWriteMs) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  return `${Math.floor(ageSec / 60)}m ago`;
}

function StatusRow(props: { label: string; value: boolean | null; okLabel?: string; notOkLabel?: string }) {
  const okLabel = props.okLabel ?? 'ok';
  const notOkLabel = props.notOkLabel ?? 'not ok';
  let valueText = '—';
  let valueColor = colors.textMuted;
  if (props.value === true) {
    valueText = `✓ ${okLabel}`;
    valueColor = colors.success;
  } else if (props.value === false) {
    valueText = `✗ ${notOkLabel}`;
    valueColor = colors.warning;
  }
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{props.label}</Text>
      <Text style={[styles.statusValue, { color: valueColor }]}>{valueText}</Text>
    </View>
  );
}

function Banner(props: { tone: 'error' | 'warn'; title: string; message: string }) {
  const tone = props.tone === 'error' ? styles.bannerError : styles.bannerWarn;
  return (
    <View style={[styles.banner, tone]}>
      <Text style={styles.bannerTitle}>{props.title}</Text>
      <Text style={styles.bannerMessage}>{props.message}</Text>
    </View>
  );
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
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
  readinessHint: {
    color: colors.warning,
    fontSize: 12,
    textAlign: 'center',
    marginTop: -spacing.sm,
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
  tableHeader: {
    color: colors.text,
    fontWeight: '700',
    marginBottom: 8,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  statusLabel: {
    color: colors.text,
  },
  statusValue: {
    fontWeight: '600',
  },
  banner: {
    borderRadius: 10,
    padding: 12,
  },
  bannerError: {
    backgroundColor: 'rgba(220,38,38,0.18)',
    borderColor: '#dc2626',
    borderWidth: 1,
  },
  bannerWarn: {
    backgroundColor: 'rgba(234,179,8,0.18)',
    borderColor: '#eab308',
    borderWidth: 1,
  },
  bannerTitle: {
    color: colors.text,
    fontWeight: '700',
    marginBottom: 4,
  },
  bannerMessage: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
