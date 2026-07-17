import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';
import { OidcAuthGuard } from '../auth/guards/oidc-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CitizenService } from './citizen.service';
import { SendLegalFactsService } from '../channels/send/send-legal-facts.service';

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

  @Get('notifications/:id/attachment/:index')
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: { user: CitizenTokenClaims },
    @Res() res: Response,
  ) {
    // 1. Registra il download nel DB
    await this.citizenService.markAsDownloaded(id, req.user.codiceFiscale, index);

    // 2. Genera il PDF
    const pdfBuffer = await this.citizenService.generateAttachmentPdf(id, req.user.codiceFiscale, index);

    // 3. Spedisce il file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="avviso_${id.slice(0, 8)}_${index + 1}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }

  /**
   * Elenco dei documenti legali (attestazioni opponibili a terzi) disponibili
   * sulla piattaforma SEND per la notifica indicata. Usato dal frontend
   * per mostrare i link di download corretti nella timeline.
   */
  @Get('notifications/:id/send-legal-facts')
  async listSendLegalFacts(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: CitizenTokenClaims },
  ) {
    const notif = await this.citizenService.findOneForCitizen(id, req.user.codiceFiscale);
    if (!notif.iun) return [];
    return this.sendLegalFactsService.listLegalFacts(notif.iun);
  }

  /**
   * Download di un documento legale (attestazione opponibile a terzi) direttamente
   * dalla piattaforma SEND tramite il legalFactId. Usato nel dettaglio della notifica
   * SEND per scaricare le attestazioni della timeline.
   */
  @Get('notifications/:id/send-document')
  async downloadSendDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('iun') iun: string,
    @Query('legalFactId') legalFactId: string,
    @Req() req: { user: CitizenTokenClaims },
    @Res() res: Response,
  ) {
    if (!iun || !legalFactId) {
      throw new NotFoundException('Parametri IUN o legalFactId mancanti');
    }

    // Verifica che il recipient appartiene al cittadino autenticato
    await this.citizenService.findOneForCitizen(id, req.user.codiceFiscale);

    // Registra il download
    await this.citizenService.markAsDownloaded(id, req.user.codiceFiscale, 0);

    // Scarica il documento legale da SEND
    const result = await this.sendLegalFactsService.downloadLegalFact(iun, legalFactId);

    if (!result.ready) {
      const msg = result.error ?? 'Documento non ancora disponibile, riprovare tra qualche istante.';
      res.status(503).json({ message: msg });
      return;
    }

    let contentType = result.contentType;
    if (result.filename.toLowerCase().endsWith('.p7m')) {
      contentType = 'application/pkcs7-mime';
    }
    res.setHeader('Content-Type', contentType);
    const isInline = /\.(pdf|png|jpe?g|gif)$/i.test(result.filename);
    const dispositionMode = isInline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${dispositionMode}; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.buffer.length);
    res.end(result.buffer);
  }
}

