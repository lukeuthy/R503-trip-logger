import Constants from 'expo-constants';

export type ExperimentVariant = 'high' | 'medium' | 'low' | 'bg-degraded';

const raw = Constants.expoConfig?.extra?.experimentVariant ?? 'medium';

function normalizeVariant(value: string): ExperimentVariant {
  if (value === 'high' || value === 'medium' || value === 'low' || value === 'bg-degraded') {
    return value;
  }
  return 'medium';
}

export const VARIANT: ExperimentVariant = normalizeVariant(String(raw));

export interface SensingConfig {
  samplingIntervalMs: number;
  fastestIntervalMs: number;
  writeBufferSize: number;
  writeBufferTimeoutMs: number;
  geofenceRadiusM: number;
  departureRadiusM: number;
  dwellTimeMs: number;
  useForegroundService: boolean;
  label: string;
}

const configs: Record<ExperimentVariant, SensingConfig> = {
  high: {
    samplingIntervalMs: 2000,
    fastestIntervalMs: 1000,
    writeBufferSize: 1,
    writeBufferTimeoutMs: 0,
    geofenceRadiusM: 40,
    departureRadiusM: 60,
    dwellTimeMs: 5000,
    useForegroundService: true,
    label: 'HIGH-FREQ',
  },
  medium: {
    samplingIntervalMs: 5000,
    fastestIntervalMs: 3000,
    writeBufferSize: 10,
    writeBufferTimeoutMs: 30000,
    geofenceRadiusM: 40,
    departureRadiusM: 60,
    dwellTimeMs: 5000,
    useForegroundService: true,
    label: 'MEDIUM-FREQ',
  },
  low: {
    samplingIntervalMs: 10000,
    fastestIntervalMs: 7000,
    writeBufferSize: 20,
    writeBufferTimeoutMs: 60000,
    geofenceRadiusM: 55,
    departureRadiusM: 80,
    dwellTimeMs: 8000,
    useForegroundService: true,
    label: 'LOW-FREQ',
  },
  'bg-degraded': {
    samplingIntervalMs: 5000,
    fastestIntervalMs: 3000,
    writeBufferSize: 1,
    writeBufferTimeoutMs: 0,
    geofenceRadiusM: 40,
    departureRadiusM: 60,
    dwellTimeMs: 5000,
    useForegroundService: false,
    label: 'BG-DEGRADED',
  },
};

export const SENSING_CONFIG: SensingConfig = configs[VARIANT];
