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

/** Coda dedicata alla protocollazione (channel-agnostica: oggi solo SEND la usa, campaign.channelConfig.protocolla=true). */
export const PROTOCOLLAZIONE_QUEUE = 'notifications-protocollazione';

/**
 * "Motori" gestiti con lo stesso meccanismo generico (pausa/riprendi/job
 * falliti/log) dei canali BullMQ — PROTOCOLLAZIONE non è un NotificationChannel
 * (è channel-agnostica), ma va gestita identicamente dalla tab Motori.
 */
export const ENGINE_QUEUES = {
  ...CHANNEL_QUEUES,
  PROTOCOLLAZIONE: PROTOCOLLAZIONE_QUEUE,
} as const;

export type EngineName = keyof typeof ENGINE_QUEUES;
export const ENGINE_NAMES = Object.keys(ENGINE_QUEUES) as EngineName[];

export const THROTTLE_REDIS = 'THROTTLE_REDIS';
