import type { NotificationChannel } from '@comunicapa/shared-types';

export const NOTIFICATION_JOB_SEND = 'send';

/** Una coda BullMQ dedicata per ogni canale: motori indipendenti, pausabili singolarmente. */
export const CHANNEL_QUEUES: Record<NotificationChannel, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  SEND: 'notifications-send',
  POSTAL: 'notifications-postal',
};

export const ALL_CHANNELS = Object.keys(CHANNEL_QUEUES) as NotificationChannel[];

export const THROTTLE_REDIS = 'THROTTLE_REDIS';

