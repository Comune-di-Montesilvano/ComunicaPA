import { createHash } from 'crypto';
import { postalLegalOutcome, type PostalLegalOutcome } from '../campaigns/postal-legal-outcome.util.js';
import { sendLegalDateOf } from '../campaigns/send-legal-date.util.js';
import { hasPostalArTracking } from '../campaigns/campaigns.service.js';
import { isPartitaIva } from '../channels/tax-id.util.js';
import type { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import type { Recipient } from '../entities/recipient.entity.js';

export type NotificationAttemptLike = Pick<
  NotificationAttempt,
  | 'status' | 'channelType' | 'sentAt' | 'errorMessage' | 'iun' | 'sendStatus' | 'sendStatusHistory'
  | 'protocolNumber' | 'protocolYear' | 'protocolledAt' | 'postalTrackingId' | 'postalStatus'
  | 'postalStatusHistory' | 'postalDeliveryStatus' | 'postalDeliveryDate' | 'costCents' | 'responsePayload'
>;

export interface StatusInput {
  recipient: { id: string; createdAt: Date; status: string; codiceFiscale: string; inadCheck: Recipient['inadCheck'] };
  campaign: { status: string; channelType: string; channelConfig: Record<string, unknown> };
  attempt: NotificationAttemptLike | null;
  poste: { status: string; outcomeAt: Date | null } | null;
}

export type NotificationStatus = 'accepted' | 'checking' | 'pending_review' | 'in_progress' | 'sent' | 'delivered' | 'not_delivered' | 'failed' | 'cancelled';

export interface NotificationEvent { id: string; type: string; at: string; data: Record<string, unknown> }

export interface NotificationStatusResponse {
  success: true;
  notificationId: string;
  externalReference: string | null;
  createdAt: string;
  requestedChannel: string;
  effectiveChannel: string;
  diversion: { source: 'INAD' | 'REGISTRO_IMPRESE' } | null;
  status: NotificationStatus;
  legal?: { outcome: PostalLegalOutcome; at: string | null; reason: string | null };
  send?: { iun: string | null; status: string | null; legalDate: string | null; protocol: { number: number; year: number; at: string | null } | null };
  postal?: { trackingId: string | null; status: string | null; deliveryStatus: string | null; deliveryDate: string | null };
  appIoParallel?: { success: boolean };
  costCents: number | null;
  error: string | null;
  events: NotificationEvent[];
}

const SEND_NOT_DELIVERED = ['UNREACHABLE', 'CANCELLED', 'REFUSED'];
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function event(type: string, at: string, data: Record<string, unknown> = {}): NotificationEvent {
  const id = createHash('sha1').update(`${type}|${at}|${JSON.stringify(data)}`).digest('hex');
  return { id, type, at, data };
}

export function buildNotificationStatus(input: StatusInput): NotificationStatusResponse {
  const { recipient, campaign, attempt } = input;
  const cfg = campaign.channelConfig ?? {};
  const diverted = !!recipient.inadCheck?.diverted && recipient.status !== 'pending_review';
  const effectiveChannel = attempt?.channelType ?? campaign.channelType;

  // --- esito legale: POSTAL, SEND e qualunque canale dirottato a PEC ---
  // (il ramo `diverted` di postalLegalOutcome è indipendente dal canale di partenza)
  let legal: NotificationStatusResponse['legal'];
  if (campaign.channelType === 'POSTAL' || (diverted && campaign.channelType !== 'SEND')) {
    const r = postalLegalOutcome({
      diverted,
      arTracking: hasPostalArTracking({ channelConfig: cfg }),
      attempt: attempt
        ? { status: attempt.status, postalStatus: attempt.postalStatus, postalDeliveryStatus: attempt.postalDeliveryStatus, postalDeliveryDate: attempt.postalDeliveryDate, sentAt: attempt.sentAt, errorMessage: attempt.errorMessage, postalStatusHistory: attempt.postalStatusHistory }
        : null,
      poste: input.poste,
    });
    legal = { outcome: r.outcome, at: iso(r.at), reason: r.reason };
  } else if (campaign.channelType === 'SEND' && attempt) {
    const legalDate = sendLegalDateOf(attempt.sendStatusHistory);
    if (attempt.status === 'failed') legal = { outcome: 'not_delivered', at: null, reason: attempt.errorMessage ?? 'Invio fallito' };
    else if (legalDate) legal = { outcome: 'delivered', at: legalDate, reason: attempt.sendStatus };
    else if (attempt.sendStatus && SEND_NOT_DELIVERED.includes(attempt.sendStatus)) legal = { outcome: 'not_delivered', at: null, reason: attempt.sendStatus };
    else legal = { outcome: 'in_progress', at: null, reason: attempt.sendStatus };
  }

  // --- errore (regola v1) ---
  let error: string | null = null;
  if (attempt?.status === 'failed') error = attempt.errorMessage ?? 'Invio fallito';
  else if (attempt?.channelType === 'POSTAL') {
    const last = [...(attempt.postalStatusHistory ?? [])].reverse().find((h) => h.codiceErrore && h.codiceErrore !== '0');
    if (last) error = last.descrizione ? `${last.codiceErrore}: ${last.descrizione}` : last.codiceErrore ?? null;
  }

  // --- status riassuntivo ---
  let status: NotificationStatus;
  if (recipient.status === 'pending_review') status = 'pending_review';
  else if (!attempt) status = campaign.status === 'checking_inad' ? 'checking' : campaign.status === 'cancelled' ? 'cancelled' : 'accepted';
  else if (attempt.status === 'failed') status = 'failed';
  else if (attempt.status === 'cancelled') status = 'cancelled';
  else if (attempt.status === 'queued' || attempt.status === 'processing') status = 'in_progress';
  else if (legal?.outcome === 'delivered') status = 'delivered';
  else if (legal?.outcome === 'not_delivered') status = 'not_delivered';
  else status = 'sent';

  // --- eventi derivati ---
  const events: NotificationEvent[] = [event('accepted', recipient.createdAt.toISOString())];
  const checkedAt = recipient.inadCheck?.checkedAt;
  if (recipient.status === 'pending_review' && checkedAt) events.push(event('pending_review', checkedAt));
  else if (diverted && checkedAt) events.push(event('diverted', checkedAt, { to: 'PEC' }));
  if (attempt?.protocolledAt) events.push(event('protocolled', attempt.protocolledAt.toISOString(), { number: attempt.protocolNumber, year: attempt.protocolYear }));
  if (attempt?.sentAt) events.push(event('sent', attempt.sentAt.toISOString(), { channel: attempt.channelType }));
  for (const h of attempt?.sendStatusHistory ?? []) events.push(event('send_status', new Date(h.activeFrom).toISOString(), { status: h.status }));
  for (const h of attempt?.postalStatusHistory ?? []) {
    events.push(event('postal_status', new Date(h.rilevatoIl).toISOString(), { stato: h.stato, ...(h.codiceErrore && h.codiceErrore !== '0' ? { codiceErrore: h.codiceErrore } : {}) }));
  }
  if (input.poste?.outcomeAt) events.push(event('poste_tracking', input.poste.outcomeAt.toISOString(), { status: input.poste.status }));
  if (attempt?.status === 'failed') events.push(event('failed', (attempt.sentAt ?? recipient.createdAt).toISOString(), { error }));
  events.sort((a, b) => a.at.localeCompare(b.at));

  const response: NotificationStatusResponse = {
    success: true,
    notificationId: recipient.id,
    externalReference: (cfg['externalReference'] as string | undefined) ?? null,
    createdAt: recipient.createdAt.toISOString(),
    requestedChannel: campaign.channelType,
    effectiveChannel,
    diversion: diverted ? { source: isPartitaIva(recipient.codiceFiscale) ? 'REGISTRO_IMPRESE' : 'INAD' } : null,
    status,
    costCents: attempt?.costCents ?? null,
    error,
    events,
  };
  if (legal) response.legal = legal;
  if (effectiveChannel === 'SEND' && attempt) {
    response.send = {
      iun: attempt.iun,
      status: attempt.sendStatus,
      legalDate: sendLegalDateOf(attempt.sendStatusHistory),
      protocol: attempt.protocolNumber != null && attempt.protocolYear != null ? { number: attempt.protocolNumber, year: attempt.protocolYear, at: iso(attempt.protocolledAt) } : null,
    };
  }
  if (effectiveChannel === 'POSTAL' && attempt) {
    response.postal = { trackingId: attempt.postalTrackingId, status: attempt.postalStatus, deliveryStatus: attempt.postalDeliveryStatus, deliveryDate: iso(attempt.postalDeliveryDate) };
  }
  if (Array.isArray(cfg['secondaryChannels']) && attempt) {
    response.appIoParallel = { success: !!(attempt.responsePayload?.['appIo'] as { success?: boolean } | undefined)?.success };
  }
  return response;
}
