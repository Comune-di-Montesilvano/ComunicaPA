import { maggioliOcr } from './maggioli-export.util.js';

/**
 * Abbinamento a posteriori dell'OCR Maggioli (External ID) ai destinatari
 * di una campagna, da coppie CF/P.IVA → OCR (CSV estratto da Sicr@Web).
 * Regole: chiave = codice fiscale / partita IVA; si scrive solo dove
 * l'External ID manca; ogni ambiguità resta fuori e viene contata.
 */

export interface OcrImportRecipient {
  id: string;
  codiceFiscale: string;
  /** External ID attuale (resolveExternalId), null se assente. */
  externalId: string | null;
}

export interface OcrImportResult {
  /** Destinatario → OCR da scrivere. */
  toWrite: Array<{ recipientId: string; ocr: string }>;
  /** Riepilogo per l'operatore. */
  summary: {
    righeCsv: number;
    daScrivere: number;
    giaPresenti: number;
    /** External ID già presente e diverso: lasciato com'è. */
    diversi: number;
    nonTrovati: number;
    /** Stesso CF su più destinatari della campagna. */
    ambiguiCampagna: number;
    /** Stesso CF con OCR diversi nel CSV. */
    ambiguiCsv: number;
    /** OCR mancante o < 16 caratteri, o CF vuoto. */
    nonValidi: number;
    /** Destinatari della campagna ancora senza OCR dopo l'abbinamento. */
    senzaOcrDopo: number;
  };
}

/** CF/P.IVA normalizzato; P.IVA numerica con zeri iniziali persi (Excel) riportata a 11 cifre. */
export function normalizeTaxKey(raw: string): string {
  // Apostrofo iniziale = forzatura a testo di Excel (export Maggioli).
  const v = raw.replace(/\s+/g, '').replace(/^'+/, '').toUpperCase();
  return /^\d{1,10}$/.test(v) ? v.padStart(11, '0') : v;
}

export function matchOcrImport(pairs: Array<[string, string]>, recipients: OcrImportRecipient[]): OcrImportResult {
  const summary: OcrImportResult['summary'] = {
    righeCsv: pairs.length, daScrivere: 0, giaPresenti: 0, diversi: 0, nonTrovati: 0,
    ambiguiCampagna: 0, ambiguiCsv: 0, nonValidi: 0, senzaOcrDopo: 0,
  };

  // CSV: CF → OCR (un CF con OCR diversi è ambiguo).
  const ocrByCf = new Map<string, string | null>();
  for (const [rawCf, rawOcr] of pairs) {
    const cf = normalizeTaxKey(rawCf ?? '');
    const ocr = (rawOcr ?? '').trim().replace(/^'+/, '').trim();
    if (!cf || !maggioliOcr(ocr)) {
      summary.nonValidi++;
      continue;
    }
    const prev = ocrByCf.get(cf);
    if (prev === undefined) ocrByCf.set(cf, ocr);
    else if (prev !== null && maggioliOcr(prev) !== maggioliOcr(ocr)) ocrByCf.set(cf, null);
  }

  const recipientsByCf = new Map<string, OcrImportRecipient[]>();
  for (const r of recipients) {
    const cf = normalizeTaxKey(r.codiceFiscale);
    recipientsByCf.set(cf, [...(recipientsByCf.get(cf) ?? []), r]);
  }

  const toWrite: OcrImportResult['toWrite'] = [];
  const written = new Set<string>();
  for (const [cf, ocr] of ocrByCf) {
    if (ocr === null) {
      summary.ambiguiCsv++;
      continue;
    }
    const matches = recipientsByCf.get(cf) ?? [];
    if (matches.length === 0) {
      summary.nonTrovati++;
      continue;
    }
    if (matches.length > 1) {
      summary.ambiguiCampagna++;
      continue;
    }
    const r = matches[0];
    if (r.externalId) {
      if (maggioliOcr(r.externalId) === maggioliOcr(ocr)) summary.giaPresenti++;
      else summary.diversi++;
      continue;
    }
    toWrite.push({ recipientId: r.id, ocr });
    written.add(r.id);
  }
  summary.daScrivere = toWrite.length;
  summary.senzaOcrDopo = recipients.filter((r) => !maggioliOcr(r.externalId) && !written.has(r.id)).length;
  return { toWrite, summary };
}
