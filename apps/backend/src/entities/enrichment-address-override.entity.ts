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

  @Column({ name: 'corrected_by', type: 'varchar', length: 256 })
  correctedBy!: string;

  @CreateDateColumn({ name: 'corrected_at' })
  correctedAt!: Date;
}
