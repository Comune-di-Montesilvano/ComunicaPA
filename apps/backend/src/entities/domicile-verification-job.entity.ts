import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum DomicileVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
  /** Annullata dall'operatore durante l'elaborazione (nessun risultato). */
  CANCELLED = 'cancelled',
}

export interface DomicileInadBatch {
  id: string;
  size: number;
  done: boolean;
}

/**
 * Una richiesta di elaborazione massiva ANPR: 'id' = accertamento ID unico
 * nazionale (C030), 'vita' = verifica esistenza in vita (C007). File gzip
 * con i soli CF, esito asincrono (fino a 3 giorni) scaricato per
 * idOperazioneANPR.
 */
export interface DomicileAnprRequest {
  kind: 'id' | 'vita';
  /** idOperazioneANPR restituito dalla richiesta. */
  id: string;
  /** CF inviati in questa richiesta: l'esito vale solo per questi. */
  cfs: string[];
  done: boolean;
  /** ISO timestamp dell'ultimo tentativo di download (poll diradato). */
  lastPolledAt?: string;
  /** Ultima risposta "non pronto"/errore del download, per diagnosi. */
  lastResponse?: string;
  /**
   * Esito scaricato ma inattendibile (nessun CF riconosciuto): i CF della
   * richiesta restano "verifica ANPR non riuscita", mai "non presenti".
   */
  failed?: string;
}

/**
 * Esito Registro Imprese di un CF/PIVA. Campi di cessazione presenti solo se
 * il dettaglio ha `stato-impresa` (assente per le imprese attive).
 */
export interface RegistroImpreseOutcome {
  found: boolean;
  stato?: string;
  /** "DD/MM/YYYY" così come arriva dal Registro Imprese. */
  dtCancellazione?: string;
  causale?: string;
}

@Entity('domicile_verification_jobs')
@Index('IDX_domicile_verification_jobs_created_by', ['createdBy', 'createdAt']) // AddDomicileVerificationJobOwner
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

  /**
   * Chiave = CF/PIVA interrogato, valore = esito Registro Imprese (trovata,
   * ed eventuale cessazione). Distinto da registroImpreseResults (PEC o null),
   * dove null vale sia "non trovata" sia "trovata senza PEC". Stesso UPDATE
   * jsonb concat. Chiave assente = esito sconosciuto (errore/tentativi esauriti).
   */
  @Column({ name: 'registro_imprese_found_map', type: 'jsonb', default: {} })
  registroImpreseFoundMap!: Record<string, RegistroImpreseOutcome>;

  /** Verifica presenza CF in ANPR (C030) richiesta dall'operatore al caricamento. */
  @Column({ name: 'anpr_id_requested', type: 'boolean', default: false })
  anprIdRequested!: boolean;

  /** Verifica esistenza in vita (C007) richiesta dall'operatore al caricamento. */
  @Column({ name: 'anpr_vita_requested', type: 'boolean', default: false })
  anprVitaRequested!: boolean;

  @Column({ name: 'anpr_requests', type: 'jsonb', default: [] })
  anprRequests!: DomicileAnprRequest[];

  /**
   * Chiave = CF fisico verificato su ANPR, valore = presente in ANPR. Solo i
   * CF di richieste concluse: chiave assente = non verificato (saltato,
   * richiesta fallita), mai "non presente".
   */
  @Column({ name: 'anpr_results', type: 'jsonb', default: {} })
  anprResults!: Record<string, boolean>;

  /**
   * Chiave = CF fisico verificato con C007, valore = esistenza in vita S/N,
   * null = non presente in ANPR. Chiave assente = non verificato.
   */
  @Column({ name: 'anpr_vita_results', type: 'jsonb', default: {} })
  anprVitaResults!: Record<string, 'S' | 'N' | null>;

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

  /**
   * Username dell'operatore che ha caricato il tracciato: un 'user' vede e
   * cancella solo i propri job, un 'admin' tutti. null = job precedenti
   * all'introduzione del campo, visibili solo agli admin.
   */
  @Column({ name: 'created_by', type: 'varchar', length: 255, nullable: true })
  createdBy!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
