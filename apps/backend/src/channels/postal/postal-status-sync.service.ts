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
      .andWhere('(attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal))', { terminal: TERMINAL_STATUSES })
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
        if (stato && stato.stato !== attempt.postalStatus) {
          attempt.postalStatus = stato.stato;
          attempt.postalStatusUpdatedAt = new Date();
          attempt.postalStatusHistory = [
            ...(attempt.postalStatusHistory ?? []),
            { stato: stato.stato, rilevatoIl: new Date().toISOString() },
          ];
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }
}
