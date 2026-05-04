import { NativeModules, Platform } from 'react-native';

type NativeBatteryModule = {
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
};

const nativeModule = NativeModules.BatteryOptimizationModule as NativeBatteryModule | undefined;

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android' || !nativeModule) {
    return true;
  }
  return nativeModule.isIgnoringBatteryOptimizations();
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android' || !nativeModule) {
    return false;
  }
  return nativeModule.requestIgnoreBatteryOptimizations();
}
