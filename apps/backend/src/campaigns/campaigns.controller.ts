import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import * as fs from 'fs';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { Campaign } from '../entities/campaign.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PreviewMessageDto } from './dto/preview-message.dto';
import { getUploadsDir } from '../attachments/attachment-paths';

@Controller('admin/campaigns')
@Roles('user', 'admin')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  findAll(): Promise<Campaign[]> {
    return this.campaignsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    return this.campaignsService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateCampaignDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<Campaign> {
    return this.campaignsService.create(dto, req.user.username);
  }

  @Patch(':id')
  updateDraft(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaignsService.updateDraft(id, dto);
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
  uploadCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ imported: number; campaignId: string }> {
    if (!file) {
      throw new BadRequestException('File CSV richiesto (Content-Type: text/csv)');
    }
    return this.campaignsService.uploadCsv(id, file.path);
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
    return {
      uploaded: result.uploaded,
      discarded: result.discarded,
      campaignId: id,
    };
  }

  @Post(':id/launch')
  launch(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ launched: number; campaignId: string }> {
    return this.campaignsService.launch(id);
  }

  @Get(':id/duplicate-source')
  getDuplicateSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getDuplicateSource(id);
  }

  @Get(':id/stats')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getStats(id);
  }

  @Get(':id/channel-stats')
  getChannelBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getChannelBreakdown(id).then((breakdown) => ({ campaignId: id, breakdown }));
  }

  @Get(':id/failures')
  getFailures(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailures(id);
  }

  @Post(':id/recipients/:recipientId/retry')
  retryRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.campaignsService.retryRecipient(id, recipientId);
  }

  @Get(':id/stats/recipients')
  getRecipientStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = parseInt(page ?? '1', 10);
    const parsedPageSize = parseInt(pageSize ?? '50', 10);

    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('Il parametro page deve essere un numero intero maggiore o uguale a 1');
    }
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1) {
      throw new BadRequestException('Il parametro pageSize deve essere un numero intero maggiore o uguale a 1');
    }

    return this.campaignsService.getRecipientStats(id, parsedPage, parsedPageSize);
  }
}
