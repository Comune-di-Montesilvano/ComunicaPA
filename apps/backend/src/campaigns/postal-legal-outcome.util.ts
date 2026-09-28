/**
 * Esito legale di una notifica POSTAL (spec 2026-09-28-postal-esito-legale):
 * "Consegnato" = ogni caso che per legge equivale a consegna, con la data
 * legale (valore probatorio). Derivato in lettura, mai scritto. Stesse
 * tabelle per la regola TypeScript (CSV, dettaglio, righe tabella) e per
 * l'espressione SQL (conteggi, filtro, ordinamento): mai duplicarle a mano.
 *
 * Il motivo lo dà GlobalCom (`postal_delivery_status`): Poste non distingue
 * compiuta giacenza/rifiuto da un indirizzo errato (vede solo "restituita"),
 * quindi può solo promuovere a consegnato, mai togliere un esito.
 */

export type PostalLegalOutcome = 'delivered' | 'not_delivered' | 'in_progress' | 'no_legal_value' | 'no_ar' | 'unclassified';

export const POSTAL_LEGAL_OUTCOMES: readonly PostalLegalOutcome[] = ['delivered', 'not_delivered', 'in_progress', 'no_legal_value', 'no_ar', 'unclassified'];

export const POSTAL_LEGAL_OUTCOME_LABELS: Record<PostalLegalOutcome, string> = {
  delivered: 'Consegnato',
  not_delivered: 'Non consegnato',
  in_progress: 'In corso',
  no_legal_value: 'Senza valore legale (solo App IO)',
  no_ar: 'Senza AR',
  unclassified: 'Non classificato',
};

/** Valori reali di `StatoConsegna` GlobalCom (verificati in produzione) che valgono consegna. */
export const LEGAL_DELIVERED_STATUSES: readonly string[] = [
  'Consegnato', 'Consegnato a Domicilio', 'Consegnato a Sportello', 'Consegnato in Digitale', 'Compiuta Giacenza', 'Invio Rifiutato',
];

export const LEGAL_NOT_DELIVERED_STATUSES: readonly string[] = [
  'Destinatario deceduto', 'Destinatario irreperibile', 'Destinatario sconosciuto', 'Destinatario trasferito',
  'Indirizzo errato o inesatto', 'Indirizzo insufficiente', 'Indirizzo sconosciuto', 'Smarrito', 'Inesitato',
];

export interface LegalOutcomeAttempt {
  status: string;
  postalStatus: string | null;
  postalDeliveryStatus: string | null;
  postalDeliveryDate: Date | null;
  sentAt: Date | null;
  errorMessage?: string | null;
  postalStatusHistory?: Array<{ codiceErrore?: string; descrizione?: string }> | null;
}

export interface PostalLegalOutcomeInput {
  diverted: boolean;
  arTracking: boolean;
  /** Ultimo tentativo del destinatario (qualunque canale: il dirottato ha un PEC). */
  attempt: LegalOutcomeAttempt | null;
  /** Riga verifica Poste dell'ultimo tentativo. */
  poste: { status: string; outcomeAt: Date | null } | null;
}

export interface PostalLegalOutcomeResult {
  outcome: PostalLegalOutcome;
  reason: string | null;
  at: Date | null;
}

export function isPostalLegalOutcome(v: unknown): v is PostalLegalOutcome {
  return typeof v === 'string' && (POSTAL_LEGAL_OUTCOMES as readonly string[]).includes(v);
}

function globalcomErrorReason(a: LegalOutcomeAttempt): string {
  const last = [...(a.postalStatusHistory ?? [])].reverse().find((h) => h.codiceErrore && h.codiceErrore !== '0');
  if (!last) return 'Errore GlobalCom';
  return last.descrizione ? `${last.codiceErrore}: ${last.descrizione}` : String(last.codiceErrore);
}

export function postalLegalOutcome(i: PostalLegalOutcomeInput): PostalLegalOutcomeResult {
  const a = i.attempt;
  if (i.diverted) return { outcome: 'delivered', reason: 'Via PEC', at: a?.sentAt ?? null };
  if (a?.postalStatus === 'AppIoSostituito') return { outcome: 'no_legal_value', reason: 'Solo App IO', at: null };
  if (!i.arTracking) return { outcome: 'no_ar', reason: null, at: null };
  if (!a) return { outcome: 'in_progress', reason: null, at: null };
  if (a.status === 'failed') return { outcome: 'not_delivered', reason: a.errorMessage ?? 'Invio fallito', at: null };
  if (a.postalStatus === 'Errore') return { outcome: 'not_delivered', reason: globalcomErrorReason(a), at: null };
  const ds = a.postalDeliveryStatus;
  if (ds && LEGAL_DELIVERED_STATUSES.includes(ds)) return { outcome: 'delivered', reason: ds, at: a.postalDeliveryDate };
  if (i.poste?.status === 'delivered') return { outcome: 'delivered', reason: 'Verifica Poste', at: i.poste.outcomeAt };
  if (ds && LEGAL_NOT_DELIVERED_STATUSES.includes(ds)) return { outcome: 'not_delivered', reason: ds, at: null };
  if (a.postalStatus === 'Eliminato') return { outcome: 'unclassified', reason: 'Eliminato', at: null };
  return { outcome: 'in_progress', reason: ds ?? null, at: null };
}

const sqlList = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

/**
 * `CASE … END` con la stessa regola di postalLegalOutcome, su colonne
 * `<r>.inad_check`, `<la>.id/status/postal_status/postal_delivery_status`
 * (ultimo tentativo) e `<ppt>.status` (verifica Poste dell'ultimo tentativo).
 */
export function postalLegalOutcomeCaseSql(arTracking: boolean, aliases: { r?: string; la?: string; ppt?: string } = {}): string {
  const r = aliases.r ?? 'r';
  const la = aliases.la ?? 'la';
  const ppt = aliases.ppt ?? 'ppt';
  const head = `CASE
    WHEN COALESCE((${r}.inad_check->>'diverted')::boolean, false) THEN 'delivered'
    WHEN ${la}.postal_status = 'AppIoSostituito' THEN 'no_legal_value'`;
  if (!arTracking) return `${head}
    ELSE 'no_ar' END`;
  return `${head}
    WHEN ${la}.id IS NULL THEN 'in_progress'
    WHEN ${la}.status = 'failed' THEN 'not_delivered'
    WHEN ${la}.postal_status = 'Errore' THEN 'not_delivered'
    WHEN ${la}.postal_delivery_status IN (${sqlList(LEGAL_DELIVERED_STATUSES)}) THEN 'delivered'
    WHEN ${ppt}.status = 'delivered' THEN 'delivered'
    WHEN ${la}.postal_delivery_status IN (${sqlList(LEGAL_NOT_DELIVERED_STATUSES)}) THEN 'not_delivered'
    WHEN ${la}.postal_status = 'Eliminato' THEN 'unclassified'
    ELSE 'in_progress' END`;
}

/**
 * Sottoquery scalare: esito legale del destinatario `<recipientAlias>`,
 * sempre una riga (anche senza tentativi). Usabile in SELECT, WHERE,
 * GROUP BY e ORDER BY.
 */
export function postalLegalOutcomeSql(arTracking: boolean, recipientAlias = 'r'): string {
  return `(SELECT ${postalLegalOutcomeCaseSql(arTracking, { r: recipientAlias, la: 'la', ppt: 'ppt' })}
    FROM (SELECT 1) AS _one
    LEFT JOIN LATERAL (
      SELECT na.id, na.status, na.postal_status, na.postal_delivery_status
      FROM notification_attempts na
      WHERE na.recipient_id = ${recipientAlias}.id
      ORDER BY na.attempt_number DESC
      LIMIT 1
    ) la ON true
    LEFT JOIN postal_poste_tracking ppt ON ppt.attempt_id = la.id)`;
}

/**
 * Ultimo tentativo del destinatario `r` in `Errore` GlobalCom (es. nazione
 * non ammessa): "Stato notifica" lo mostra Fallito, `recipient.status`
 * resta `sent` (governa completamento e retry). Se GlobalCom corregge o
 * riaccoda, torna da solo.
 */
export const POSTAL_GLOBALCOM_ERROR_SQL = `EXISTS (
  SELECT 1 FROM notification_attempts na_err
  WHERE na_err.recipient_id = r.id
    AND na_err.attempt_number = (SELECT MAX(na_err2.attempt_number) FROM notification_attempts na_err2 WHERE na_err2.recipient_id = r.id)
    AND na_err.postal_status = 'Errore'
)`;
