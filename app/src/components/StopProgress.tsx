import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';

export function StopProgress(props: {
  currentStop: string | null;
  nextStop: string | null;
  state: 'INSIDE' | 'OUTSIDE';
  nearestDistanceM: number | null;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Current Stop: {props.currentStop ?? '-'}</Text>
      <Text style={styles.label}>Next Stop: {props.nextStop ?? '-'}</Text>
      <Text style={styles.label}>State: {props.state}</Text>
      <Text style={styles.label}>Nearest Distance: {props.nearestDistanceM == null ? '-' : `${props.nearestDistanceM.toFixed(1)} m`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
  },
  label: {
    color: colors.text,
    fontSize: 13,
  },
});
