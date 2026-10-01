import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import type { AttachmentConfigEntry } from '../attachments/attachment.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import type { ExternalApiClient } from '../entities/external-api-client.entity.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalIdempotencyStore, hashRequest } from './external-idempotency.store.js';
import { mapNotification } from './external-notification.mapper.js';
import { validateCreateNotification, type CreateNotificationDto } from './dto/create-notification.dto.js';
import { ExternalApiError } from './external-api.error.js';

export const EXTERNAL_UPLOADS_DIR = Symbol('EXTERNAL_UPLOADS_DIR');
const REQUESTER = { username: 'external-api', role: 'admin' as const };

export interface CreateNotificationResult {
  success: true;
  notificationId: string;
  status: 'accepted';
}

@Injectable()
export class ExternalNotificationsService {
  constructor(
    private readonly capabilities: ExternalCapabilitiesService,
    private readonly idempotency: ExternalIdempotencyStore,
    private readonly campaigns: CampaignsService,
    private readonly tokens: ExternalAttachmentTokensService,
    private readonly audit: AuditLogsService,
    @Optional() @Inject(EXTERNAL_UPLOADS_DIR) private readonly uploadsDir: (campaignId: string) => string = getUploadsDir,
  ) {}

  async create(body: unknown, client: ExternalApiClient, idempotencyKey: string | undefined): Promise<CreateNotificationResult> {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', [
        { field: 'Idempotency-Key', message: 'header Idempotency-Key obbligatorio (1-255 caratteri)' },
      ]);
    }

    const { value: dto, issues } = await validateCreateNotification(body);
    if (issues.length) throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', issues);

    const caps = await this.capabilities.getCapabilities();
    const dyn = this.capabilities.validate(dto, caps);
    if (dyn.inactiveChannel) throw new ExternalApiError('CHANNEL_INACTIVE', `Canale ${dto.channel} non configurato su questa istanza`);
    if (dyn.issues.length) throw new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', dyn.issues);

    const requestHash = hashRequest(body);
    const begin = await this.idempotency.begin(client.id, idempotencyKey, requestHash);
    if (begin.kind === 'replay') return begin.response as CreateNotificationResult;
    if (begin.kind === 'conflict') throw new ExternalApiError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key già usata con un payload diverso');
    if (begin.kind === 'in_progress') throw new ExternalApiError('IDEMPOTENCY_IN_PROGRESS', 'Richiesta con la stessa Idempotency-Key ancora in elaborazione');

    try {
      const result = await this.createAndLaunch(dto, client, this.capabilities.resolveDefaults(dto, caps));
      await this.idempotency.complete(client.id, idempotencyKey, requestHash, result);
      return result;
    } catch (err) {
      await this.idempotency.release(client.id, idempotencyKey);
      throw err;
    }
  }

  private async createAndLaunch(
    dto: CreateNotificationDto,
    client: ExternalApiClient,
    defaults: { physicalCommunicationType?: string; postalServiceType?: string },
  ): Promise<CreateNotificationResult> {
    const mapped = mapNotification(dto, defaults);
    const campaign = await this.campaigns.create(
      {
        name: `[API] ${client.name} — ${dto.externalReference ?? new Date().toISOString()}`,
        channelType: dto.channel,
        channelConfig: mapped.channelConfig,
      },
      `external:${client.name}`,
    );
    await this.campaigns.setExternalClientId(campaign.id, client.id);

    const extraData: Record<string, unknown> = { ...mapped.recipient.extraData };
    if (dto.attachments?.length) {
      // Risolti tutti prima di copiare/consumare: un token invalido non deve lasciare token già consumati.
      const resolved = dto.attachments.map((ref) => ({ ref, file: this.tokens.resolve(client.id, ref.token) }));
      const missing = resolved.find((r) => !r.file);
      if (missing) {
        await this.campaigns.remove(campaign.id, REQUESTER).catch(() => undefined);
        throw new ExternalApiError('ATTACHMENT_INVALID', `Allegato con token "${missing.ref.token}" non trovato, già usato o scaduto`);
      }
      const destDir = this.uploadsDir(campaign.id);
      fs.mkdirSync(destDir, { recursive: true });
      const attachmentsConfig: AttachmentConfigEntry[] = [];
      resolved.forEach(({ ref, file }, i) => {
        const destFilename = `${i}_${file!.filename}`;
        fs.copyFileSync(file!.path, join(destDir, destFilename));
        this.tokens.markConsumed(client.id, ref.token);
        attachmentsConfig.push({ key: `allegato_${i}`, label: ref.label ?? `Allegato ${i + 1}` });
        extraData[`allegato_${i}`] = destFilename;
      });
      // updateDraft sostituisce channelConfig per intero: spread obbligatorio.
      await this.campaigns.updateDraft(campaign.id, { channelConfig: { ...campaign.channelConfig, attachments: attachmentsConfig } } as any);
    }

    const recipient = await this.campaigns.addSingleRecipient(campaign.id, { ...mapped.recipient, extraData });

    // Requester sintetico admin: il confine di sicurezza è ApiKeyGuard (come v1).
    const launch = await this.campaigns.launch(campaign.id, REQUESTER);
    if (launch.blocked) throw new ExternalApiError('LAUNCH_BLOCKED', launch.message ?? 'Lancio bloccato');

    await this.audit.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: `external:${client.name}`,
      action: 'EXTERNAL_API_CREATE',
      details: { channel: dto.channel, externalReference: dto.externalReference ?? null, taxId: `***${mapped.recipient.codiceFiscale.slice(-4)}` },
    });

    return { success: true, notificationId: recipient.id, status: 'accepted' };
  }
}
