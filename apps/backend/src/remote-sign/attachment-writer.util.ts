import * as fs from 'fs';
import { basename, join } from 'path';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

/**
 * Sostituisce un allegato della campagna con `content` (versione firmata):
 * backup dell'originale alla prima sostituzione, poi scrittura atomica
 * (tmp + rename) — un crash a metà non lascia mai un PDF troncato.
 */
export function replaceAttachment(campaignId: string, filename: string, content: Buffer): void {
  if (!filename || basename(filename) !== filename || filename.startsWith('.')) {
    throw new Error('Nome allegato non valido');
  }
  const target = join(getUploadsDir(campaignId), filename);
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
