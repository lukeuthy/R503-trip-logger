import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';
import { DashboardScreen } from './DashboardScreen';
import { ExportsScreen } from './ExportsScreen';
import { SettingsScreen } from './SettingsScreen';
import { TripScreen } from './TripScreen';

type TabId = 'dashboard' | 'trip' | 'exports' | 'settings';

export function AppTabs() {
  const [tab, setTab] = useState<TabId>('dashboard');
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        {tab === 'dashboard' ? <DashboardScreen /> : null}
        {tab === 'trip' ? <TripScreen /> : null}
        {tab === 'exports' ? <ExportsScreen /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      <View style={styles.tabBar}>
        <TabButton active={tab === 'dashboard'} label="Dashboard" onPress={() => setTab('dashboard')} />
        <TabButton active={tab === 'trip'} label="Trip" onPress={() => setTab('trip')} />
        <TabButton active={tab === 'exports'} label="Export" onPress={() => setTab('exports')} />
        <TabButton active={tab === 'settings'} label="Settings" onPress={() => setTab('settings')} />
      </View>
    </SafeAreaView>
  );
}

function TabButton(props: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabButton, props.active && styles.tabButtonActive]} onPress={props.onPress}>
      <Text style={[styles.tabText, props.active && styles.tabTextActive]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(12,16,24,0.98)',
    gap: 8,
  },
  tabButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: colors.panelStrong,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  tabTextActive: {
    color: colors.text,
  },
});
