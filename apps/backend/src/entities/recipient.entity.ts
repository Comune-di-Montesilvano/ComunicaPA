import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Campaign } from './campaign.entity.js';
import type { NotificationAttempt } from './notification-attempt.entity.js';

export enum RecipientStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
  /** Campagna PEC, PIVA (Registro Imprese) con PEC trovata diversa da quella su file — invio bloccato finché l'operatore non decide quale usare (vedi resolvePecReview). */
  PENDING_REVIEW = 'pending_review',
}

@Entity('recipients')
export class Recipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ name: 'codice_fiscale', length: 16 })
  codiceFiscale!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  pec!: string | null;

  @Column({ type: 'varchar', name: 'full_name', length: 255, nullable: true })
  fullName!: string | null;

  @Column({ type: 'jsonb', name: 'extra_data', default: {} })
  extraData!: Record<string, unknown>;

  @Column({ type: 'jsonb', name: 'inad_check', nullable: true })
  inadCheck!: {
    found: boolean;
    /** true solo se found e l'indirizzo trovato differisce da quello già configurato (vero dirottamento, non un domicilio PEC coincidente). */
    diverted: boolean;
    originalChannel: string | null;
    originalAddress: string | null;
    /**
     * PEC trovata da Registro Imprese non ancora applicata — valorizzato SOLO
     * per campagne PEC su PIVA con diverted:true (status PENDING_REVIEW):
     * qui NON si sovrascrive mai recipient.pec in automatico, a differenza di
     * INAD/switch-canale. Vedi resolvePecReview.
     */
    foundAddress?: string | null;
    checkedAt: string;
  } | null;

  @Column({ type: 'jsonb', name: 'signature_check', nullable: true })
  signatureCheck!: {
    valid: boolean;
    reason: string | null;
    checkedAt: string;
  } | null;

  @Column({
    type: 'enum',
    enum: RecipientStatus,
    default: RecipientStatus.PENDING,
  })
  status!: RecipientStatus;

  @Column({ type: 'int', name: 'download_count', default: 0 })
  downloadCount!: number;

  @Column({ type: 'timestamptz', name: 'first_downloaded_at', nullable: true })
  firstDownloadedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'last_downloaded_at', nullable: true })
  lastDownloadedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'attachment_expires_at', nullable: true })
  attachmentExpiresAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'attachment_deleted_at', nullable: true })
  attachmentDeletedAt!: Date | null;

  // Firma del contenuto (subject/body TEMPLATE campagna, JSON.stringify)
  // dell'ultimo "Rimanda con contenuto corretto" riuscito per questo
  // destinatario (CampaignContentCorrectionService.resendSafe). Vive qui e
  // non su NotificationAttempt.responsePayload perché NotificationProcessor
  // rimpiazza sempre l'intero responsePayload quando il job del resend
  // completa — su Recipient sopravvive, indispensabile per l'idempotenza
  // quando lo stesso destinatario compare in due categorie sovrapposte
  // dell'UI (es. "Dirottato INAD" + "App IO parallela").
  @Column({ type: 'varchar', length: 512, name: 'last_content_resend_signature', nullable: true })
  lastContentResendSignature!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Campaign', 'recipients', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: Campaign;

  @OneToMany('NotificationAttempt', 'recipient')
  attempts!: NotificationAttempt[];
}
