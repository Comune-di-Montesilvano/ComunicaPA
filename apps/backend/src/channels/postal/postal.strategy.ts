import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AttachmentService } from '../../attachments/attachment.service';
import { GlobalComClient, type GbcAddress } from './globalcom-client.service';
import { PostalProvidersService } from '../../postal-providers/postal-providers.service';
import { getColumnValue, resolvePhysicalAddress } from '../payment-config.util';
import { AppSettingsService } from '../../settings/app-settings.service';
import { splitDenominazione, type DenominazioneAbbreviation } from './denominazione.util';

const NON_TERMINAL_DEDUP_STATI = ['Errore', 'Eliminato'];

/**
 * Un invio esistente su GlobalCom conta come "già presente" (blocca il
 * retry) solo se non ha un errore reale — MAI gatare solo su `stato` testuale
 * (stesso gotcha già noto: `CodiceErrore` arriva async DOPO l'accettazione,
 * `Stato` può restare `Rimandato`/`Accettato` per un po' anche con un
 * `CodiceErrore` già valorizzato — vedi CLAUDE.md "CodiceErrore non legato
 * allo Stato"). Bug reale corretto: retry con indirizzo corretto silenziato
 * come "duplicato" perché lo stato testuale non era ancora `Errore`, mentre
 * `CodiceErrore` segnalava già "impossibile validare l'indirizzo" — il nuovo
 * indirizzo non veniva mai trasmesso a GlobalCom.
 */
function isGoodExistingSubmission(d: { idPro?: string; stato?: string; codiceErrore?: string }): boolean {
  // idPro/stato undefined = mapping fallito su questa entry (risposta
  // lista_documenti con forma diversa da dettagli_documento — stesso gotcha
  // "nomi WSDL reali vanno verificati sul campo, mai assunti") — bug reale
  // osservato in log prod: "IDPRO=undefined, stato=undefined" passava questo
  // check su quasi ogni retry (undefined non è in NON_TERMINAL_DEDUP_STATI,
  // codiceErrore era anch'esso undefined) e bloccava reinvii legittimi su
  // dati spazzatura. Senza idPro/stato validi non c'è modo di fidarsi che
  // sia davvero un invio buono: mai deduplicare.
  return !!d.idPro && !!d.stato && !NON_TERMINAL_DEDUP_STATI.includes(d.stato) && (!d.codiceErrore || d.codiceErrore === '0');
}

@Injectable()
export class PostalStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PostalStrategy.name);
  readonly channel: NotificationChannel = 'POSTAL';

  constructor(
    private readonly globalCom: GlobalComClient,
    private readonly providers: PostalProvidersService,
    private readonly attachments: AttachmentService,
    private readonly settings: AppSettingsService,
  ) {}

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

    const provider = await this.providers.getActive();
    if (!provider) {
      throw new BadRequestException('Nessun provider di postalizzazione attivo — configuralo e testalo in Impostazioni → Postalizzazione');
    }
    const creds = provider.creds;

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
      const esistente = trovati.find((d) => isGoodExistingSubmission(d));
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

    const servizio = (cfg['postalServiceType'] as string) || provider.enabledServiceTypes[0] || 'Raccomandata';

    // CF sul destinatario omesso per Servizio Agol* (Atto Giudiziario): errore
    // reale riscontrato "Ritiro digitale richiesto per almeno uno dei
    // destinatari" solo quando il CF è presente — ipotesi: GlobalCom lo usa
    // per verificare un domicilio digitale e proporre il ritiro digitale.
    // Nessun caso d'uso di questo Comune prevede il ritiro digitale via
    // GlobalCom per Atto Giudiziario (richiesta esplicita) — CF omesso per
    // evitare di innescare quel percorso, mantenuto per gli altri Servizio
    // (Raccomandata/Lettera) dove non risulta causare problemi.
    const abbreviationsRaw = await this.settings.get<string>('notifiche.denominazioneAbbreviations');
    let abbreviations: DenominazioneAbbreviation[] = [];
    try {
      abbreviations = JSON.parse(abbreviationsRaw || '[]');
    } catch {
      this.logger.warn(`notifiche.denominazioneAbbreviations non è JSON valido, ignorata: ${abbreviationsRaw}`);
    }
    const { denominazione1, denominazione2, truncated } = splitDenominazione(
      recipient.fullName || recipient.codiceFiscale,
      abbreviations,
    );
    if (truncated) {
      this.logger.warn(
        `Denominazione troncata per destinatario ${recipient.codiceFiscale}: nome oltre gli 88 caratteri disponibili su Denominazione1+2`,
      );
    }

    const destinatario: GbcAddress = {
      denominazione1,
      denominazione2,
      indirizzo1: resolvedAddress.address,
      cap: resolvedAddress.zip,
      citta: resolvedAddress.municipality,
      provincia: resolvedAddress.province,
      stato: resolvedAddress.foreignState,
      codiceFiscale: servizio.startsWith('Agol') ? undefined : recipient.codiceFiscale,
      email: recipient.email || undefined,
    };

    // Atto Giudiziario (Agol*): AR obbligatoria per legge, non opzionale come
    // per una raccomandata — la UI nasconde il checkbox "Ricevuta di ritorno"
    // per questo Servizio (sempre attiva, non configurabile). Senza Ricevuta,
    // GlobalCom accetta l'invio ma fallisce in lavorazione, dopo l'accettazione
    // (Stato: Accettato → Errore, CodiceErrore -2 "Nessun destinatario
    // ricevuta trovato per questa spedizione" — errore reale riscontrato).
    const ricevutaDiRitorno = servizio.startsWith('Agol') || (servizio.startsWith('Raccomandata') && !!cfg['postalReturnReceipt']);
    const colore = !!cfg['postalColorPrint'];
    const fronteRetro = cfg['postalDuplex'] !== undefined ? !!cfg['postalDuplex'] : true;

    const userDataColumn = cfg['userDataColumn'] as string | undefined;
    const userData1 = userDataColumn ? getColumnValue(recipient, userDataColumn) || undefined : undefined;

    const protocollo = (recipient as unknown as { protocolNumber?: string }).protocolNumber;

    const fileBuffer = await this.attachments.generatePdfBuffer(recipient, 0);

    // CodiceContratto (obbligatorio per Servizio Market/Contest/Atto
    // Giudiziario): override esplicito da channelConfig se impostato nel
    // wizard (utenza con più contratti per lo stesso Tipologia), altrimenti
    // primo contratto scoperto da InformazioniUtenza il cui Tipologia è
    // prefisso del Servizio scelto (es. Tipologia="RaccomandataMarket" per
    // Servizio="RaccomandataMarket4") — verificato in test reale, nessun
    // Servizio standard (Lettera/Raccomandata H2H) lo richiede.
    const codiceContrattoOverride = cfg['postalCodiceContratto'] as string | undefined;
    const codiceContratto = codiceContrattoOverride
      || provider.contratti.find((c) => servizio.startsWith(c.tipologia))?.codiceContratto
      || undefined;

    // Indirizzo estero: il contratto usato per questo invio deve dichiarare
    // capability Estero (DatiContrattoCOLMOLExt.Estero, scoperto da
    // InformazioniUtenza — vedi design doc 2026-07-28-indirizzo-estero
    // Sezione 2). resolvedAddress.foreignState è già un valore canonico
    // validato da matchCountry (payment-config.util.ts): qui basta il
    // controllo capability, nessuna ri-validazione del paese.
    if (resolvedAddress.foreignState) {
      const contrattoUsato = provider.contratti.find((c) => c.codiceContratto === codiceContratto);
      if (!contrattoUsato || contrattoUsato.estero !== true) {
        throw new BadRequestException(
          `Indirizzo estero (${resolvedAddress.foreignState}) ma il contratto ${codiceContratto || '(nessuno)'} non supporta spedizioni estero`,
        );
      }
    }

    // Vedi commento su GbcInvioParams.agol: obbligatorio (mai omesso) per
    // questo Servizio, pena NullReferenceException generico lato GlobalCom.
    // avvisoRicevimentoDigitale sempre false: nessun caso d'uso di questo
    // Comune prevede il ritiro digitale via GlobalCom per Atto Giudiziario
    // (richiesta esplicita, oltre a essere legato al CodiceFiscale — già
    // omesso sul destinatario per questo Servizio, vedi sopra).
    const agol = servizio.startsWith('Agol')
      ? {
        tipoNotificante: ((cfg['postalAgolTipoNotificante'] as string) || 'NonUtilizzato') as 'NonUtilizzato' | 'UfficialeGiudiziario' | 'Procuratore' | 'ParteIstante',
        secondoTentativoRecapito: ((cfg['postalAgolSecondoTentativo'] as string) || 'NonRichiedere') as 'NonRichiedere' | 'Concordato' | 'Automatico',
        nomeNotificante: (cfg['postalAgolNomeNotificante'] as string) || undefined,
        numeroCronologico: (cfg['postalAgolNumeroCronologico'] as string) || undefined,
        avvisoRicevimentoDigitale: false,
      }
      : undefined;
    const idCoverPage = cfg['postalIdCoverPage'] as string | undefined;

    log(`Invio POSTAL (GlobalCom) a ${recipient.codiceFiscale}: servizio=${servizio}, AR=${ricevutaDiRitorno}, colore=${colore}, fronteRetro=${fronteRetro}, codiceContratto=${codiceContratto || '(nessuno)'}${agol ? `, agol=${JSON.stringify(agol)}` : ''}`);

    const risposta = await this.globalCom.invioExtSingolo(creds, {
      servizio,
      ricevutaDiRitorno,
      colore,
      fronteRetro,
      mittente: provider.mittente,
      // AR torna al mittente configurato (nessun indirizzo AR distinto in UI/config).
      ricevuta: ricevutaDiRitorno ? provider.mittente : undefined,
      destinatario,
      note: recipient.id,
      protocollo,
      centroDiCosto: provider.centroDiCosto,
      codiceContratto,
      userData1,
      fileBuffer,
      idCoverPage,
      agol,
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
