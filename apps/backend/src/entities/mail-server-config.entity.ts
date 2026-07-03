import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MailServerType = 'EMAIL' | 'PEC';

@Entity('mail_server_configs')
export class MailServerConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 8 })
  type!: MailServerType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @Column({ type: 'int', default: 587 })
  port!: number;

  @Column({ type: 'boolean', default: false })
  secure!: boolean;

  /** false = server SMTP senza autenticazione (username/password ignorati). */
  @Column({ name: 'auth_enabled', type: 'boolean', default: true })
  authEnabled!: boolean;

  @Column({ type: 'varchar', length: 255, default: '' })
  username!: string;

  /** Password cifrata AES-256-GCM (stessa chiave derivata dei settings). */
  @Column({ name: 'password_enc', type: 'text', default: '' })
  passwordEnc!: string;

  @Column({ name: 'from_address', type: 'varchar', length: 255 })
  fromAddress!: string;

  /** Throttling: max invii per finestra. */
  @Column({ name: 'batch_size', type: 'int', default: 100 })
  batchSize!: number;

  /** Throttling: durata finestra in secondi. */
  @Column({ name: 'batch_interval_seconds', type: 'int', default: 60 })
  batchIntervalSeconds!: number;

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
