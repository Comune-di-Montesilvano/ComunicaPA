import { join } from 'path';

/**
 * Radice unica dello storage allegati (volume dedicato in prod).
 * Letta a ogni chiamata così i test possono variare l'env.
 */
export function getAttachmentsRoot(): string {
  return process.env['ATTACHMENTS_PATH'] ?? '/data/attachments';
}

/** PDF caricati dall'operatore per una campagna. */
export function getUploadsDir(campaignId: string): string {
  return join(getAttachmentsRoot(), 'uploads', campaignId);
}

/** Logo e favicon caricati dalla UI admin. */
export function getBrandingDir(): string {
  return join(getAttachmentsRoot(), 'branding');
}
