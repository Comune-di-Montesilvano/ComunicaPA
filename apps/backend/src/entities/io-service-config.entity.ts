import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('io_service_configs')
export class IoServiceConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  nome!: string;

  @Column({ name: 'id_service', type: 'varchar', length: 64 })
  idService!: string;

  @Column({ type: 'text', default: '' })
  descrizione!: string;

  /** Cifrata AES-256-GCM, stessa chiave derivata dei settings/mail-configs. */
  @Column({ name: 'api_key_primaria_enc', type: 'text', default: '' })
  apiKeyPrimariaEnc!: string;

  @Column({ name: 'api_key_secondaria_enc', type: 'text', default: '' })
  apiKeySecondariaEnc!: string;

  @Column({ name: 'codice_catalogo', type: 'varchar', length: 32, default: '' })
  codiceCatalogo!: string;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ name: 'tested_at', type: 'timestamptz', nullable: true })
  testedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
