import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';
import { OidcAuthGuard } from '../auth/guards/oidc-auth.guard';
import { CitizenService } from './citizen.service';

@Controller('citizen')
@UseGuards(OidcAuthGuard)
export class CitizenController {
  constructor(private readonly citizenService: CitizenService) {}

  @Get('notifications')
  findAll(@Req() req: { user: CitizenTokenClaims }) {
    return this.citizenService.findAllForCitizen(req.user.codiceFiscale);
  }

  @Get('notifications/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenTokenClaims },
  ) {
    return this.citizenService.findOneForCitizen(id, req.user.codiceFiscale);
  }

  @Post('notifications/:id/download')
  @HttpCode(HttpStatus.OK)
  markDownloaded(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenTokenClaims },
  ) {
    return this.citizenService.markAsDownloaded(id, req.user.codiceFiscale);
  }

  @Get('notifications/:id/attachment')
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenTokenClaims },
    @Res() res: Response,
  ) {
    // 1. Registra il download nel DB
    await this.citizenService.markAsDownloaded(id, req.user.codiceFiscale);

    // 2. Genera il PDF
    const pdfBuffer = await this.citizenService.generateAttachmentPdf(id, req.user.codiceFiscale);

    // 3. Spedisce il file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avviso_${id.slice(0, 8)}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }
}
