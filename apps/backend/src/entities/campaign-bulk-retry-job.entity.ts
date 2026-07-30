import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum CampaignBulkRetryJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export interface CampaignBulkRetryFailure {
  recipientId: string;
  reason: string;
}

@Entity('campaign_bulk_retry_jobs')
export class CampaignBulkRetryJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @Column({
    type: 'enum',
    enum: CampaignBulkRetryJobStatus,
    default: CampaignBulkRetryJobStatus.QUEUED,
  })
  status!: CampaignBulkRetryJobStatus;

  @Column({ name: 'recipient_ids', type: 'jsonb' })
  recipientIds!: string[];

  @Column({ name: 'total_count', type: 'int', default: 0 })
  totalCount!: number;

  @Column({ name: 'processed_count', type: 'int', default: 0 })
  processedCount!: number;

  @Column({ name: 'requeued_count', type: 'int', default: 0 })
  requeuedCount!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  failed!: CampaignBulkRetryFailure[];

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 256 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
