import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum EnrichmentJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export enum TraceFormat {
  MAGGIOLI = 'MAGGIOLI',
}

export interface EnrichmentWarning {
  row: number;
  pdf: string;
  message: string;
}

@Entity('enrichment_jobs')
export class EnrichmentJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: EnrichmentJobStatus,
    default: EnrichmentJobStatus.QUEUED,
  })
  status!: EnrichmentJobStatus;

  @Column({ name: 'trace_format', type: 'enum', enum: TraceFormat })
  traceFormat!: TraceFormat;

  @Column({ name: 'source_filename', type: 'varchar', length: 512 })
  sourceFilename!: string;

  @Column({ name: 'total_records', type: 'int', default: 0 })
  totalRecords!: number;

  @Column({ name: 'processed_records', type: 'int', default: 0 })
  processedRecords!: number;

  @Column({ name: 'warning_count', type: 'int', default: 0 })
  warningCount!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  warnings!: EnrichmentWarning[];

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  /** Valorizzato quando il job è stato convertito in bozza campagna (file già eliminati). */
  @Column({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 256 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
