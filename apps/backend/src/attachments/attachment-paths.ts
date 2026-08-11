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

// Stesso principio di isValidUploadId/UPLOAD_ID_PATTERN in
// chunked-upload.util.ts, applicato a `:id` (campagna): l'entity
// (Campaign.id, @PrimaryGeneratedColumn('uuid')) è sempre un UUID —
// qualunque altro valore è per definizione un tentativo di manipolare il
// path. Necessario perché `req.params['id']` raggiunge i callback
// `destination` di multer diskStorage (campaigns.controller.ts,
// :id/recipients/draft-csv e :id/attachments) PRIMA che `ParseUUIDPipe`
// sul parametro dell'handler venga eseguito — multer parsa il body
// multipart, callback inclusi, prima che le pipe Nest girino.
const CAMPAIGN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCampaignId(campaignId: unknown): campaignId is string {
  return typeof campaignId === 'string' && CAMPAIGN_ID_PATTERN.test(campaignId);
}

/**
 * Variante "safe" (mai throw) di getUploadsDir(), per i callback
 * `destination` di multer diskStorage — SEMPRE sincroni, chiamati DURANTE
 * il parsing multipart, quindi PRIMA di qualunque pipe/exception filter
 * Nest. Un `throw` grezzo lì dentro sfugge come `uncaughtException` e
 * abbatte l'intero processo Node (nessun handler globale in questo repo,
 * stesso principio già documentato per `safeChunkUploadDir()` in
 * chunked-upload.util.ts). Reagire a `null` con
 * `cb(new BadRequestException(...), '')`, mai un throw.
 */
export function safeGetUploadsDir(campaignId: unknown): string | null {
  if (!isValidCampaignId(campaignId)) return null;
  return getUploadsDir(campaignId);
}

/** Logo e favicon caricati dalla UI admin. */
export function getBrandingDir(): string {
  return join(getAttachmentsRoot(), 'branding');
}
