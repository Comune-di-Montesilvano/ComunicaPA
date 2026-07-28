import { RecipientStatus } from '../entities/recipient.entity';

export type ChannelOutcome = 'primaryOnly' | 'both' | 'appIoOnly' | 'appIoDespitePrimaryFail' | 'neither';

export function classifyChannelOutcome(
  recipientStatus: RecipientStatus,
  responsePayload: Record<string, unknown> | null | undefined,
): ChannelOutcome | null {
  if (recipientStatus !== RecipientStatus.SENT && recipientStatus !== RecipientStatus.FAILED) return null;

  const appIo = responsePayload?.['appIo'] as { success?: boolean } | undefined;
  const deliveredViaAppIo = responsePayload?.['deliveredVia'] === 'APP_IO';
  const appIoSucceeded = !!appIo?.success;
  const primarySucceeded = recipientStatus === RecipientStatus.SENT && !deliveredViaAppIo;

  if (primarySucceeded && appIoSucceeded) return 'both';
  if (primarySucceeded) return 'primaryOnly';
  if (deliveredViaAppIo && appIoSucceeded) return 'appIoOnly';
  if (recipientStatus === RecipientStatus.FAILED && appIoSucceeded) return 'appIoDespitePrimaryFail';
  return 'neither';
}
