import * as fs from 'fs';
import { basename, join, resolve, sep } from 'path';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

/**
 * Path dell'allegato `filename` dentro uploads della campagna, oppure null se
 * il nome non è un file semplice (traversal, sottocartelle, nascosti) o se il
 * path risolto esce da uploads. I nomi arrivano dal CSV (extraData): mai
 * leggere/scrivere su disco senza passare di qui.
 */
export function safeAttachmentPath(campaignId: string, filename: string): string | null {
  if (!filename || basename(filename) !== filename || filename.startsWith('.')) return null;
  const dir = getUploadsDir(campaignId);
  const path = join(dir, filename);
  return resolve(path).startsWith(resolve(dir) + sep) ? path : null;
}

/**
 * Sostituisce un allegato della campagna con `content` (versione firmata):
 * backup dell'originale alla prima sostituzione, poi scrittura atomica
 * (tmp + rename) — un crash a metà non lascia mai un PDF troncato.
 */
export function replaceAttachment(campaignId: string, filename: string, content: Buffer): void {
  const target = safeAttachmentPath(campaignId, filename);
  if (!target) throw new Error('Nome allegato non valido');
  const backupDir = getUnsignedBackupDir(campaignId);
  const backup = join(backupDir, filename);
  if (fs.existsSync(target) && !fs.existsSync(backup)) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(target, backup);
  }
  const tmp = join(getUploadsDir(campaignId), `.${filename}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
