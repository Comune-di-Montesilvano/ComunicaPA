import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('enrichment_address_overrides')
@Index(['jobId', 'pdfFilename'], { unique: true })
export class EnrichmentAddressOverride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  // Nessun override deve sopravvivere al job che corregge — senza questa FK
  // (aggiunta solo con AddEnrichmentAddressOverridesJobFk1785900000000,
  // dopo la creazione della tabella) deleteJob()/retention/
  // createCampaignFromJob() eliminavano il job e i suoi file ma mai queste
  // righe, orfane a vita (bug reale trovato in review finale whole-branch).
  @ManyToOne('EnrichmentJob', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: unknown;

  @Column({ name: 'pdf_filename', type: 'varchar', length: 512 })
  pdfFilename!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  indirizzo!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  cap!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  comune!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  provincia!: string | null;

  @Column({ name: 'stato_estero', type: 'varchar', length: 256, nullable: true })
  statoEstero!: string | null;

  // Override per qualunque colonna CSV oltre alle 5 tipizzate sopra (numero_avviso,
  // importo, scadenza, rataN_*, tipo, pec, nominativo...) — caso PDF illeggibile,
  // nessun dato estratto: l'operatore deve poter compilare tutto a mano, non solo
  // l'indirizzo. jsonb libero perché le colonne rataN_* sono dinamiche per job.
  @Column({ name: 'extra_fields', type: 'jsonb', nullable: true })
  extraFields!: Record<string, string> | null;

  // Nullable: una riga può esistere solo per un dismiss (nessuna correzione
  // dati), vedi `dismissed` sotto — in quel caso non c'è un "correttore".
  @Column({ name: 'corrected_by', type: 'varchar', length: 256, nullable: true })
  correctedBy!: string | null;

  @CreateDateColumn({ name: 'corrected_at' })
  correctedAt!: Date;

  // Avviso "smarcato" dall'operatore senza modificare alcun dato (es. un
  // falso positivo — "PagoPA mancante" ma la riga non ha davvero un PagoPA
  // da notificare). Stessa riga/chiave (jobId+pdfFilename) di una eventuale
  // correzione: upsert parziale, i due concetti coesistono senza conflitto.
  @Column({ type: 'boolean', default: false })
  dismissed!: boolean;

  @Column({ name: 'dismissed_by', type: 'varchar', length: 256, nullable: true })
  dismissedBy!: string | null;

  @Column({ name: 'dismissed_at', type: 'timestamptz', nullable: true })
  dismissedAt!: Date | null;
}
