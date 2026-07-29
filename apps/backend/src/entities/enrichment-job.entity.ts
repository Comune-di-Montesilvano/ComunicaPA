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

// "Crea bozza campagna" sposta unzip (fino a centinaia di MB) + scrittura di
// migliaia di PDF su un job BullMQ dedicato — farlo dentro la richiesta HTTP
// blocca l'event loop Node abbastanza a lungo da far scattare il timeout del
// reverse proxy esterno (bug reale: "Unexpected token '<'" sul frontend,
// corpo della risposta 500 sostituito dalla pagina HTML del proxy) E, essendo
// Node single-thread, affama nel frattempo QUALUNQUE altra richiesta
// concorrente (osservato: 403 su /admin/settings scollegato, in corso nello
// stesso momento). Stato distinto da EnrichmentJobStatus (già DONE quando la
// conversione viene richiesta).
export enum CampaignConversionStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
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

  @Column({ name: 'search_payments', type: 'boolean', default: true })
  searchPayments!: boolean;

  @Column({ name: 'source_filename', type: 'varchar', length: 512 })
  sourceFilename!: string;

  @Column({ name: 'total_records', type: 'int', default: 0 })
  totalRecords!: number;

  @Column({ name: 'processed_records', type: 'int', default: 0 })
  processedRecords!: number;

  @Column({ name: 'checkpoint_row', type: 'int', default: 0 })
  checkpointRow!: number;

  @Column({ name: 'warning_count', type: 'int', default: 0 })
  warningCount!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  warnings!: EnrichmentWarning[];

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  /** Valorizzato quando il job è stato convertito in bozza campagna (file già eliminati). */
  @Column({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId!: string | null;

  @Column({ name: 'campaign_conversion_status', type: 'enum', enum: CampaignConversionStatus, nullable: true })
  campaignConversionStatus!: CampaignConversionStatus | null;

  @Column({ name: 'campaign_conversion_error', type: 'text', nullable: true })
  campaignConversionError!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 256 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
