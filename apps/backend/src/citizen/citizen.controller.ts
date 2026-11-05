import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { recipientKeyOf, type CitizenSessionClaims } from '../auth/citizen-claims.js';
import { OidcAuthGuard } from '../auth/guards/oidc-auth.guard.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CitizenService } from './citizen.service.js';
import { SEND_CITIZEN_PORTAL_URL, SendLegalFactsService } from '../channels/send/send-legal-facts.service.js';

// @Public() esclude questo controller dal JwtAuthGuard globale (pensato per
// gli operatori, verifica JWT HS256/JWT_SECRET): i token cittadino OIDC reali
// sono RS256 firmati dal provider esterno e falliscono quella verifica prima
// ancora di raggiungere l'OidcAuthGuard sotto, con un 401 muto e nessun log.
// In dev (LDAP_HOST=mock) il bug non si vedeva perché il token cittadino
// simulato è firmato con lo stesso JWT_SECRET/HS256 dell'operatore.
@Controller('citizen')
@Public()
@UseGuards(OidcAuthGuard)
export class CitizenController {
  constructor(
    private readonly citizenService: CitizenService,
    private readonly sendLegalFactsService: SendLegalFactsService,
  ) {}

  @Get('notifications')
  findAll(@Req() req: { user: CitizenSessionClaims }) {
    return this.citizenService.findAllForCitizen(recipientKeyOf(req.user));
  }

  @Get('notifications/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenSessionClaims },
  ) {
    return this.citizenService.findOneForCitizen(id, recipientKeyOf(req.user));
  }

  @Post('notifications/:id/download')
  @HttpCode(HttpStatus.OK)
  markDownloaded(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenSessionClaims },
  ) {
    return this.citizenService.markAsDownloaded(id, recipientKeyOf(req.user));
  }

  @Get('notifications/:id/attachment/:index')
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: { user: CitizenSessionClaims },
    @Res() res: Response,
  ) {
    // 1. Genera il PDF (rifiutato per le notifiche SEND: prima del conteggio)
    const pdfBuffer = await this.citizenService.generateAttachmentPdf(id, recipientKeyOf(req.user), index);

    // 2. Registra il download nel DB
    await this.citizenService.markAsDownloaded(id, recipientKeyOf(req.user), index);

    // 3. Spedisce il file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="avviso_${id.slice(0, 8)}_${index + 1}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }

  /**
   * Link alla notifica sul portale SEND: per le notifiche SEND il portale
   * cittadini non offre documenti (né allegati né atti PN), solo il rimando a
   * SEND, unico luogo dove la notifica ha valore legale. Se il QR dell'avviso
   * di avvenuta ricezione si legge, link diretto alla notifica; altrimenti il
   * portale cittadini SEND.
   */
  @Get('notifications/:id/send-link')
  async getSendLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenSessionClaims },
  ): Promise<{ url: string; direct: boolean }> {
    const notif = await this.citizenService.findOneForCitizen(id, recipientKeyOf(req.user));
    const direct = notif.iun ? await this.sendLegalFactsService.getQuickAccessUrl(notif.iun) : null;
    return direct ? { url: direct, direct: true } : { url: SEND_CITIZEN_PORTAL_URL, direct: false };
  }
}
