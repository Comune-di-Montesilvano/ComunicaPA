import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { AuditLogsService } from '../../audit-logs/audit-logs.service.js';
import { DomicilioService } from './domicilio.service.js';
import { CercaDomicilioDto } from './dto/cerca-domicilio.dto.js';
import { CercaDomicilioAnagraficaDto } from './dto/cerca-domicilio-anagrafica.dto.js';

@Controller('admin/domicilio')
export class DomicilioController {
  constructor(
    private readonly domicilioService: DomicilioService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  @Post('cerca')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async cerca(@Body() dto: CercaDomicilioDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const cf = dto.codiceFiscale.toUpperCase().trim();
    const result = await this.domicilioService.cercaDomicilio(cf, req.user.username);
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'DOMICILIO_SEARCH',
      details: { codiceFiscale: cf },
    });
    return result;
  }

  /**
   * Helper "Non hai il codice fiscale?" — ricerca ANPR C002 per anagrafica
   * pura. Audit log su criteri cercati + motivoRichiesta + esito, MAI solo
   * il CF come per /cerca: qui l'input non è un CF, e l'assenza di CF nel
   * log renderebbe impossibile ricostruire "chi ha cercato chi".
   */
  @Post('cerca-anagrafica')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async cercaAnagrafica(@Body() dto: CercaDomicilioAnagraficaDto, @Req() req: Request & { user: JwtOperatorPayload }) {
    const result = await this.domicilioService.cercaPerAnagrafica(
      {
        cognome: dto.cognome,
        nome: dto.nome,
        sesso: dto.sesso,
        dataNascita: dto.dataNascita,
        comuneNascita: dto.comuneNascita,
        provinciaNascita: dto.provinciaNascita,
      },
      req.user.username,
      dto.motivoRichiesta,
    );
    await this.auditLogsService.log({
      operator: req.user.username,
      action: 'DOMICILIO_SEARCH_ANAGRAFICA',
      details: {
        cognome: dto.cognome,
        nome: dto.nome,
        sesso: dto.sesso,
        dataNascita: dto.dataNascita,
        comuneNascita: dto.comuneNascita,
        provinciaNascita: dto.provinciaNascita,
        motivoRichiesta: dto.motivoRichiesta,
        found: result.found,
        codiceFiscaleTrovato: result.generalita?.codiceFiscale?.codFiscale,
      },
    });
    return result;
  }
}
