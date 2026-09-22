import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum DomicileVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export interface DomicileInadBatch {
  id: string;
  size: number;
  done: boolean;
}

@Entity('domicile_verification_jobs')
export class DomicileVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: DomicileVerificationJobStatus,
    default: DomicileVerificationJobStatus.QUEUED,
  })
  status!: DomicileVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  /** Contenuto raw del CSV caricato, riparsato a completamento per costruire i 5 CSV risultato. */
  @Column({ name: 'source_csv', type: 'text' })
  sourceCsv!: string;

  @Column({ name: 'csv_headers', type: 'jsonb' })
  csvHeaders!: string[];

  @Column({ name: 'cf_column', type: 'varchar', length: 256 })
  cfColumn!: string;

  @Column({ name: 'has_headers', type: 'boolean', default: true })
  hasHeaders!: boolean;

  @Column({ name: 'io_service_id', type: 'uuid' })
  ioServiceId!: string;

  @Column({ name: 'cf_fisico_total', type: 'int', default: 0 })
  cfFisicoTotal!: number;

  @Column({ name: 'piva_total', type: 'int', default: 0 })
  pivaTotal!: number;

  /** Un elemento per ogni chiamata POST /listDigitalAddress (max 1000 CF ciascuna). */
  @Column({ name: 'inad_batches', type: 'jsonb', default: [] })
  inadBatches!: DomicileInadBatch[];

  /** true dopo che i risultati dei batch INAD sono stati fetchati una volta (evita ri-fetch ad ogni tick cron). */
  @Column({ name: 'inad_fetched', type: 'boolean', default: false })
  inadFetched!: boolean;

  /** Chiave = CF fisico, valore = domicilio digitale INAD trovato (solo entry "found"). */
  @Column({ name: 'inad_found_map', type: 'jsonb', default: {} })
  inadFoundMap!: Record<string, string>;

  /** true quando il job App IO (singolo, sull'intero CSV) ha scritto il suo esito finale. */
  @Column({ name: 'app_io_done', type: 'boolean', default: false })
  appIoDone!: boolean;

  @Column({ name: 'app_io_processed_rows', type: 'int', default: 0 })
  appIoProcessedRows!: number;

  @Column({ name: 'app_io_present_count', type: 'int', default: 0 })
  appIoPresentCount!: number;

  @Column({ name: 'app_io_absent_count', type: 'int', default: 0 })
  appIoAbsentCount!: number;

  /** Chiave = CF fisico (16 char), valore = presente su App IO — solo per CF effettivamente verificati. */
  @Column({ name: 'app_io_results', type: 'jsonb', default: {} })
  appIoResults!: Record<string, boolean>;

  @Column({ name: 'registro_imprese_total', type: 'int', default: 0 })
  registroImpreseTotal!: number;

  @Column({ name: 'registro_imprese_done', type: 'int', default: 0 })
  registroImpreseDone!: number;

  @Column({ name: 'registro_imprese_found_count', type: 'int', default: 0 })
  registroImpreseFoundCount!: number;

  /**
   * Chiave = CF/PIVA, valore = PEC trovata o null se non trovata. Scritto
   * SEMPRE con una UPDATE SQL raw che concatena jsonb (mai un
   * read-modify-write) — job PIVA/CF-residuo paralleli sullo stesso
   * DomicileVerificationJob altrimenti perderebbero scritture in race
   * (stesso pattern già in uso su inad_verification_jobs.piva_results).
   */
  @Column({ name: 'registro_imprese_results', type: 'jsonb', default: {} })
  registroImpreseResults!: Record<string, string | null>;

  /** true dopo che il fallback CF-fisici-non-trovati-INAD è stato accodato su Registro Imprese (una sola volta). */
  @Column({ name: 'residual_enqueued', type: 'boolean', default: false })
  residualEnqueued!: boolean;

  @Column({ name: 'result_assenti_csv', type: 'text', nullable: true })
  resultAssentiCsv!: string | null;

  @Column({ name: 'result_app_io_csv', type: 'text', nullable: true })
  resultAppIoCsv!: string | null;

  @Column({ name: 'result_inad_csv', type: 'text', nullable: true })
  resultInadCsv!: string | null;

  @Column({ name: 'result_registro_imprese_csv', type: 'text', nullable: true })
  resultRegistroImpreseCsv!: string | null;

  @Column({ name: 'result_aggregato_csv', type: 'text', nullable: true })
  resultAggregatoCsv!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
