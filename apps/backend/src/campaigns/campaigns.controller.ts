import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { Campaign } from '../entities/campaign.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CampaignContentCorrectionService } from './campaign-content-correction.service';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service';
import type { ChannelOutcome } from './channel-outcome.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PreviewMessageDto } from './dto/preview-message.dto';
import { TestSendDto } from './dto/test-send.dto';
import { UpdateRecipientAddressDto } from './dto/update-recipient-address.dto';
import { AttachPostalTrackingIdDto } from './dto/attach-postal-tracking-id.dto';
import { UpdateCampaignContentDto } from './dto/update-campaign-content.dto';
import { getUploadsDir } from '../attachments/attachment-paths';
import { buildNeverDownloadedCsv } from './never-downloaded-csv.util';
import { buildDownloadReportCsv } from './download-report-csv.util';
import { buildSendReportAttualeCsv, buildSendReportStoricoCsv } from './send-report-csv.util';
import { buildPostalReportAttualeCsv, buildPostalReportStoricoCsv } from './postal-report-csv.util';
import {
  assembleChunkedUpload,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
  MAX_CHUNK_SIZE_BYTES,
} from './chunked-upload.util';

type CampaignWithOwnerDisplay = Campaign & { createdByDisplayName?: string; attachmentExpiresAt?: string | null };

@Controller('admin/campaigns')
@Roles('user', 'admin')
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly auditLogsService: AuditLogsService,
    private readonly operatorDirectory: OperatorDirectoryService,
    private readonly contentCorrectionService: CampaignContentCorrectionService,
    private readonly bulkRetryService: CampaignBulkRetryService,
  ) {}

  @Get()
  async findAll(): Promise<CampaignWithOwnerDisplay[]> {
    const campaigns = await this.campaignsService.findAll();
    const displayNames = await this.operatorDirectory.resolveMany(campaigns.map((c) => c.createdBy));
    return campaigns.map((c) => ({ ...c, createdByDisplayName: displayNames[c.createdBy] }));
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CampaignWithOwnerDisplay> {
    const campaign = await this.campaignsService.findOne(id);
    const displayNames = await this.operatorDirectory.resolveMany([campaign.createdBy]);
    const { earliestExpiryAt } = await this.campaignsService.getAttachmentRetentionInfo(id);
    return { ...campaign, createdByDisplayName: displayNames[campaign.createdBy], attachmentExpiresAt: earliestExpiryAt };
  }

  @Post()
  async create(
    @Body() dto: CreateCampaignDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<Campaign> {
    const campaign = await this.campaignsService.create(dto, req.user.username);
    await this.auditLogsService.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: req.user.username,
      action: 'CREATE',
      details: { name: campaign.name, channelType: campaign.channelType },
    });
    return campaign;
  }
  @Patch(':id')
  async updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const campaign = await this.campaignsService.updateDraft(id, dto);
    await this.auditLogsService.log({
      campaignId: campaign.id,
      campaignName: campaign.name,
      operator: req.user.username,
      action: 'UPDATE_DRAFT',
      details: { name: campaign.name, channelType: campaign.channelType },
    });
    return campaign;
  }
  @Patch(':id/content')
  @Roles('admin')
  async updateCampaignContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignContentDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const campaign = await this.campaignsService.updateCampaignContent(id, dto, req.user.username);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign.name,
      operator: req.user.username,
      action: 'CONTENT_CORRECTION',
      details: { subjectChanged: dto.subject !== undefined, bodyChanged: dto.body !== undefined },
    });
    return campaign;
  }

  @Post(':id/resend-content')
  @Roles('admin')
  resendContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('recipientIds') recipientIds: string[],
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<any> {
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      throw new BadRequestException('recipientIds deve essere un array non vuoto');
    }
    return this.contentCorrectionService.resendSafeBulk(id, recipientIds).then(async (results) => {
      const campaign = await this.campaignsService.findOne(id).catch(() => null);
      await this.auditLogsService.log({
        campaignId: id,
        campaignName: campaign ? campaign.name : null,
        operator: req.user.username,
        action: 'RESEND_CONTENT',
        details: { count: recipientIds.length },
      });
      return results;
    });
  }

  @Post('preview')
  previewMessage(@Body() dto: PreviewMessageDto) {
    return this.campaignsService.previewMessage(dto);
  }

  @Post(':id/recipients/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: '/tmp/comunicapa-uploads',
        filename: (_req, file, cb) => {
          cb(null, `${Date.now()}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
        cb(null, ok);
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ imported: number; campaignId: string; blocked?: boolean; message?: string }> {
    if (!file) {
      throw new BadRequestException('File CSV richiesto (Content-Type: text/csv)');
    }
    const result = await this.campaignsService.uploadCsv(id, file.path);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'UPLOAD_RECIPIENTS',
      details: { imported: result.imported, filename: file.originalname },
    });
    return result;
  }

  @Post(':id/recipients/draft-csv')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = getUploadsDir(req.params['id'] as string);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, _file, cb) => {
          cb(null, 'draft_recipients.csv');
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
        cb(null, ok);
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadDraftCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File CSV richiesto');
    }
    await this.campaignsService.assertDraftForAttachments(id);
    return { ok: true };
  }

  @Get(':id/recipients/draft-csv')
  async getDraftCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const filePath = join(getUploadsDir(id), 'draft_recipients.csv');
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Nessun file CSV salvato per questa bozza' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.sendFile(filePath);
  }

  // ── Upload CSV destinatari a chunk ──────────────────────────────────────
  // Un reverse proxy esterno davanti al backend in produzione ha un limite di
  // dimensione del body che spezza l'upload in un'unica richiesta per CSV di
  // migliaia di destinatari. Il browser spezza il file in chunk più piccoli,
  // caricati uno alla volta e riassemblati qui prima di riusare uploadCsv.

  @Post(':id/recipients/upload/init')
  initRecipientsChunkedUpload(
    @Body() body: { filename?: string; totalChunks?: number },
  ): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post(':id/recipients/upload/chunk/:uploadId/:index')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = chunkUploadDir(req.params['uploadId'] as string);
          if (!fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          cb(null, `${req.params['index']}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadRecipientsChunk(): { ok: true } {
    return { ok: true };
  }

  @Post(':id/recipients/upload/complete/:uploadId')
  async completeRecipientsChunkedUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ imported: number; campaignId: string; blocked?: boolean; message?: string }> {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const result = await this.campaignsService.uploadCsv(id, path);
      const campaign = await this.campaignsService.findOne(id).catch(() => null);
      await this.auditLogsService.log({
        campaignId: id,
        campaignName: campaign ? campaign.name : null,
        operator: req.user.username,
        action: 'UPLOAD_RECIPIENTS',
        details: { imported: result.imported, filename: 'chunked_upload.csv' },
      });
      return result;
    } catch (err: any) {
      return { imported: 0, campaignId: id, blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio dei chunk' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FilesInterceptor('files', 1000, {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = getUploadsDir(req.params['id'] as string);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          cb(null, file.originalname);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase();
        const ok =
          file.mimetype === 'application/pdf' || name.endsWith('.pdf') ||
          file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || name.endsWith('.zip');
        cb(null, ok);
      },
    }),
  )
  async uploadAttachments(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    // FilesInterceptor + diskStorage scrivono i file su disco PRIMA che questo handler venga
    // eseguito. Se la campagna non è in DRAFT il file (potenzialmente sovrascritto) è già a
    // terra: eliminiamo gli upload appena scritti prima di rilanciare, così una richiesta
    // rifiutata non lascia file orfani/mutati (garanzia di immutabilità post-launch).
    try {
      await this.campaignsService.assertDraftForAttachments(id);
    } catch (err) {
      await Promise.all(
        (files ?? []).map((file) => fs.promises.unlink(file.path).catch(() => undefined)),
      );
      throw err;
    }
    const result = await this.campaignsService.finalizeAttachments(id, files ?? []);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'UPLOAD_ATTACHMENTS',
      details: { uploaded: result.uploaded, discarded: result.discarded, fileCount: (files ?? []).length },
    });
    return {
      uploaded: result.uploaded,
      discarded: result.discarded,
      attachmentsExpected: result.attachmentsExpected,
      attachmentsPresent: result.attachmentsPresent,
      filenames: result.filenames,
      campaignId: id,
    };
  }

  // ── Upload allegati (ZIP/PDF) a chunk ───────────────────────────────────
  // Stesso motivo dei chunk per il CSV destinatari: uno ZIP con migliaia di
  // PDF personalizzati supera facilmente il limite del reverse proxy esterno
  // in un'unica richiesta.

  @Post(':id/attachments/upload/init')
  initAttachmentsChunkedUpload(
    @Body() body: { filename?: string; totalChunks?: number },
  ): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post(':id/attachments/upload/chunk/:uploadId/:index')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = chunkUploadDir(req.params['uploadId'] as string);
          if (!fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          cb(null, `${req.params['index']}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadAttachmentsChunk(): { ok: true } {
    return { ok: true };
  }

  @Post(':id/attachments/upload/complete/:uploadId')
  async completeAttachmentsChunkedUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ uploaded: number; discarded: number; attachmentsExpected: number; attachmentsPresent: number; filenames: string[]; campaignId: string; blocked?: boolean; message?: string }> {
    try {
      await this.campaignsService.assertDraftForAttachments(id);
      const { path, filename } = await assembleChunkedUpload(uploadId);

      let result: { uploaded: number; discarded: number; attachmentsExpected: number; attachmentsPresent: number; filenames: string[] };
      if (filename.toLowerCase().endsWith('.zip')) {
        const fakeFile = { path, originalname: filename } as Express.Multer.File;
        result = await this.campaignsService.finalizeAttachments(id, [fakeFile]);
      } else {
        const dir = getUploadsDir(id);
        fs.mkdirSync(dir, { recursive: true });
        try {
          fs.renameSync(path, join(dir, filename));
        } catch (renameErr: any) {
          if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(path, join(dir, filename));
            fs.unlinkSync(path);
          } else {
            throw renameErr;
          }
        }
        result = await this.campaignsService.finalizeAttachments(id, []);
      }
      const campaign = await this.campaignsService.findOne(id).catch(() => null);
      await this.auditLogsService.log({
        campaignId: id,
        campaignName: campaign ? campaign.name : null,
        operator: req.user.username,
        action: 'UPLOAD_ATTACHMENTS',
        details: { uploaded: result.uploaded, discarded: result.discarded, filename },
      });
      return {
        uploaded: result.uploaded,
        discarded: result.discarded,
        attachmentsExpected: result.attachmentsExpected,
        attachmentsPresent: result.attachmentsPresent,
        filenames: result.filenames,
        campaignId: id,
      };
    } catch (err: any) {
      return {
        uploaded: 0,
        discarded: 0,
        attachmentsExpected: 0,
        attachmentsPresent: 0,
        filenames: [],
        campaignId: id,
        blocked: true,
        message: err?.message ?? 'Errore durante la finalizzazione degli allegati',
      };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Post(':id/launch')
  async launch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ launched: number; campaignId: string }> {
    const result = await this.campaignsService.launch(id);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'LAUNCH',
      details: { launched: result.launched },
    });
    return result;
  }

  @Post(':id/test-send')
  async testSend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestSendDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }> {
    const result = await this.campaignsService.launchTestSend(id, dto);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'TEST_SEND',
      details: { testCampaignId: result.testCampaignId, codiceFiscale: dto.codiceFiscale },
    });
    return result;
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ cancelled: number; campaignId: string }> {
    const result = await this.campaignsService.cancel(id, { username: req.user.username, role: req.user.role });
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'CANCEL',
      details: { cancelled: result.cancelled },
    });
    return result;
  }

  @Get(':id/inad-check/status')
  async getInadCheckStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getInadCheckStatus(id);
  }

  @Post(':id/inad-check/retry')
  async retryInadCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ ok: true }> {
    await this.campaignsService.finalizeInadCheck(id);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: (await this.campaignsService.findOne(id).catch(() => null))?.name ?? null,
      operator: req.user.username,
      action: 'INAD_CHECK_RETRY',
      details: {},
    });
    return { ok: true };
  }

  @Post(':id/inad-check/skip')
  async skipInadCheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ launched: number; campaignId: string }> {
    const result = await this.campaignsService.skipInadCheck(id);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: (await this.campaignsService.findOne(id).catch(() => null))?.name ?? null,
      operator: req.user.username,
      action: 'INAD_CHECK_SKIP',
      details: { launched: result.launched },
    });
    return result;
  }

  @Get(':id/duplicate-source')
  getDuplicateSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getDuplicateSource(id);
  }

  @Get(':id/stats')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getStats(id);
  }

  @Get(':id/attachments/progress')
  async getAttachmentsProgress(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getAttachmentsProgress(id);
  }

  @Get(':id/attachments/preview-file')
  async previewAttachmentFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const { path, contentType } = await this.campaignsService.resolveAttachmentPreviewFilePath(id, filename);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(path);
  }

  @Get(':id/channel-stats')
  getChannelBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getChannelBreakdown(id).then((breakdown) => ({ campaignId: id, breakdown }));
  }

  @Get(':id/recipients-by-channel-outcome')
  getRecipientIdsByChannelOutcome(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('outcome') outcome: string,
  ) {
    const valid: ChannelOutcome[] = ['primaryOnly', 'both', 'appIoOnly', 'appIoDespitePrimaryFail', 'neither'];
    if (!valid.includes(outcome as ChannelOutcome)) {
      throw new BadRequestException(`outcome deve essere uno tra: ${valid.join(', ')}`);
    }
    return this.campaignsService
      .getRecipientIdsByChannelOutcome(id, outcome as ChannelOutcome)
      .then((recipientIds) => ({ recipientIds }));
  }

  @Get(':id/effective-channel-stats')
  getEffectiveChannelBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getEffectiveChannelBreakdown(id).then((breakdown) => ({ campaignId: id, breakdown }));
  }

  @Get(':id/download-combination-stats')
  async getDownloadCombinationStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getDownloadCombinationStats(id);
  }

  @Get(':id/send-stage-counts')
  getSendStageCounts(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getSendStageCounts(id);
  }

  @Get('stats/global')
  getGlobalStats(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.campaignsService.getGlobalStats(dateFrom, dateTo);
  }

  @Get('stats/global/never-downloaded.csv')
  async exportNeverDownloadedCsv(
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.campaignsService.getNeverDownloadedRecipients(dateFrom, dateTo);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mai_scaricato.csv"');
    res.send(buildNeverDownloadedCsv(rows));
  }

  @Get(':id/failures')
  getFailures(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailures(id);
  }

  @Get(':id/failures/by-reason')
  getFailuresByReason(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailuresByReason(id);
  }

  @Post(':id/recipients/:recipientId/retry')
  async retryRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.retryRecipient(id, recipientId);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { recipientId },
    });
    return result;
  }

  @Patch(':id/recipients/:recipientId/address')
  async updateRecipientAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Body() dto: UpdateRecipientAddressDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.updateRecipientAddressAndRetry(id, recipientId, dto);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { recipientId, addressCorrected: true },
    });
    return result;
  }

  @Post(':id/recipients/:recipientId/postal/refresh-status')
  async refreshPostalStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.refreshPostalStatus(id, recipientId);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { recipientId, postalStatusRefresh: true, newStatus: result.postalStatus },
    });
    return result;
  }

  @Patch(':id/recipients/:recipientId/postal/attempts/:attemptNumber/tracking-id')
  async attachPostalTrackingId(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Param('attemptNumber') attemptNumber: string,
    @Body() dto: AttachPostalTrackingIdDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.attachPostalTrackingId(id, recipientId, Number(attemptNumber), dto.idPro);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { recipientId, attemptNumber: Number(attemptNumber), postalTrackingIdAttached: dto.idPro },
    });
    return result;
  }

  @Post(':id/postal/reset-errors-for-recheck')
  async resetPostalErrorsForRecheck(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.resetPostalErrorsForRecheck(id);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { postalErrorsResetForRecheck: true, resetCount: result.resetCount },
    });
    return result;
  }

  // Async, e l'elenco recipientId non arriva mai dal browser: il body porta
  // solo l'errorMessage del gruppo, l'elenco è risolto server-side da
  // CampaignBulkRetryService (getFailedRecipientIdsByReason) — niente più
  // array di migliaia di UUID nella richiesta (bug reale:
  // "PayloadTooLargeError" sopra il limite 100kb del body-parser Express su
  // un batch TARI da 20100 destinatari, ben sotto il limite ~1MB del proxy
  // esterno — indipendente da quel limite, non lo si aggira alzandolo).
  @Post(':id/recipients/retry-bulk')
  async retryRecipientsBulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('errorMessage') errorMessage: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ jobId: string; totalCount: number }> {
    if (!errorMessage || typeof errorMessage !== 'string') {
      throw new BadRequestException('errorMessage deve essere una stringa non vuota');
    }
    const result = await this.bulkRetryService.createJob(id, errorMessage, req.user.username);
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : null,
      operator: req.user.username,
      action: 'RETRY',
      details: { count: result.totalCount, errorMessage, jobId: result.jobId },
    });
    return result;
  }

  @Get(':id/recipients/retry-bulk/:jobId')
  getRetryBulkStatus(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.bulkRetryService.getStatus(jobId);
  }

  @Get(':id/stats/recipients')
  getRecipientStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('deliveryStatus') deliveryStatus?: string,
  ) {
    const parsedPage = parseInt(page ?? '1', 10);
    const parsedPageSize = parseInt(pageSize ?? '50', 10);

    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('Il parametro page deve essere un numero intero maggiore o uguale a 1');
    }
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1) {
      throw new BadRequestException('Il parametro pageSize deve essere un numero intero maggiore o uguale a 1');
    }

    return this.campaignsService.getRecipientStats(id, parsedPage, parsedPageSize, search, status, deliveryStatus);
  }

  @Get(':id/stats/recipients/filter-options')
  getRecipientFilterOptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getRecipientFilterOptions(id);
  }

  @Get(':id/export-download-report.csv')
  async exportDownloadReportCsv(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const rows = await this.campaignsService.getDownloadReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_download_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildDownloadReportCsv(rows));
  }

  @Get(':id/send-status-breakdown')
  getSendStatusBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getSendStatusBreakdown(id);
  }

  @Get(':id/export-send-report-attuale.csv')
  async exportSendReportAttuale(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getSendReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_send_attuale_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildSendReportAttualeCsv(report));
  }

  @Get(':id/export-send-report-storico.csv')
  async exportSendReportStorico(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getSendReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_send_storico_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildSendReportStoricoCsv(report));
  }

  @Get(':id/postal-status-breakdown')
  getPostalStatusBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getPostalStatusBreakdown(id);
  }

  @Get(':id/cost')
  getCampaignCost(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignCost(id);
  }

  @Get(':id/cost-savings')
  getCampaignCostSavings(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignCostSavings(id);
  }

  @Get(':id/export-postal-report-attuale.csv')
  async exportPostalReportAttuale(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getPostalReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_postal_attuale_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildPostalReportAttualeCsv(report));
  }

  @Get(':id/export-postal-report-storico.csv')
  async exportPostalReportStorico(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getPostalReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_postal_storico_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildPostalReportStoricoCsv(report));
  }

  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ deleted: true }> {
    const campaign = await this.campaignsService.findOne(id).catch(() => null);
    const result = await this.campaignsService.remove(id, { username: req.user.username, role: req.user.role });
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign ? campaign.name : 'Campagna Eliminata',
      operator: req.user.username,
      action: 'DELETE',
      details: {},
    });
    return result;
  }
}
