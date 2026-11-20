/**
 * Ricerca di un destinatario per OCR / External ID e per numero
 * raccomandata, condivisa da Ricerca Notifiche e lista destinatari della
 * campagna. `param` è il nome del parametro LIKE già usato dalla query
 * (`%testo%`).
 *
 * - OCR: valore in extra_data nella colonna External ID della campagna
 *   (`externalIdColumnSql`: espressione SQL o parametro, vedi chiamanti).
 * - Raccomandata: postal_acceptance_id dei tentativi (Postalizzazione) o
 *   codice Poste del recapitista SEND (postal_poste_tracking).
 */
export function identifierSearchSql(recipientAlias: string, externalIdColumnSql: string, param: string): string {
  return `LOWER(${recipientAlias}.extra_data ->> ${externalIdColumnSql}) LIKE LOWER(:${param})`
    + ` OR EXISTS (SELECT 1 FROM notification_attempts ra WHERE ra.recipient_id = ${recipientAlias}.id AND (`
    + `LOWER(ra.postal_acceptance_id) LIKE LOWER(:${param})`
    + ` OR EXISTS (SELECT 1 FROM postal_poste_tracking pt WHERE pt.attempt_id = ra.id AND LOWER(pt.tracking_code) LIKE LOWER(:${param}))))`;
}

/** Colonna External ID della campagna (mappata dal wizard o `external_id`), lato SQL. */
export function externalIdColumnOfCampaignSql(campaignAlias: string): string {
  return `COALESCE(NULLIF(${campaignAlias}.channel_config -> 'csvMapping' ->> 'externalId', ''), 'external_id')`;
}

/** Stessa regola lato TS (resolveExternalId), per query senza join sulla campagna. */
export function externalIdColumnOf(campaign: { channelConfig: Record<string, unknown> | null }): string {
  const csvMapping = campaign.channelConfig?.['csvMapping'] as Record<string, unknown> | undefined;
  return (csvMapping?.['externalId'] as string | undefined) || 'external_id';
}
