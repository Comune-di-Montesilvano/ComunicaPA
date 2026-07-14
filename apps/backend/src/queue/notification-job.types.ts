import type { NotificationChannel } from '@comunicapa/shared-types';

export const NOTIFICATION_JOB_SEND = 'send';

/**
 * Una coda BullMQ dedicata per ogni canale, ECCETTO SEND: SEND non passa più
 * da BullMQ (vedi ProtocollazioneSyncService/SendDispatchService, entrambi
 * poll-based su NotificationAttempt) — vedi docs/superpowers/specs/2026-07-14-pipeline-demoni-send-design.md.
 */
export const CHANNEL_QUEUES: Record<Exclude<NotificationChannel, 'SEND'>, string> = {
  EMAIL: 'notifications-email',
  PEC: 'notifications-pec',
  APP_IO: 'notifications-appio',
  POSTAL: 'notifications-postal',
};

export const QUEUED_CHANNELS = Object.keys(CHANNEL_QUEUES) as Array<Exclude<NotificationChannel, 'SEND'>>;

export const THROTTLE_REDIS = 'THROTTLE_REDIS';
