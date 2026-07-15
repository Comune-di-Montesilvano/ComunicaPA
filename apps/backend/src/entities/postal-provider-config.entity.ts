import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Unico provider oggi; il campo type resta per estendibilità futura (altri gateway postali). */
export type PostalProviderType = 'GLOBALCOM';

@Entity('postal_provider_configs')
export class PostalProviderConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: PostalProviderType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ name: 'base_url', type: 'varchar', length: 255 })
  baseUrl!: string;

  @Column({ type: 'varchar', length: 255 })
  username!: string;

  /** Password cifrata AES-256-GCM (stessa chiave derivata dei settings). */
  @Column({ name: 'password_enc', type: 'text', default: '' })
  passwordEnc!: string;

  /** Gruppo utenza GlobalCom — "<DEFAULT>" per utenze "spare". */
  @Column({ type: 'varchar', length: 128, default: '' })
  group!: string;

  @Column({ name: 'centro_di_costo', type: 'varchar', length: 128, default: '' })
  centroDiCosto!: string;

  /** Mittente esplicito facoltativo: se denominazione1 è vuoto, si usa il mittente predefinito dell'utenza. */
  @Column({ name: 'mittente_denominazione1', type: 'varchar', length: 128, default: '' })
  mittenteDenominazione1!: string;

  @Column({ name: 'mittente_indirizzo1', type: 'varchar', length: 128, default: '' })
  mittenteIndirizzo1!: string;

  @Column({ name: 'mittente_cap', type: 'varchar', length: 10, default: '' })
  mittenteCap!: string;

  @Column({ name: 'mittente_citta', type: 'varchar', length: 128, default: '' })
  mittenteCitta!: string;

  @Column({ name: 'mittente_provincia', type: 'varchar', length: 2, default: '' })
  mittenteProvincia!: string;

  // Campi sotto: popolati automaticamente dal test (InformazioniUtenza),
  // MAI editabili manualmente da UI — audit reale dell'utenza, non
  // configurazione. Evita di far indovinare all'operatore quali servizi/
  // codici contratto sono abilitati (scoperto in test reale: un'utenza può
  // essere abilitata solo su varianti "Market"/"Contest", mai su Lettera/
  // Raccomandata standard, e i codici contratto sono specifici per utenza).

  /** ProdottiDisponibili da InformazioniUtenza — popola il dropdown del wizard campagna. */
  @Column({ name: 'enabled_service_types', type: 'jsonb', default: [] })
  enabledServiceTypes!: string[];

  /**
   * ContrattiH2H da InformazioniUtenza — codici contratto disponibili per i
   * Servizio che li richiedono (Market/Contest/Atto Giudiziario). Tipologia
   * usa nomi enum TipoContrattoSpeciale (es. "RaccomandataMarket"), da
   * confrontare con il prefisso del ServiceType scelto in campagna.
   */
  @Column({ type: 'jsonb', default: [] })
  contratti!: Array<{ codiceContratto: string; descrizione: string; tipologia: string }>;

  /** Data ultimo test riuscito. null = mai testata (non attivabile). */
  @Column({ name: 'tested_at', type: 'timestamptz', nullable: true })
  testedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
