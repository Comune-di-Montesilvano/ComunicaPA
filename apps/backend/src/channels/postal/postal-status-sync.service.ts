import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { PostalProvidersService } from '../../postal-providers/postal-providers.service';
import { GlobalComClient, type GbcCredentials } from './globalcom-client.service';

const BATCH_SIZE = 200;
// GBCStatus terminali (manuale §3.1) — tutti gli altri sono transitori e
// vanno ricontrollati al prossimo giro.
const TERMINAL_STATUSES = ['Consegnato', 'NonConsegnato', 'ConsegnaParziale', 'Errore', 'Eliminato'];

/**
 * Demone di poll consegna per il canale POSTAL/GlobalCom — nessuna chiamata
 * a CampaignCompletionService.checkAndComplete(): il completamento campagna
 * è già deciso a livello di submission dal NotificationProcessor BullMQ
 * standard (PostalStrategy resta su BullMQ, a differenza di SEND). Qui si
 * aggiorna solo lo stato di consegna downstream, puramente informativo.
 *
 * Legge anche il costo reale (Valori.Costo) dalla stessa risposta
 * dettagli_documento — un attempt resta candidato al poll anche a stato
 * terminale finché cost_cents non è stato calcolato almeno una volta (vedi
 * docs/superpowers/specs/2026-07-21-costo-notifiche-design.md).
 */
@Injectable()
export class PostalStatusSyncService {
  private readonly logger = new Logger(PostalStatusSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly providers: PostalProvidersService,
    private readonly globalCom: GlobalComClient,
  ) {}

  @Cron('*/1 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      // Un attempt Eliminato con costo già calcolato (caso comune: il costo si
      // valorizza spesso mentre il documento è ancora Confermato/Accettato,
      // prima che GlobalCom lo passi a Eliminato) altrimenti non rientrerebbe
      // mai più in questo batch — il controllo riaccodamento (vedi
      // checkRequeue) non verrebbe mai raggiunto in automatico. Bug reale
      // riscontrato: il filtro pre-esistente escludeva questi record fin
      // dall'inizio, il flag postal_requeue_checked_at restava per sempre
      // null e il controllo automatico non scattava mai.
      //
      // cost_cents = 0 trattato come "non ancora costato" quanto NULL (bug
      // reale corretto: GlobalCom può rispondere Costo:0 mentre il documento
      // è ancora in lavorazione — non un costo reale, un placeholder prima
      // del calcolo effettivo — e una volta persistito quello 0 usciva per
      // sempre da questo filtro su un attempt già a stato terminale, restando
      // a 0 anche quando GlobalCom aveva nel frattempo calcolato il costo
      // vero). Vedi anche il gate in syncOne più sotto.
      .andWhere(
        '(attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal) OR attempt.cost_cents IS NULL OR attempt.cost_cents = 0 OR (attempt.postal_status = :eliminato AND attempt.postal_requeue_checked_at IS NULL))',
        { terminal: TERMINAL_STATUSES, eliminato: 'Eliminato' },
      )
      .orderBy('COALESCE(attempt.postal_last_checked_at, attempt.created_at)', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;

    const provider = await this.providers.getActive();
    if (!provider) return;
    const creds = provider.creds;

    for (const attempt of attempts) {
      try {
        await this.syncOne(attempt, creds);
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }

  private async syncOne(attempt: NotificationAttempt, creds: GbcCredentials, opts: { forceRequeueCheck?: boolean } = {}): Promise<boolean> {
    let stato: Awaited<ReturnType<GlobalComClient['dettagliDocumento']>>;
    try {
      stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
    } catch (err) {
      // Round-robin anti-starvation (stesso principio già in nota per l'ORDER
      // BY statico): un IDPRO che fa fallire dettagli_documento in modo
      // persistente (SOAP fault, timeout, IDPRO non più valido) altrimenti
      // NON aggiorna mai postal_last_checked_at — resta per sempre il
      // candidato più "vecchio" in cima all'ORDER BY ASC, viene riselezionato
      // a OGNI giro cron, fallisce di nuovo, e occupa uno slot del batch da
      // 200 all'infinito senza mai avanzare. Su una campagna con migliaia di
      // destinatari, anche pochi IDPRO bloccati così affamano il batch per
      // tutti gli altri (bug reale riscontrato: costo/stato fermi da giorni
      // su record non terminali, nonostante il filtro WHERE li includa a
      // ogni giro). Timestamp aggiornato comunque, poi si rilancia l'errore:
      // il chiamante (handleCron) logga come già faceva.
      attempt.postalLastCheckedAt = new Date();
      await this.attemptRepo.save(attempt);
      throw err;
    }
    attempt.postalLastCheckedAt = new Date();
    if (!stato) {
      await this.attemptRepo.save(attempt);
      return false;
    }

    let changed = false;
    const deliveryChanged =
      stato.statoConsegna !== attempt.postalDeliveryStatus ||
      stato.codiceConsegna !== attempt.postalDeliveryCode ||
      (stato.dataConsegna ? new Date(stato.dataConsegna).getTime() !== attempt.postalDeliveryDate?.getTime() : false) ||
      (stato.idAccettazione && stato.idAccettazione !== attempt.postalAcceptanceId);

    if (stato.statoConsegna !== attempt.postalDeliveryStatus) {
      attempt.postalDeliveryStatus = stato.statoConsegna ?? null;
      changed = true;
    }
    if (stato.codiceConsegna !== attempt.postalDeliveryCode) {
      attempt.postalDeliveryCode = stato.codiceConsegna ?? null;
      changed = true;
    }
    if (stato.dataConsegna) {
      const parsedDate = new Date(stato.dataConsegna);
      if (!isNaN(parsedDate.getTime()) && (!attempt.postalDeliveryDate || parsedDate.getTime() !== attempt.postalDeliveryDate.getTime())) {
        attempt.postalDeliveryDate = parsedDate;
        changed = true;
      }
    }
    if (stato.idAccettazione && stato.idAccettazione !== attempt.postalAcceptanceId) {
      attempt.postalAcceptanceId = stato.idAccettazione;
      changed = true;
    }

    if (stato.stato !== attempt.postalStatus || deliveryChanged) {
      attempt.postalStatus = stato.stato;
      attempt.postalStatusUpdatedAt = new Date();
      attempt.postalStatusHistory = [
        ...(attempt.postalStatusHistory ?? []),
        {
          stato: stato.stato,
          rilevatoIl: new Date().toISOString(),
          // Codice/descrizione errore GlobalCom (es. "-1"/"numeri
          // raccomandata non salvati o non disponibili") — prima
          // visibili solo sul portale GlobalCom, mai persistiti da noi.
          // Gate su codiceErrore!=='0', non su stato: GlobalCom manda
          // codici reali (es. "-2") anche su stati non terminali come
          // "Rimandato" (bug reale: un gate su stato==='Errore' li
          // nascondeva) ma manda anche un codice "benigno" ("0") su
          // stati positivi come "Confermato" — persisterlo avrebbe
          // mostrato in UI un esito positivo come se fosse un errore
          // (bug reale riscontrato: "GlobalCom (0)" su un invio in
          // realtà confermato).
          ...(stato.codiceErrore && stato.codiceErrore !== '0' ? { codiceErrore: stato.codiceErrore } : {}),
          ...(stato.descrizione && stato.codiceErrore !== '0' ? { descrizione: stato.descrizione } : {}),
          ...(stato.statoConsegna ? { statoConsegna: stato.statoConsegna } : {}),
          ...(stato.codiceConsegna !== null && stato.codiceConsegna !== undefined ? { codiceConsegna: stato.codiceConsegna } : {}),
        },
      ];
      changed = true;
    }
    // costCents === 0 trattato come "non ancora costato" (vedi commento sul
    // filtro WHERE sopra): un 0 salvato in precedenza (placeholder GlobalCom
    // durante la lavorazione) va sovrascritto appena arriva un costo reale
    // (!== 0) — se GlobalCom continua a rispondere 0 non c'è nulla di nuovo
    // da persistere, evita un save no-op a ogni giro.
    const costNotYetFinal = attempt.costCents === null || attempt.costCents === 0;
    const costoNetto = stato.costoNetto;
    const hasNewRealCost = costoNetto !== null && costoNetto !== undefined && (attempt.costCents === null || costoNetto !== 0);
    if (costNotYetFinal && hasNewRealCost) {
      attempt.costCents = Math.round(costoNetto * 100);
      attempt.costCalculatedAt = new Date();
      attempt.costBreakdown = {
        costoNetto,
        numeroPagine: stato.numeroPagine ?? null,
        nazionale: stato.nazionale ?? null,
        importoPostaleNetto: stato.importoPostaleNetto ?? null,
        importoStampaNetto: stato.importoStampaNetto ?? null,
        importoARNetto: stato.importoARNetto ?? null,
        tipoDocumento: stato.tipoDocumento ?? null,
        codiceContratto: stato.codiceContratto ?? null,
      };
      changed = true;
    }

    if (attempt.postalStatus === 'Eliminato' && (opts.forceRequeueCheck || !attempt.postalRequeueCheckedAt)) {
      await this.checkRequeue(attempt, creds);
    }

    await this.attemptRepo.save(attempt);
    return changed;
  }

  /**
   * Un attempt Eliminato può essere stato riaccodato da GlobalCom sotto un
   * nuovo IDPRO (mai un re-invio nostro — solo presa d'atto di un invio già
   * accettato). `lista_riaccodamenti_documento` ritorna l'intera catena,
   * l'ultimo elemento è quello corretto/attivo. Se la catena ha più di un
   * riaccodamento si crea un solo nuovo attempt per l'ultimo IDPRO — gli
   * intermedi non hanno valore proprio. Il flag `postalRequeueCheckedAt`
   * viene stampato solo se il controllo è andato a buon fine (trovato o
   * non trovato) — su errore SOAP resta invariato, il prossimo giro cron
   * riprova (il chiamante manuale invece forza sempre il controllo, vedi
   * `refreshOne`).
   */
  private async checkRequeue(attempt: NotificationAttempt, creds: GbcCredentials): Promise<void> {
    try {
      const chain = await this.globalCom.listaRiaccodamentiDocumento(creds, attempt.postalTrackingId!);
      const nuovoIdPro = chain[chain.length - 1];
      if (chain.length > 1 && nuovoIdPro && nuovoIdPro !== attempt.postalTrackingId) {
        const esistente = await this.attemptRepo.findOne({ where: { recipientId: attempt.recipientId, postalTrackingId: nuovoIdPro } });
        if (!esistente) {
          const statoNuovo = await this.globalCom.dettagliDocumento(creds, nuovoIdPro);
          const ultimoAttempt = await this.attemptRepo.findOne({ where: { recipientId: attempt.recipientId }, order: { attemptNumber: 'DESC' } });
          const nextAttemptNumber = (ultimoAttempt?.attemptNumber ?? attempt.attemptNumber) + 1;
          const protoAttempt = ultimoAttempt?.protocolNumber ? ultimoAttempt : (attempt.protocolNumber ? attempt : null);

          const nuovoAttempt = this.attemptRepo.create({
            recipientId: attempt.recipientId,
            channelType: attempt.channelType,
            status: AttemptStatus.SUCCESS,
            attemptNumber: nextAttemptNumber,
            sentAt: new Date(),
            postalTrackingId: nuovoIdPro,
            postalStatus: statoNuovo?.stato ?? null,
            postalStatusUpdatedAt: statoNuovo ? new Date() : null,
            protocolNumber: protoAttempt?.protocolNumber ?? null,
            protocolYear: protoAttempt?.protocolYear ?? null,
            protocolledAt: protoAttempt?.protocolledAt ?? null,
            postalStatusHistory: statoNuovo ? [{
              stato: statoNuovo.stato,
              rilevatoIl: new Date().toISOString(),
              ...(statoNuovo.statoConsegna ? { statoConsegna: statoNuovo.statoConsegna } : {}),
              ...(statoNuovo.codiceConsegna !== null && statoNuovo.codiceConsegna !== undefined ? { codiceConsegna: statoNuovo.codiceConsegna } : {}),
            }] : null,
            postalDeliveryStatus: statoNuovo?.statoConsegna ?? null,
            postalDeliveryCode: statoNuovo?.codiceConsegna ?? null,
            postalDeliveryDate: statoNuovo?.dataConsegna ? new Date(statoNuovo.dataConsegna) : null,
            postalAcceptanceId: statoNuovo?.idAccettazione ?? null,
            costCents: statoNuovo?.costoNetto != null ? Math.round(statoNuovo.costoNetto * 100) : null,
            costCalculatedAt: statoNuovo?.costoNetto != null ? new Date() : null,
            costBreakdown: statoNuovo?.costoNetto != null ? {
              costoNetto: statoNuovo.costoNetto,
              numeroPagine: statoNuovo.numeroPagine ?? null,
              nazionale: statoNuovo.nazionale ?? null,
              importoPostaleNetto: statoNuovo.importoPostaleNetto ?? null,
              importoStampaNetto: statoNuovo.importoStampaNetto ?? null,
              importoARNetto: statoNuovo.importoARNetto ?? null,
              tipoDocumento: statoNuovo.tipoDocumento ?? null,
              codiceContratto: statoNuovo.codiceContratto ?? null,
            } : null,
          });
          await this.attemptRepo.save(nuovoAttempt);
          this.logger.log(`Riaccodamento rilevato: attempt ${attempt.id} IDPRO ${attempt.postalTrackingId} -> ${nuovoIdPro}, creato nuovo attempt attemptNumber=${nextAttemptNumber}`);
        }
      }
      attempt.postalRequeueCheckedAt = new Date();
    } catch (err: any) {
      this.logger.warn(`Errore controllo riaccodamento per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
    }
  }

  /**
   * Ricontrollo manuale su richiesta operatore — bypassa il filtro
   * TERMINAL_STATUSES del cron. Serve per il caso reale: raccomandata in
   * `Errore` (terminale per noi, mai più ripollata automaticamente una volta
   * che cost_cents è già valorizzato) ma corretta manualmente sul portale
   * GlobalCom — nessun demone la riprende in carico da sola. Se il nuovo
   * stato letto qui non è più terminale (es. torna a `Confermato`), il
   * prossimo giro di `handleCron` la ritrova da solo (il suo filtro esclude
   * solo `postal_status IN (terminal) AND cost_cents IS NOT NULL`) — nessun
   * flag di "riattivazione" separato necessario.
   */
  async refreshOne(attemptId: string): Promise<{ changed: boolean; postalStatus: string | null }> {
    const attempt = await this.attemptRepo.findOneBy({ id: attemptId });
    if (!attempt) throw new NotFoundException(`Attempt ${attemptId} non trovato`);
    if (attempt.channelType !== 'POSTAL' || !attempt.postalTrackingId) {
      throw new BadRequestException('Attempt non POSTAL o senza IDPRO GlobalCom — nessuno stato da interrogare');
    }

    const provider = await this.providers.getActive();
    if (!provider) throw new BadRequestException('Nessun provider di postalizzazione attivo');

    const changed = await this.syncOne(attempt, provider.creds, { forceRequeueCheck: true });
    return { changed, postalStatus: attempt.postalStatus };
  }


  /**
   * Reset di massa per una campagna: caso reale — una raccomandata `Errore`
   * viene corretta a mano sul portale GlobalCom (mai tramite un nostro
   * retry), il cron non la ripolla più da sola perché è già a stato
   * terminale con costo calcolato (stesso motivo di `refreshOne`). Qui non
   * interroghiamo GlobalCom direttamente (nessuna chiamata SOAP, solo un
   * update DB) — resettiamo `postal_status` a NULL per farla rientrare nel
   * filtro di `handleCron`, che la ripesca e la ricontrolla per davvero al
   * giro successivo (entro un minuto). Esclude deliberatamente gli attempt
   * senza `postal_tracking_id`: quelli non sono mai arrivati a GlobalCom
   * (es. dedup fittizio pre-fix, vedi postal.strategy.ts) — non c'è nulla
   * da "ricontrollare" lì, serve un vero reinvio (Correggi indirizzo e
   * rimetti in coda), non un reset di stato.
   */
  async resetErrorsForRecheck(campaignId: string): Promise<{ resetCount: number }> {
    const candidates = await this.attemptRepo
      .createQueryBuilder('attempt')
      .innerJoin('attempt.recipient', 'r')
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere("attempt.postal_tracking_id IS NOT NULL AND attempt.postal_tracking_id != ''")
      .andWhere('attempt.postal_status = :errore', { errore: 'Errore' })
      .select(['attempt.id'])
      .getMany();

    if (candidates.length === 0) return { resetCount: 0 };

    await this.attemptRepo.update({ id: In(candidates.map((a) => a.id)) }, { postalStatus: null });
    return { resetCount: candidates.length };
  }
}
