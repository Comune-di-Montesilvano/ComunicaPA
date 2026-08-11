import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum InadVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export interface InadVerificationBatch {
  id: string;
  size: number;
  done: boolean;
}

@Entity('inad_verification_jobs')
export class InadVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: InadVerificationJobStatus,
    default: InadVerificationJobStatus.QUEUED,
  })
  status!: InadVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  /** Un elemento per ogni chiamata POST /listDigitalAddress (max 1000 CF ciascuna). */
  @Column({ name: 'batches', type: 'jsonb' })
  batches!: InadVerificationBatch[];

  @Column({ name: 'found_count', type: 'int', default: 0 })
  foundCount!: number;

  @Column({ name: 'not_found_count', type: 'int', default: 0 })
  notFoundCount!: number;

  /** Totale Partite IVA da verificare via Registro Imprese per questo job (0 se il CSV non ne contiene). */
  @Column({ name: 'piva_total', type: 'int', default: 0 })
  pivaTotal!: number;

  /** Quante verifiche PIVA sono già state completate (aggiornato dal processor Registro Imprese). */
  @Column({ name: 'piva_done', type: 'int', default: 0 })
  pivaDone!: number;

  @Column({ name: 'piva_found_count', type: 'int', default: 0 })
  pivaFoundCount!: number;

  /**
   * Chiave = Partita IVA, valore = PEC trovata o null se non trovata.
   * Scritto SEMPRE con una UPDATE SQL raw che concatena jsonb (mai un
   * read-modify-write sull'intera colonna) — job PIVA paralleli sullo stesso
   * InadVerificationJob altrimenti perderebbero scritture in race.
   */
  @Column({ name: 'piva_results', type: 'jsonb', default: {} })
  pivaResults!: Record<string, string | null>;

  /** Contenuto raw del CSV caricato, riparsato al completamento per costruire i CSV di risultato. */
  @Column({ name: 'source_csv', type: 'text' })
  sourceCsv!: string;

  @Column({ name: 'csv_headers', type: 'jsonb' })
  csvHeaders!: string[];

  @Column({ name: 'cf_column', type: 'varchar', length: 256 })
  cfColumn!: string;

  @Column({ name: 'has_headers', type: 'boolean', default: true })
  hasHeaders!: boolean;

  @Column({ name: 'result_found_csv', type: 'text', nullable: true })
  resultFoundCsv!: string | null;

  @Column({ name: 'result_not_found_csv', type: 'text', nullable: true })
  resultNotFoundCsv!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
