import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';
import type { AttachmentConfigEntry } from '../attachments/attachment.service';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateExternalNotificationDto } from './dto/create-external-notification.dto';
import type { ExternalApiClient } from '../entities/external-api-client.entity';

export type CreateAndLaunchResult =
  | { success: true; campaignId: string; status: 'QUEUED' }
  | { success: false; error: { code: string; message: string } };

@Injectable()
export class ExternalApiService {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly tokens: ExternalAttachmentTokensService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async createAndLaunch(dto: CreateExternalNotificationDto, apiClient: ExternalApiClient): Promise<CreateAndLaunchResult> {
    const secondaryChannels = dto.secondaryAppIo
      ? [
          {
            channel: 'APP_IO' as const,
            mode: 'parallel' as const,
            subjectOverride: dto.secondaryAppIo.subjectOverride,
            bodyOverride: dto.secondaryAppIo.bodyOverride,
          },
        ]
      : undefined;

    const campaign = await this.campaignsService.create(
      {
        name: `[Esterno] ${apiClient.name} — ${new Date().toISOString()}`,
        channelType: dto.channelType,
        channelConfig: {
          wizSingleMode: true,
          subject: dto.subject,
          body: dto.body,
          protocolla: dto.protocolla ?? false,
          ...(secondaryChannels ? { secondaryChannels } : {}),
        },
      } as any,
      `external:${apiClient.name}`,
    );
    await this.campaignsService.setExternalClientId(campaign.id, apiClient.id);

    const extraData: Record<string, unknown> = { ...dto.extraData };

    if (dto.attachments && dto.attachments.length > 0) {
      const attachmentsConfig: AttachmentConfigEntry[] = [];
      const destDir = getUploadsDir(campaign.id);
      fs.mkdirSync(destDir, { recursive: true });

      for (let i = 0; i < dto.attachments.length; i++) {
        const ref = dto.attachments[i];
        const resolved = this.tokens.resolve(apiClient.id, ref.token);
        if (!resolved) {
          return {
            success: false,
            error: { code: 'LAUNCH_BLOCKED', message: `Allegato con token "${ref.token}" non trovato o già scaduto` },
          };
        }
        const key = `allegato_${i}`;
        const destFilename = `${i}_${resolved.filename}`;
        fs.copyFileSync(resolved.path, join(destDir, destFilename));
        this.tokens.markConsumed(apiClient.id, ref.token);
        attachmentsConfig.push({ key, label: ref.label ?? `Allegato ${i + 1}` });
        extraData[key] = destFilename;
      }

      // Full-replace semantics di updateDraft (nessun merge lato service): va
      // sempre spread di campaign.channelConfig prima di aggiungere
      // `attachments`, altrimenti si perdono wizSingleMode/subject/body/
      // protocolla/secondaryChannels appena impostati da create().
      await this.campaignsService.updateDraft(campaign.id, {
        channelConfig: { ...campaign.channelConfig, attachments: attachmentsConfig },
      } as any);
    }

    await this.campaignsService.addSingleRecipient(campaign.id, {
      codiceFiscale: dto.codiceFiscale,
      email: dto.email ?? null,
      pec: dto.pec ?? null,
      extraData,
    });

    const launchResult = await this.campaignsService.launch(campaign.id);
    if (launchResult.blocked) {
      return { success: false, error: { code: 'LAUNCH_BLOCKED', message: launchResult.message ?? 'Lancio bloccato' } };
    }

    await this.auditLogsService.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: `external:${apiClient.name}`,
      action: 'EXTERNAL_API_CREATE',
      details: { channelType: dto.channelType },
    });

    return { success: true, campaignId: campaign.id, status: 'QUEUED' };
  }
}
