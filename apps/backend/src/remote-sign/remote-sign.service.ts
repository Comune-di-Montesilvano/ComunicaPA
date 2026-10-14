import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import { basename } from 'path';
import type { Queue } from 'bullmq';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto.js';
import type { AppConfiguration } from '../config/configuration.js';
import type { CampaignRequester } from '../campaigns/campaigns.service.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignError } from './arss-errors.js';
import { captureException } from '../common/sentry.util.js';
import { buildTestPdf } from './test-pdf.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';
import type { RemoteSignCredentialsDto } from './dto/remote-sign-credentials.dto.js';

export interface RemoteSignStatusDto {
  status: RemoteSignJobStatus;
  totalFiles: number;
  signedCount: number;
  failedCount: number;
  errorKind: string | null;
  errorMessage: string | null;
  signerCn: string | null;
}

function isSafePdfName(f: string): boolean {
  return basename(f) === f && !f.startsWith('.') && f.toLowerCase().endsWith('.pdf');
}

const ACTIVE = [RemoteSignJobStatus.QUEUED, RemoteSignJobStatus.PROCESSING];

@Injectable()
export class RemoteSignService {
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient) private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(RemoteSignJob) private readonly jobRepo: Repository<RemoteSignJob>,
    @InjectQueue(REMOTE_SIGN_QUEUE) private readonly queue: Queue<RemoteSignQueueJobData>,
    private readonly client: ArubaSignClient,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly verification: SignatureVerificationService,
    private readonly settings: AppSettingsService,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  decryptPassword(enc: string): string {
    return decryptValue(enc, this.cryptoKey);
  }

  isEnabled(): Promise<boolean> {
    return this.settings.get<boolean>('remoteSign.enabled');
  }

  /** Solo ownership (admin tutte, user le proprie): lo stato resta leggibile dopo il lancio. */
  async assertCanRead(campaignId: string, requester: CampaignRequester): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (requester.role !== 'admin' && campaign.createdBy !== requester.username) {
      throw new ForbiddenException('Non puoi vedere una campagna creata da un altro operatore');
    }
    return campaign;
  }

  /** SEND in bozza (massivo o Invio Manuale), ownership come assertOwnership di CampaignsService. */
  async assertCanModify(campaignId: string, requester: CampaignRequester): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (requester.role !== 'admin' && campaign.createdBy !== requester.username) {
      throw new ForbiddenException('Non puoi modificare una campagna creata da un altro operatore');
    }
    if (campaign.channelType !== 'SEND' || campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Firma allegati disponibile solo per campagne SEND in bozza');
    }
    return campaign;
  }

  hasActiveJob(campaignId: string): Promise<boolean> {
    return this.jobRepo.exists({ where: { campaignId, status: In(ACTIVE) } });
  }

  /**
   * Allegati da firmare = file dei destinatari PENDING con signatureCheck
   * invalido (ultima verifica), deduplicati, solo .pdf (PAdES: .p7m esclusi).
   * alreadyValid = file referenziati SOLO da destinatari validi.
   * Nomi dal CSV non fidati: tenuti solo nomi file semplici (no path, no
   * nascosti) — vengono poi letti da disco e spediti ad Aruba.
   */
  async listFilesToSign(campaignId: string): Promise<{ toSign: string[]; alreadyValid: string[] }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const slots = resolveAttachmentsConfig(campaign.channelConfig).length;
    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: { extraData: true, signatureCheck: true },
    });
    const toSign = new Set<string>();
    const valid = new Set<string>();
    for (const r of recipients) {
      for (let i = 0; i < slots; i++) {
        const f = resolveCustomAttachmentFilename({ campaign, extraData: r.extraData } as unknown as Recipient, i);
        if (!f) continue;
        if (r.signatureCheck?.valid === false) toSign.add(f);
        else valid.add(f);
      }
    }
    return {
      toSign: [...toSign].filter(isSafePdfName),
      alreadyValid: [...valid].filter((f) => !toSign.has(f) && isSafePdfName(f)),
    };
  }

  async start(
    campaignId: string,
    requester: CampaignRequester,
    dto: RemoteSignCredentialsDto,
  ): Promise<{ jobId: string } | { error: string; errorKind?: string }> {
    if (!(await this.isEnabled())) {
      return { error: 'Firma remota non attiva: abilitala da Impostazioni → Firma remota' };
    }
    await this.assertCanModify(campaignId, requester);
    if (await this.hasActiveJob(campaignId)) {
      return { error: 'Firma remota già in corso per questa campagna' };
    }
    const verification = await this.verificationBulk.getLatestStatus(campaignId);
    if (!verification || verification.status !== SignatureVerificationJobStatus.DONE) {
      return { error: 'Attendi la fine della verifica firma prima di firmare' };
    }
    const { toSign } = await this.listFilesToSign(campaignId);
    if (toSign.length === 0) {
      return { error: 'Nessun allegato PDF da firmare' };
    }

    const creds = { user: dto.user, password: dto.password };
    let sessionId: string;
    try {
      sessionId = await this.client.openSession(creds, dto.otp);
    } catch (err) {
      if (err instanceof RemoteSignError) return { error: err.message, errorKind: err.kind };
      throw err;
    }

    const job = await this.jobRepo.save(this.jobRepo.create({
      campaignId,
      status: RemoteSignJobStatus.QUEUED,
      totalFiles: toSign.length,
      operator: requester.username,
    }));
    try {
      await this.queue.add(
        'sign',
        { jobId: job.id, campaignId, sessionId, user: dto.user, passwordEnc: encryptValue(dto.password, this.cryptoKey) },
        { jobId: job.id, removeOnComplete: true, removeOnFail: true, attempts: 1 },
      );
    } catch (err) {
      // Riga già salvata ma job mai accodato: chiuderla, altrimenti resta
      // queued per sempre e blocca lancio e upload.
      captureException(err, { jobId: job.id, campaignId, stage: 'remoteSignEnqueue' });
      await this.jobRepo.update({ id: job.id }, {
        status: RemoteSignJobStatus.FAILED,
        errorMessage: 'Impossibile avviare la firma: riprova',
        completedAt: new Date(),
      });
      await this.client.closeSession(sessionId, creds);
      return { error: 'Impossibile avviare la firma: riprova' };
    }
    return { jobId: job.id };
  }

  async getLatestStatus(campaignId: string): Promise<RemoteSignStatusDto | null> {
    const job = await this.jobRepo.findOne({ where: { campaignId }, order: { createdAt: 'DESC' } });
    if (!job) return null;
    return {
      status: job.status,
      totalFiles: job.totalFiles,
      signedCount: job.signedCount,
      failedCount: job.failedCount,
      errorKind: job.errorKind,
      errorMessage: job.errorMessage,
      signerCn: job.signerCn,
    };
  }

  /** Prova firma da Impostazioni: nulla su disco, sessione sempre chiusa. */
  async testSign(dto: RemoteSignCredentialsDto): Promise<{ ok: true; signerCn: string | null } | { ok: false; error: string }> {
    const creds = { user: dto.user, password: dto.password };
    let sessionId: string | null = null;
    try {
      sessionId = await this.client.openSession(creds, dto.otp);
      const signed = await this.client.signPdf(sessionId, creds, buildTestPdf());
      const result = await this.verification.verify(signed, 'prova-firma.pdf');
      if (!result.valid) return { ok: false, error: `Firma creata ma non valida: ${result.reason}` };
      return { ok: true, signerCn: result.signerCn ?? null };
    } catch (err) {
      if (err instanceof RemoteSignError) return { ok: false, error: err.message };
      throw err;
    } finally {
      if (sessionId) await this.client.closeSession(sessionId, creds);
    }
  }
}
