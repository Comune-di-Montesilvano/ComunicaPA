import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Campaign } from './campaign.entity';
import type { NotificationAttempt } from './notification-attempt.entity';

export enum RecipientStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('recipients')
export class Recipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'campaign_id' })
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Campaign', 'recipients', { onDelete: 'CASCADE' })
  campaign!: Campaign;

  @OneToMany('NotificationAttempt', 'recipient')
  attempts!: NotificationAttempt[];
}
