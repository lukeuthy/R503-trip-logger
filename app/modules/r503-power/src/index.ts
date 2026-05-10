import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface R503PowerNative {
  acquireWakeLock(tag: string): Promise<boolean>;
  releaseWakeLock(): Promise<boolean>;
  isWakeLockHeld(): Promise<boolean>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
}

const native = requireNativeModule<R503PowerNative>('R503Power');

export async function acquireWakeLock(tag: string = 'trip'): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    return await native.acquireWakeLock(tag);
  } catch {
    return false;
  }
}

export async function releaseWakeLock(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    return await native.releaseWakeLock();
  } catch {
    return false;
  }
}

export async function isWakeLockHeld(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  try {
    return await native.isWakeLockHeld();
  } catch {
    return false;
  }
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    return await native.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  try {
    return await native.requestIgnoreBatteryOptimizations();
  } catch {
    return false;
  }
}
