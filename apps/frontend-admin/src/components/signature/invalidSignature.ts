import type { SignatureInvalidFile } from './types';

/**
 * I contatori della verifica firma sono per destinatario (riga), non per
 * allegato: SEND notifica tutti gli allegati della riga come documenti
 * dell'atto, basta uno non valido per marcare la riga.
 */
export function invalidRecipientsText(invalidCount: number, totalRows: number): string {
  return invalidCount === 1
    ? `1 destinatario su ${totalRows} ha almeno un allegato non firmato validamente`
    : `${invalidCount} destinatari su ${totalRows} hanno almeno un allegato non firmato validamente`;
}

export function invalidFileLabel(f: SignatureInvalidFile, totalRows: number): string {
  const name = f.filename ?? 'Allegato';
  const who = totalRows > 1 ? ` (${f.recipients === 1 ? '1 destinatario' : `${f.recipients} destinatari`})` : '';
  return `${name}: ${f.reason}${who}`;
}

/** Elenco testuale per alert/confirm nativi. */
export function invalidFilesPlainText(files: SignatureInvalidFile[] | undefined, total: number | undefined, totalRows: number): string {
  if (!files || files.length === 0) return '';
  const more = (total ?? files.length) - files.length;
  return files.map((f) => `- ${invalidFileLabel(f, totalRows)}`).join('\n') + (more > 0 ? `\n- … e altri ${more}` : '');
}
