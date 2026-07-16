import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import type { Recipient } from '../entities/recipient.entity';
import { getUploadsDir } from './attachment-paths';

/**
 * Risolve la lista di allegati configurati per una campagna. `attachments`
 * (nuovo formato) ha priorità; se assente si ricostruisce un singolo
 * allegato dal vecchio `allegatoKey` per retrocompatibilità con campagne
 * create prima del supporto multi-allegato.
 */
export interface AttachmentConfigEntry {
  key: string;
  label: string;
  /** Se impostata, l'etichetta effettiva (vedi `resolveAttachmentLabel`) è letta
   * riga per riga da questa colonna del CSV invece del testo fisso `label`. */
  labelColumn?: string;
}

export function resolveAttachmentsConfig(
  channelConfig: Record<string, unknown> | undefined,
): AttachmentConfigEntry[] {
  const configured = channelConfig?.['attachments'] as AttachmentConfigEntry[] | undefined;
  if (configured && configured.length > 0) return configured;

  const legacyKey = channelConfig?.['allegatoKey'] as string | undefined;
  if (legacyKey) return [{ key: legacyKey, label: 'Allegato 1' }];

  return [];
}

/**
 * Risolve l'etichetta effettiva di un allegato per un destinatario: se
 * `labelColumn` è impostata legge il valore da `recipient.extraData` (varia
 * riga per riga), altrimenti usa il testo fisso `label` — con fallback a
 * `label` anche quando la colonna è vuota per quella riga, per non produrre
 * un link "Scarica" senza etichetta.
 */
export function resolveAttachmentLabel(entry: AttachmentConfigEntry, recipient: Pick<Recipient, 'extraData'>): string {
  if (entry.labelColumn) {
    const value = recipient.extraData?.[entry.labelColumn];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return entry.label;
}

/**
 * Risolve il nome del file dell'allegato PDF personalizzato per un destinatario,
 * per l'allegato all'indice `index` (0-based) fra quelli configurati sulla campagna.
 *
 * Fallback legacy: se non c'è ALCUNA configurazione allegati (né `attachments`
 * né `allegatoKey`) e `index` è 0, scansiona `extraData` e usa il primo valore
 * che termina con `.pdf` (comportamento pre-esistente per campagne molto vecchie).
 *
 * Usata sia da `AttachmentService` (per servire il download) sia da
 * `RetentionCleanupService` (per individuare i file da eliminare alla scadenza),
 * in modo che entrambi concordino su quali destinatari hanno un allegato personalizzato.
 */
export function resolveCustomAttachmentFilename(recipient: Recipient, index = 0): string | undefined {
  const attachments = resolveAttachmentsConfig(recipient.campaign?.channelConfig);
  const entry = attachments[index];

  if (entry && recipient.extraData?.[entry.key]) {
    return String(recipient.extraData[entry.key]);
  }

  if (index === 0 && attachments.length === 0) {
    for (const val of Object.values(recipient.extraData ?? {})) {
      if (typeof val === 'string' && val.toLowerCase().endsWith('.pdf')) {
        return val;
      }
    }
  }

  return undefined;
}

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  /**
   * Nessun fallback: se non risulta un file custom risolvibile su disco,
   * errore esplicito invece di un PDF segnaposto generico — un allegato
   * mancante è una configurazione rotta (mapping CSV/colonna sbagliata,
   * upload non completato), non un caso da coprire silenziosamente.
   */
  async generatePdfBuffer(recipient: Recipient, index = 0): Promise<Buffer> {
    const customFilename = resolveCustomAttachmentFilename(recipient, index);
    if (!customFilename) {
      throw new NotFoundException(`Nessun allegato configurato all'indice ${index} per il destinatario ${recipient.id}`);
    }

    const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`File allegato "${customFilename}" non trovato per il destinatario ${recipient.id}`);
    }

    this.logger.log(`Serving custom uploaded PDF attachment: ${filePath}`);
    return fs.readFileSync(filePath);
  }
}
