import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum RemoteSignJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity('remote_sign_jobs')
@Index('IDX_remote_sign_jobs_campaign', ['campaignId', 'createdAt'])
export class RemoteSignJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ type: 'varchar', default: RemoteSignJobStatus.QUEUED })
  status!: RemoteSignJobStatus;

  @Column({ name: 'total_files', type: 'int', default: 0 })
  totalFiles!: number;

  @Column({ name: 'signed_count', type: 'int', default: 0 })
  signedCount!: number;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount!: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'error_kind', type: 'varchar', length: 20, nullable: true })
  errorKind!: string | null;

  @Column({ type: 'varchar', length: 255 })
  operator!: string;

  @Column({ name: 'signer_cn', type: 'varchar', length: 255, nullable: true })
  signerCn!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
