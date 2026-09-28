import { escapeCsvField } from './csv.util.js';
import type { PostalReportDto, PostalReportRowDto } from './dto/campaign-stats.dto.js';
import { postalStatusLabel, POSTAL_STATUS_HISTORY_COLUMNS } from './postal-status-labels.util.js';
import { POSTAL_LEGAL_OUTCOME_LABELS } from './postal-legal-outcome.util.js';
import { posteVerificationLabel } from '../channels/postal/poste-tracking/poste-tracking-effective.util.js';

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

// Data legale (valore probatorio): solo il giorno. GlobalCom manda DataConsegna
// senza ora, un orario mostrato sarebbe inventato dal fuso.
function formatLegalDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}

// Verifica consegna su tracking Poste — sempre presenti, dopo le colonne
// GlobalCom e prima di quelle condizionali (Esito App IO / External ID).
const POSTE_HEADERS = ['Verifica Poste', 'Sintesi Poste', 'Data Esito Poste', 'Ultimo Movimento Poste', 'Discrepanza GlobalCom/Poste'];

function posteFields(r: PostalReportRowDto): string[] {
  return [
    posteVerificationLabel(r.posteVerification),
    r.posteVerification?.summary ?? '',
    // Data esito: consegna o ritorno al mittente, per l'ente è la data di riferimento.
    formatDate(r.posteVerification?.outcomeAt ?? undefined),
    r.posteVerification?.lastMovement ?? '',
    r.posteDiscrepancy ? 'SI' : '',
  ];
}

function appIoOutcomeLabel(outcome: PostalReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildPostalReportAttualeCsv(report: PostalReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IDPRO', 'Stato Documento', 'Motivo', 'Data Legale', 'Stato GlobalCom', 'Data Stato GlobalCom', 'Stato Consegna Poste', 'Codice Consegna', 'Data Consegna Poste', 'ID Accettazione Poste', 'Codice Errore', 'Descrizione Errore', ...POSTE_HEADERS];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    // postalStatusHistory è append-only in ordine cronologico: l'ultimo
    // elemento è lo stato corrente.
    const latestEntry = r.postalStatusHistory[r.postalStatusHistory.length - 1];
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      // Stato Documento = esito legale; data legale con valore probatorio.
      POSTAL_LEGAL_OUTCOME_LABELS[r.legalOutcome],
      r.legalOutcomeReason ?? '',
      formatLegalDate(r.legalOutcomeAt ?? undefined),
      postalStatusLabel(r.postalStatus),
      formatDate(latestEntry?.rilevatoIl),
      r.postalDeliveryStatus ?? '',
      r.postalDeliveryCode !== null && r.postalDeliveryCode !== undefined ? String(r.postalDeliveryCode) : '',
      formatDate(r.postalDeliveryDate ?? undefined),
      r.postalAcceptanceId ?? '',
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
      ...posteFields(r),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildPostalReportStoricoCsv(report: PostalReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IDPRO', 'Stato Consegna Poste', 'Codice Consegna', 'Data Consegna Poste', 'ID Accettazione Poste', 'Codice Errore', 'Descrizione Errore',
    ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => c.header),
    ...POSTE_HEADERS,
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    // Prima occorrenza per stato (uno stato transitorio come "Rimandato" può
    // ripetersi più volte sui retry GBC): si registra solo la prima volta.
    const firstOccurrenceByStatus = new Map<string, string>();
    for (const h of r.postalStatusHistory) {
      if (!firstOccurrenceByStatus.has(h.stato)) firstOccurrenceByStatus.set(h.stato, h.rilevatoIl);
    }
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      r.postalDeliveryStatus ?? '',
      r.postalDeliveryCode !== null && r.postalDeliveryCode !== undefined ? String(r.postalDeliveryCode) : '',
      formatDate(r.postalDeliveryDate ?? undefined),
      r.postalAcceptanceId ?? '',
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
      ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => formatDate(firstOccurrenceByStatus.get(c.status))),
      ...posteFields(r),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
