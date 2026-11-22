import { parseCsvContent, buildCsvContent, detectDelimiter, parseCsvLine } from '../../io-services/csv.util.js';
import { checkTaxId } from '../tax-id.util.js';
import type { RegistroImpreseOutcome } from '../../entities/domicile-verification-job.entity.js';

export interface DomicileVerificationCsvInput {
  sourceCsv: string;
  hasHeaders: boolean;
  cfColumn: string;
  inadFoundMap: Record<string, string>;
  appIoResults: Record<string, boolean>;
  registroImpreseResults: Record<string, string | null>;
  /** CF/PIVA → esito (trovata, cessazione). Chiave assente con esito in registroImpreseResults = verifica non riuscita. */
  registroImpreseFoundMap?: Record<string, RegistroImpreseOutcome>;
  /** CF fisico → presente in ANPR (C030). Chiave assente = non verificato. */
  anprResults?: Record<string, boolean>;
  /** CF fisico → esistenza in vita S/N, null = non presente in ANPR (C007). Chiave assente = non verificato. */
  anprVitaResults?: Record<string, 'S' | 'N' | null>;
  /** CF di richieste ANPR con esito inattendibile (DomicileAnprRequest.failed). */
  anprFailedCfs?: string[];
}

export interface DomicileVerificationCsvResult {
  assentiCsv: string;
  appIoCsv: string | null;
  inadCsv: string | null;
  registroImpreseCsv: string | null;
  aggregatoCsv: string;
}

const ADDRESS_COLUMN = 'domicilio_digitale_inad';
const PEC_COLUMN = 'pec_registro_imprese';
const AGGREGATE_DOMICILIO_COLUMN = 'domicilio_digitale';
const AGGREGATE_APPIO_COLUMN = 'app_io';
const AGGREGATE_ERRORI_COLUMN = 'errori';

interface RowOutcome {
  domicilio: string;
  appIo: string;
  errori: string[];
}

export function buildDomicileVerificationCsvs(input: DomicileVerificationCsvInput): DomicileVerificationCsvResult {
  const parsed = parseCsvContent(input.sourceCsv, input.hasHeaders);
  const foundMap = input.registroImpreseFoundMap ?? {};
  const anpr = input.anprResults ?? {};
  const vita = input.anprVitaResults ?? {};
  const anprFailed = new Set(input.anprFailedCfs ?? []);

  const assentiRows: Record<string, string>[] = [];
  const appIoRows: Record<string, string>[] = [];
  const inadRows: Record<string, string>[] = [];
  const registroImpreseRows: Record<string, string>[] = [];
  const outcomes: RowOutcome[] = [];

  for (const row of parsed.rows) {
    const check = checkTaxId(row[input.cfColumn] || '');
    const key = check.value;
    const errori: string[] = [];

    // Valori che non passano il controllo formale non sono mai stati
    // interrogati: nessun esito da leggere, solo l'errore.
    const valid = check.kind !== 'invalid';
    const cfFisico = check.kind === 'cf';
    const inadAddress = cfFisico ? input.inadFoundMap[key] : undefined;
    const appIoActive = cfFisico ? input.appIoResults[key] : undefined;
    const registroPec = valid ? input.registroImpreseResults[key] || undefined : undefined;

    if (check.kind === 'invalid') {
      errori.push(check.error);
    } else if (check.kind === 'piva') {
      const outcome = foundMap[key];
      if (outcome?.found === false) errori.push('partita IVA non trovata nel Registro Imprese');
      else if (outcome?.stato) errori.push(ceasedError(outcome));
      else if (key in input.registroImpreseResults && !(key in foundMap) && input.registroImpreseFoundMap) {
        errori.push('verifica Registro Imprese non riuscita');
      }
    } else {
      // C030 e C007 dicono entrambi "non presente": un solo messaggio.
      if (anpr[key] === false || vita[key] === null) errori.push('codice fiscale non presente in ANPR (mai iscritto o cancellato)');
      if (vita[key] === 'N') errori.push('soggetto deceduto (ANPR)');
      if (anprFailed.has(key)) errori.push('verifica ANPR non riuscita');
    }

    // Vuoto sempre tranne quando attivo — mai "non attivo": vuoto = nessuna
    // informazione (PIVA, CF non valido o non iscritto).
    outcomes.push({ domicilio: registroPec || inadAddress || '', appIo: appIoActive ? 'attivo' : '', errori });

    if (inadAddress) inadRows.push({ ...row, [ADDRESS_COLUMN]: inadAddress });
    if (appIoActive) appIoRows.push({ ...row });
    if (registroPec) registroImpreseRows.push({ ...row, [PEC_COLUMN]: registroPec });
    if (!inadAddress && !appIoActive && !registroPec) assentiRows.push({ ...row });
  }

  return {
    assentiCsv: buildCsvContent(parsed.headers, assentiRows),
    appIoCsv: appIoRows.length > 0 ? buildCsvContent(parsed.headers, appIoRows) : null,
    inadCsv: inadRows.length > 0 ? buildCsvContent([...parsed.headers, ADDRESS_COLUMN], inadRows) : null,
    registroImpreseCsv: registroImpreseRows.length > 0 ? buildCsvContent([...parsed.headers, PEC_COLUMN], registroImpreseRows) : null,
    aggregatoCsv: buildAggregato(input.sourceCsv, input.hasHeaders, outcomes),
  };
}

/** Errore per un'impresa con stato-impresa: parti mancanti omesse. */
function ceasedError(o: RegistroImpreseOutcome): string {
  const parts = [`stato: ${o.stato}`];
  if (o.dtCancellazione) parts.push(`dal ${o.dtCancellazione}`);
  if (o.causale) parts.push(`causale: ${o.causale}`);
  return `impresa cessata nel Registro Imprese (${parts.join(', ')})`;
}

/**
 * Aggregato = copia del tracciato caricato: tutte le righe, stesso ordine,
 * stesso separatore e stesse celle (righe originali riscritte tali e quali),
 * con in coda le colonne domicilio_digitale, app_io ed errori. Le righe
 * sono le stesse di parseCsvContent (righe vuote scartate, spazi ai bordi
 * tolti), quindi allineate per indice agli esiti.
 */
function buildAggregato(sourceCsv: string, hasHeaders: boolean, outcomes: RowOutcome[]): string {
  const eol = sourceCsv.includes('\r\n') ? '\r\n' : '\n';
  const lines = sourceCsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '﻿';
  const delimiter = detectDelimiter(lines[0]);
  const cell = (v: string) => (/["\r\n]/.test(v) || v.includes(delimiter) ? `"${v.replace(/"/g, '""')}"` : v);
  // Righe più corte dell'intestazione: completate con celle vuote, così le
  // colonne aggiunte restano allineate sotto la loro intestazione.
  const width = parseCsvLine(lines[0], delimiter).length;
  const pad = (line: string) => {
    const missing = width - parseCsvLine(line, delimiter).length;
    return missing > 0 ? line + delimiter.repeat(missing) : line;
  };

  const out: string[] = [];
  let dataLines = lines;
  if (hasHeaders) {
    out.push([lines[0], AGGREGATE_DOMICILIO_COLUMN, AGGREGATE_APPIO_COLUMN, AGGREGATE_ERRORI_COLUMN].join(delimiter));
    dataLines = lines.slice(1);
  }
  dataLines.forEach((line, i) => {
    const o = outcomes[i];
    out.push([pad(line), cell(o.domicilio), cell(o.appIo), cell(o.errori.join('; '))].join(delimiter));
  });
  return '﻿' + out.join(eol) + eol;
}
