import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';
import { GlassCard } from './GlassCard';

export function MetricTile(props: { label: string; value: string; hint?: string }) {
  return (
    <GlassCard style={styles.tile}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={styles.value}>{props.value}</Text>
      {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minHeight: 98,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
  },
  value: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 4,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
});
