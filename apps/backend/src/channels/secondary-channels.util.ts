import type { NotificationChannel } from '@comunicapa/shared-types';

export interface SecondaryChannelConfig {
  channel: NotificationChannel;
  mode: 'parallel' | 'exclusive';
  ioServiceId?: string;
  subjectOverride?: string;
  bodyOverride?: string;
}

/**
 * Risolve la configurazione del canale secondario App IO. Preferisce il
 * nuovo formato array `channelConfig.secondaryChannels` (chiave = tipo
 * canale, pronto per canali secondari futuri oltre App IO), con fallback
 * al vecchio campo scalare `channelConfig.appIo` per le campagne create
 * prima di questa generalizzazione. Solo APP_IO è gestito oggi: altre
 * entry dell'array sono ignorate (nessun canale secondario diverso da
 * App IO è implementato lato invio).
 */
export function resolveSecondaryAppIoConfig(
  channelConfig: Record<string, unknown> | undefined,
): SecondaryChannelConfig | { mode?: 'parallel' | 'exclusive'; ioServiceId?: string } | undefined {
  const secondaryChannels = channelConfig?.['secondaryChannels'] as SecondaryChannelConfig[] | undefined;
  const fromArray = secondaryChannels?.find((c) => c.channel === 'APP_IO');
  if (fromArray) return fromArray;

  return channelConfig?.['appIo'] as { mode?: 'parallel' | 'exclusive'; ioServiceId?: string } | undefined;
}
