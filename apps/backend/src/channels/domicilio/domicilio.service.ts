import { Injectable } from '@nestjs/common';
import { InadService, InadDigitalAddressElement } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';
import type { AnprGeneralita, AnprResidenza, AnprInfoSoggettoEnte } from '../anpr/anpr.types';
import { RegistroImpreseService, type RegistroImpreseImpresaData } from '../registro-imprese/registro-imprese.service';
import { isPartitaIva } from '../tax-id.util';

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
  idANPR?: string;
  generalita?: AnprGeneralita;
  residenza?: AnprResidenza[];
  infoSoggettoEnte?: AnprInfoSoggettoEnte[];
  message?: string;
}

export interface DomicilioEsistenzaInVitaResult {
  success: boolean;
  dataDecesso?: string;
  message?: string;
}

export interface DomicilioRegistroImpreseResult {
  success: boolean;
  found: boolean;
  pec?: string;
  denominazione?: string;
  data?: RegistroImpreseImpresaData;
  message?: string;
}

export interface DomicilioSearchResult {
  codiceFiscale: string;
  // Assenti (non interrogati) quando il valore è una Partita IVA — vedi
  // registroImprese in quel caso.
  inad?: DomicilioInadResult;
  appIo?: DomicilioAppIoResult;
  anpr?: DomicilioAnprResult;
  anprEsistenzaInVita?: DomicilioEsistenzaInVitaResult;
  registroImprese?: DomicilioRegistroImpreseResult;
}

/**
 * Orchestratore "Cerca Domicilio": interroga INAD + App IO + ANPR in
 * parallelo per un CF persona fisica, oppure Registro Imprese (PDND) per una
 * Partita IVA — mai entrambi gli insiemi di fonti per lo stesso input.
 * Nessuna persistenza — query live ogni volta. Un fallimento di una fonte
 * non deve azzerare le altre, quindi ogni ramo cattura il proprio errore
 * invece di propagarlo.
 *
 * ANPR C019 (data decesso) è una finalità PDND separata da C002 — viene
 * interrogata SOLO se C002 ha già segnalato il soggetto deceduto (mai per
 * soggetti in vita), per non consumare quota C019 inutilmente.
 */
@Injectable()
export class DomicilioService {
  constructor(
    private readonly inadService: InadService,
    private readonly ioServicesService: IoServicesService,
    private readonly anprService: AnprService,
    private readonly registroImpreseService: RegistroImpreseService,
  ) {}

  async cercaDomicilio(codiceFiscale: string, operatorUsername: string): Promise<DomicilioSearchResult> {
    if (isPartitaIva(codiceFiscale)) {
      return this.cercaDomicilioImpresa(codiceFiscale);
    }

    const [inad, appIo, anpr] = await Promise.allSettled([
      this.inadService.extractDigitalAddress(codiceFiscale),
      this.ioServicesService.verifyProfile(codiceFiscale),
      this.anprService.getResidenza(codiceFiscale, operatorUsername),
    ]);

    const result: DomicilioSearchResult = {
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
          ? {
              success: true,
              found: anpr.value.found,
              idANPR: anpr.value.data?.idANPR,
              generalita: anpr.value.data?.generalita,
              residenza: anpr.value.data?.residenza,
              infoSoggettoEnte: anpr.value.data?.infoSoggettoEnte,
            }
          : { success: false, found: false, message: anpr.reason?.message ?? 'Errore sconosciuto' },
    };

    const vitaInfo =
      anpr.status === 'fulfilled'
        ? anpr.value.data?.infoSoggettoEnte?.find((i) => (i.chiave ?? '').toLowerCase().includes('vita'))
        : undefined;
    const isDeceduto = anpr.status === 'fulfilled' && anpr.value.found && vitaInfo?.valore === 'N';

    if (isDeceduto) {
      try {
        const esistenza = await this.anprService.getEsistenzaInVita(codiceFiscale, operatorUsername);
        result.anprEsistenzaInVita = { success: true, dataDecesso: esistenza.data?.dataDecesso };
      } catch (error: any) {
        result.anprEsistenzaInVita = { success: false, message: error?.message ?? 'Errore sconosciuto' };
      }
    }

    return result;
  }

  private async cercaDomicilioImpresa(partitaIva: string): Promise<DomicilioSearchResult> {
    try {
      const dettaglio = await this.registroImpreseService.dettaglioImpresa(partitaIva);
      return {
        codiceFiscale: partitaIva,
        registroImprese: { success: true, found: dettaglio.found, pec: dettaglio.pec, denominazione: dettaglio.denominazione, data: dettaglio.data },
      };
    } catch (error: any) {
      return {
        codiceFiscale: partitaIva,
        registroImprese: { success: false, found: false, message: error?.message ?? 'Errore sconosciuto' },
      };
    }
  }
}
