import { parseCsvContent, buildCsvContent } from '../../io-services/csv.util.js';

export interface DomicileVerificationCsvInput {
  sourceCsv: string;
  hasHeaders: boolean;
  cfColumn: string;
  inadFoundMap: Record<string, string>;
  appIoResults: Record<string, boolean>;
  registroImpreseResults: Record<string, string | null>;
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

/**
 * CF fisico = 16 caratteri (nessuna Partita IVA ha questa lunghezza, il
 * formato 11-cifre di isPartitaIva è per costruzione mutuamente esclusivo —
 * nessun controllo aggiuntivo necessario, stesso criterio già in uso in
 * InadVerifyBulkService.createJob).
 */
function isCfFisico(cf: string): boolean {
  return cf.length === 16;
}

export function buildDomicileVerificationCsvs(input: DomicileVerificationCsvInput): DomicileVerificationCsvResult {
  const parsed = parseCsvContent(input.sourceCsv, input.hasHeaders);

  const assentiRows: Record<string, string>[] = [];
  const appIoRows: Record<string, string>[] = [];
  const inadRows: Record<string, string>[] = [];
  const registroImpreseRows: Record<string, string>[] = [];
  const aggregatoRows: Record<string, string>[] = [];

  for (const row of parsed.rows) {
    const cf = (row[input.cfColumn] || '').trim().toUpperCase();
    const cfFisico = isCfFisico(cf);

    const inadAddress = cfFisico ? input.inadFoundMap[cf] : undefined;
    const appIoActive = cfFisico ? input.appIoResults[cf] : undefined;
    const registroPec = input.registroImpreseResults[cf] || undefined;

    const domicilioDigitale = registroPec || inadAddress || '';
    const appIoValue = cfFisico ? (appIoActive ? 'attivo' : 'non attivo') : 'n.d.';

    aggregatoRows.push({ ...row, [AGGREGATE_DOMICILIO_COLUMN]: domicilioDigitale, [AGGREGATE_APPIO_COLUMN]: appIoValue });

    if (inadAddress) inadRows.push({ ...row, [ADDRESS_COLUMN]: inadAddress });
    if (appIoActive) appIoRows.push({ ...row });
    if (registroPec) registroImpreseRows.push({ ...row, [PEC_COLUMN]: registroPec });

    const isAssente = cfFisico ? (!inadAddress && !appIoActive && !registroPec) : !registroPec;
    if (isAssente) assentiRows.push({ ...row });
  }

  return {
    assentiCsv: buildCsvContent(parsed.headers, assentiRows),
    appIoCsv: appIoRows.length > 0 ? buildCsvContent(parsed.headers, appIoRows) : null,
    inadCsv: inadRows.length > 0 ? buildCsvContent([...parsed.headers, ADDRESS_COLUMN], inadRows) : null,
    registroImpreseCsv: registroImpreseRows.length > 0 ? buildCsvContent([...parsed.headers, PEC_COLUMN], registroImpreseRows) : null,
    aggregatoCsv: buildCsvContent([...parsed.headers, AGGREGATE_DOMICILIO_COLUMN, AGGREGATE_APPIO_COLUMN], aggregatoRows),
  };
}
