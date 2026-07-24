/**
 * Identificativo esterno per-destinatario (es. "OCR notifica" del gestionale
 * PA), mostrato negli export tracciati. Precedenza: colonna mappata a mano
 * in channelConfig.csvMapping.externalId (wizard, CSV generici); altrimenti
 * fallback automatico sulla colonna letterale "external_id" — quella
 * prodotta dai tracciati arricchiti (vedi enrichment.processor.ts), che
 * quindi non richiede alcuna mappatura manuale.
 */
export function resolveExternalId(
  campaign: { channelConfig: Record<string, unknown> },
  recipient: { extraData: Record<string, unknown> },
): string | null {
  const csvMapping = campaign.channelConfig?.['csvMapping'] as Record<string, unknown> | undefined;
  const mappedColumn = csvMapping?.['externalId'] as string | undefined;
  const column = mappedColumn || 'external_id';
  const value = recipient.extraData?.[column] as string | undefined;
  return value && value.trim() ? value.trim() : null;
}
