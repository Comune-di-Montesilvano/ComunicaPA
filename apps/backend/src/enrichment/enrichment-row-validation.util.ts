import { matchCountry, isValidCap, abbreviateLongMunicipality } from '@comunicapa/shared-types';
import { isValidCfOrPiva } from '../channels/tax-id.util.js';
import type { EnrichmentWarning } from '../entities/enrichment-job.entity.js';
import type { EnrichedRow } from './enriched-csv.util.js';

/**
 * Regole di validazione contenuto (Paese/Città/CAP/Provincia/CF) — le stesse
 * del wizard campagne, applicate incondizionatamente a ogni riga (anche PDF
 * mancante/estrazione fallita). Estratte in funzione pura riusabile sia da
 * `processEnrich` sia da `EnrichmentService.retryFailedPdfs`: quest'ultimo
 * deve ricalcolarle sulla riga ripatchata dopo il retry, non limitarsi a
 * rimuovere il warning "Estrazione fallita" — altrimenti un warning
 * indipendente sulla stessa riga (es. "Città mancante") sparirebbe
 * silenziosamente senza mai essere stato riverificato (bug reale trovato
 * prima del deploy: retryFailedPdfs scartava ogni warning della riga
 * riprovata, non solo quelli di estrazione).
 *
 * Muta `row.comune` (abbreviazione) e `row.codice_fiscale` (fallback dal
 * PDF) in place, come già faceva il codice originale in `processEnrich`.
 */
export function validateRowContentWarnings(
  row: EnrichedRow,
  rowNum: number,
  pdfFilename: string,
  extractedFiscalCode: string | null,
): EnrichmentWarning[] {
  const warnings: EnrichmentWarning[] = [];

  const paeseRaw = (row.stato_estero || '').trim();
  const matchedCountry = paeseRaw ? matchCountry(paeseRaw) : null;
  const isForeignRow = !!matchedCountry && matchedCountry !== 'Italia';
  if (paeseRaw && !matchedCountry) {
    warnings.push({ row: rowNum, pdf: pdfFilename, message: `Paese "${paeseRaw}" non riconosciuto` });
  }
  const comuneTrimmed = (row.comune || '').trim();
  if (!comuneTrimmed) {
    warnings.push({ row: rowNum, pdf: pdfFilename, message: 'Città mancante' });
  } else if (comuneTrimmed.length > 30) {
    const abbreviated = abbreviateLongMunicipality(comuneTrimmed);
    if (abbreviated.length <= 30) {
      // Uno dei 5 comuni italiani noti oltre soglia — nessun troncamento
      // cieco a metà parola, nessun warning: la forma abbreviata è valida.
      row.comune = abbreviated;
    } else {
      warnings.push({ row: rowNum, pdf: pdfFilename, message: `Città troppo lunga (${comuneTrimmed.length} caratteri, max 30)` });
      row.comune = comuneTrimmed.slice(0, 30);
    }
  }
  if (!isForeignRow && !(row.provincia || '').trim()) {
    warnings.push({ row: rowNum, pdf: pdfFilename, message: 'Provincia mancante' });
  }
  if (!isForeignRow && (row.cap || '').trim() && !isValidCap(row.cap || '')) {
    warnings.push({ row: rowNum, pdf: pdfFilename, message: 'CAP non valido (richieste 5 cifre)' });
  }

  const csvCf = (row.codice_fiscale || '').trim();
  if (!csvCf) {
    warnings.push({ row: rowNum, pdf: pdfFilename, message: 'Codice Fiscale/Partita IVA mancante' });
  } else if (!isValidCfOrPiva(csvCf)) {
    const pdfCf = extractedFiscalCode ? extractedFiscalCode.trim() : '';
    if (pdfCf && isValidCfOrPiva(pdfCf)) {
      row.codice_fiscale = pdfCf;
      warnings.push({
        row: rowNum,
        pdf: pdfFilename,
        message: `Codice Fiscale/Partita IVA CSV non valido ("${csvCf}") — sostituito con valore estratto dal PDF`,
      });
    } else {
      warnings.push({ row: rowNum, pdf: pdfFilename, message: `Codice Fiscale/Partita IVA non valido ("${csvCf}")` });
    }
  }

  return warnings;
}
