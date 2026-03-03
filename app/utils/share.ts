export interface ShareResult {
  shared: boolean;
  reason?: string;
}

let cachedSharingAvailable: boolean | null = null;

export async function isSharingAvailable(): Promise<boolean> {
  if (cachedSharingAvailable != null) {
    return cachedSharingAvailable;
  }

  try {
    const Sharing = await import('expo-sharing');
    cachedSharingAvailable = await Sharing.isAvailableAsync();
    return cachedSharingAvailable;
  } catch {
    cachedSharingAvailable = false;
    return false;
  }
}

export async function tryShareFile(uri: string): Promise<ShareResult> {
  try {
    const Sharing = await import('expo-sharing');
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      return { shared: false, reason: 'sharing-not-available' };
    }

    await Sharing.shareAsync(uri);
    return { shared: true };
  } catch {
    return { shared: false, reason: 'sharing-unavailable' };
  }
}
