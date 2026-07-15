import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { GlobalComClient, type GbcAddress, type GbcCredentials } from './globalcom-client.service';
import { getColumnValue, resolvePhysicalAddress } from '../payment-config.util';

const NON_TERMINAL_DEDUP_STATI = ['Errore', 'Eliminato'];

@Injectable()
export class PostalStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PostalStrategy.name);
  readonly channel: NotificationChannel = 'POSTAL';

  constructor(
    private readonly globalCom: GlobalComClient,
    private readonly settings: AppSettingsService,
    private readonly attachments: AttachmentService,
  ) {}

  private async loadCredentials(): Promise<GbcCredentials> {
    return {
      baseUrl: await this.settings.get<string>('postal.baseUrl'),
      user: await this.settings.get<string>('postal.user'),
      password: await this.settings.get<string>('postal.password'),
      group: await this.settings.get<string>('postal.group'),
    };
  }

  private async loadMittente(): Promise<GbcAddress | null> {
    const denominazione1 = await this.settings.get<string>('postal.mittente.denominazione1');
    if (!denominazione1) return null;
    return {
      denominazione1,
      indirizzo1: await this.settings.get<string>('postal.mittente.indirizzo1'),
      cap: (await this.settings.get<string>('postal.mittente.cap')) || undefined,
      citta: await this.settings.get<string>('postal.mittente.citta'),
      provincia: (await this.settings.get<string>('postal.mittente.provincia')) || undefined,
    };
  }

  async send(
    recipient: Recipient,
    campaign: Campaign,
    onLog?: ChannelLogFn,
    _attemptId?: string,
    attemptsMade?: number,
  ): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, unknown>;
    const creds = await this.loadCredentials();

    // Dedup: il rischio di doppio invio/doppio addebito esiste sui retry,
    // sia automatici BullMQ sullo stesso job (attemptsMade > 0) sia manuali
    // ("Rimetti in coda", che crea un nuovo NotificationAttempt con un nuovo
    // job/attemptId ma un attemptNumber incrementale piggybackato sul
    // recipient da notification.processor.ts) — al primo tentativo in
    // assoluto non può esistere ancora nulla su GlobalCom per questo
    // destinatario. Chiave di ricerca = recipient.id: stabile su tutti gli
    // attempt/retry per lo stesso destinatario nella stessa campagna, a
    // differenza di attemptId che cambia ad ogni retry manuale. Verificato
    // contro il database di GlobalCom stesso (Note = recipient.id), non
    // contro il nostro, vedi design doc.
    const recipientAttemptNumber = (recipient as unknown as { attemptNumber?: number }).attemptNumber;
    const isRetry = (attemptsMade && attemptsMade > 0) || (recipientAttemptNumber && recipientAttemptNumber > 1);
    if (isRetry) {
      const trovati = await this.globalCom.cercaPerTesto(creds, recipient.id);
      const esistente = trovati.find((d) => !NON_TERMINAL_DEDUP_STATI.includes(d.stato));
      if (esistente) {
        const msg = `Invio già presente su GlobalCom per destinatario ${recipient.id} (IDPRO=${esistente.idPro}, stato=${esistente.stato}) — salto reinvio duplicato.`;
        this.logger.warn(msg);
        log(msg);
        return { messageId: esistente.idPro, responsePayload: { stato: esistente.stato, idPro: esistente.idPro, dedup: true } };
      }
    }

    const physicalAddressConfig = cfg['physicalAddressConfig'] as Record<string, unknown> | undefined;
    const resolvedAddress = resolvePhysicalAddress(recipient, physicalAddressConfig);
    if (!resolvedAddress) {
      throw new BadRequestException('indirizzo destinatario non risolvibile: verifica mapping colonne CSV in configurazione canale POSTAL');
    }

    const destinatario: GbcAddress = {
      denominazione1: recipient.fullName || recipient.codiceFiscale,
      indirizzo1: resolvedAddress.address,
      cap: resolvedAddress.zip,
      citta: resolvedAddress.municipality,
      provincia: resolvedAddress.province,
    };

    const servizio = (cfg['postalServiceType'] as string) || 'Raccomandata';
    const ricevutaDiRitorno = servizio === 'Raccomandata' && !!cfg['postalReturnReceipt'];

    const userDataColumn = cfg['userDataColumn'] as string | undefined;
    const userData1 = userDataColumn ? getColumnValue(recipient, userDataColumn) || undefined : undefined;

    const protocollo = (recipient as unknown as { protocolNumber?: string }).protocolNumber;

    const fileBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
    const mittente = await this.loadMittente();
    const centroDiCosto = (await this.settings.get<string>('postal.centroDiCosto')) || undefined;
    const codiceContratto = (await this.settings.get<string>('postal.codiceContratto')) || undefined;

    log(`Invio POSTAL (GlobalCom) a ${recipient.codiceFiscale}: servizio=${servizio}, AR=${ricevutaDiRitorno}`);

    const risposta = await this.globalCom.invioExtSingolo(creds, {
      servizio,
      ricevutaDiRitorno,
      mittente,
      destinatario,
      note: recipient.id,
      protocollo,
      centroDiCosto,
      codiceContratto,
      userData1,
      fileBuffer,
    });

    if (risposta.stato === 'Errore') {
      throw new Error(`Invio GlobalCom in errore (${risposta.codiceErrore || '??'}): ${risposta.descrizione || 'nessun dettaglio'}`);
    }

    this.logger.log(`Invio POSTAL riuscito per CF ${recipient.codiceFiscale}: IDPRO=${risposta.idPro}, stato=${risposta.stato}`);
    log(`Risposta GlobalCom: IDPRO=${risposta.idPro}, stato=${risposta.stato}`);

    return {
      messageId: risposta.idPro,
      responsePayload: { stato: risposta.stato, idPro: risposta.idPro },
    };
  }
}
