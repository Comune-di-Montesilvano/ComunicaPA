import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { InadService } from './inad.service.js';
import { VerifyInadSingleDto } from './dto/inad-verify.dto.js';

@Controller('admin/inad-verify')
export class InadVerifyController {
  constructor(private readonly inadService: InadService) {}

  @Post('verify-single')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async verifySingle(@Body() body: VerifyInadSingleDto) {
    const cf = body.codiceFiscale.toUpperCase().trim();
    try {
      const result = await this.inadService.extractDigitalAddress(cf);
      if (!result.found) {
        return { success: true, found: false, message: 'Nessun domicilio digitale trovato su INAD per questo codice fiscale' };
      }
      return {
        success: true,
        found: true,
        message: 'Domicilio digitale trovato su INAD',
        digitalAddress: result.data?.digitalAddress ?? [],
      };
    } catch (err: any) {
      return { success: false, found: false, message: `Errore verifica INAD: ${err.message}` };
    }
  }
}
