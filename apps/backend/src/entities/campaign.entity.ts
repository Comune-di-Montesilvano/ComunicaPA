import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { NotificationChannel } from '@comunicapa/shared-types';
import type { Recipient } from './recipient.entity';

export enum CampaignStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('campaigns')
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: CampaignStatus,
    default: CampaignStatus.DRAFT,
  })
  status!: CampaignStatus;

  @Column({ type: 'varchar', name: 'channel_type', length: 20 })
  channelType!: NotificationChannel;

  @Column({ type: 'jsonb', name: 'channel_config', default: {} })
  channelConfig!: Record<string, unknown>;

  @Column({ type: 'int', name: 'retention_days', nullable: true })
  retentionDays!: number | null;

  @Column({ name: 'created_by', length: 255 })
  createdBy!: string;

  @Column({ name: 'total_recipients', default: 0 })
  totalRecipients!: number;

  @Column({ name: 'sent_count', default: 0 })
  sentCount!: number;

  @Column({ name: 'failed_count', default: 0 })
  failedCount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @OneToMany('Recipient', 'campaign')
  recipients!: Recipient[];
}
