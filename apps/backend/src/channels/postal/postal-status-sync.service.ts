import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { PostalProvidersService } from '../../postal-providers/postal-providers.service';
import { GlobalComClient } from './globalcom-client.service';

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

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      .andWhere('(attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal) OR attempt.cost_cents IS NULL)', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;

    const provider = await this.providers.getActive();
    if (!provider) return;
    const creds = provider.creds;

    for (const attempt of attempts) {
      try {
        const stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
        if (!stato) continue;

        let changed = false;
        if (stato.stato !== attempt.postalStatus) {
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
              ...(stato.codiceErrore ? { codiceErrore: stato.codiceErrore } : {}),
              ...(stato.descrizione ? { descrizione: stato.descrizione } : {}),
            },
          ];
          changed = true;
        }
        if (attempt.costCents === null && stato.costoNetto !== null && stato.costoNetto !== undefined) {
          attempt.costCents = Math.round(stato.costoNetto * 100);
          attempt.costCalculatedAt = new Date();
          attempt.costBreakdown = {
            costoNetto: stato.costoNetto,
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
        if (changed) await this.attemptRepo.save(attempt);
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }
}
