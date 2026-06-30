import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { Campaign } from '../entities/campaign.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

@Controller('campaigns')
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

  @Post(':id/launch')
  launch(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ launched: number; campaignId: string }> {
    return this.campaignsService.launch(id);
  }
}
