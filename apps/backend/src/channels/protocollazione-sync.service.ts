import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';
import { splitFullName } from './send/name.util';

const BATCH_SIZE = 200;

/**
 * Demone generico (non SEND-specifico): protocolla qualunque NotificationAttempt
 * la cui campagna richiede protocollazione (channelConfig.protocolla=true),
 * a prescindere dal canale — pronto per altri canali futuri, non solo SEND.
 */
@Injectable()
export class ProtocollazioneSyncService {
  private readonly logger = new Logger(ProtocollazioneSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
  ) {}

  @Cron('*/2 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .leftJoinAndSelect('attempt.recipient', 'recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('attempt.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('attempt.protocolled_at IS NULL')
      .andWhere("campaign.channel_config ->> 'protocolla' = 'true'")
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    for (const attempt of attempts) {
      try {
        const recipient = attempt.recipient;
        const campaign = recipient.campaign;
        const cfg = campaign.channelConfig as Record<string, unknown>;
        const subject = (cfg['subject'] as string) ?? campaign.name;
        const { nome, cognome } = splitFullName(recipient.fullName);
        const buffer = await this.attachments.generatePdfBuffer(recipient, 0);
        const result = await this.protocollo.protocolla({
          oggetto: subject,
          destinatario: {
            codiceFiscale: recipient.codiceFiscale,
            nome,
            cognome,
            denominazione: recipient.fullName ?? recipient.codiceFiscale,
          },
          documentBuffer: buffer,
          documentFilename: `${recipient.codiceFiscale}.pdf`,
        });
        attempt.protocolNumber = result.numeroProtocollo;
        attempt.protocolYear = result.annoProtocollo;
        attempt.protocolledAt = new Date();
        await this.attemptRepo.save(attempt);
        this.logger.log(`Attempt ${attempt.id} protocollato: ${result.numeroProtocollo}/${result.annoProtocollo}`);
      } catch (err: any) {
        this.logger.warn(`Protocollazione fallita per attempt ${attempt.id}: ${err.message}`);
        // Resta QUEUED con protocolledAt=null: ritentato al prossimo giro.
      }
    }
  }
}
