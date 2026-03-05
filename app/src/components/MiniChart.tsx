import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';

export function MiniChart(props: { title: string; values: number[]; color?: string }) {
  const values = props.values.slice(-20);
  const max = Math.max(1, ...values);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{props.title}</Text>
      <View style={styles.chart}>
        {values.length === 0 ? <Text style={styles.empty}>No data</Text> : null}
        {values.map((value, index) => (
          <View
            key={`${props.title}-${index}`}
            style={[
              styles.bar,
              {
                height: `${Math.max(6, (value / max) * 100)}%`,
                backgroundColor: props.color ?? colors.accent,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  title: {
    color: colors.textMuted,
    fontSize: 12,
  },
  chart: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  bar: {
    flex: 1,
    borderRadius: 4,
    opacity: 0.9,
  },
  empty: {
    color: colors.textMuted,
  },
});
