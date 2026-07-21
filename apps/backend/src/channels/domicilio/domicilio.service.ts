import { Injectable } from '@nestjs/common';
import { InadService, InadDigitalAddressElement } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';
import type { AnprGeneralita, AnprResidenza } from '../anpr/anpr.types';

export interface DomicilioInadResult {
  success: boolean;
  found: boolean;
  digitalAddress?: InadDigitalAddressElement[];
  message?: string;
}

export interface DomicilioAppIoResult {
  success: boolean;
  active: boolean;
  message: string;
}

export interface DomicilioAnprResult {
  success: boolean;
  found: boolean;
  generalita?: AnprGeneralita;
  residenza?: AnprResidenza[];
  message?: string;
}

export interface DomicilioSearchResult {
  codiceFiscale: string;
  inad: DomicilioInadResult;
  appIo: DomicilioAppIoResult;
  anpr: DomicilioAnprResult;
}

/**
 * Orchestratore "Cerca Domicilio": interroga INAD + App IO + ANPR in
 * parallelo per lo stesso CF. Nessuna persistenza — query live ogni volta.
 * Un fallimento di una fonte non deve azzerare le altre due già arrivate,
 * quindi ogni ramo cattura il proprio errore invece di propagarlo.
 */
@Injectable()
export class DomicilioService {
  constructor(
    private readonly inadService: InadService,
    private readonly ioServicesService: IoServicesService,
    private readonly anprService: AnprService,
  ) {}

  async cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult> {
    const [inad, appIo, anpr] = await Promise.allSettled([
      this.inadService.extractDigitalAddress(codiceFiscale),
      this.ioServicesService.verifyProfile(codiceFiscale),
      this.anprService.getResidenza(codiceFiscale, operatorUsername),
    ]);

    return {
      codiceFiscale,
      inad:
        inad.status === 'fulfilled'
          ? { success: true, found: inad.value.found, digitalAddress: inad.value.data?.digitalAddress }
          : { success: false, found: false, message: inad.reason?.message ?? 'Errore sconosciuto' },
      appIo:
        appIo.status === 'fulfilled'
          ? appIo.value
          : { success: false, active: false, message: appIo.reason?.message ?? 'Errore sconosciuto' },
      anpr:
        anpr.status === 'fulfilled'
          ? { success: true, found: anpr.value.found, generalita: anpr.value.data?.generalita, residenza: anpr.value.data?.residenza }
          : { success: false, found: false, message: anpr.reason?.message ?? 'Errore sconosciuto' },
    };
  }
}
