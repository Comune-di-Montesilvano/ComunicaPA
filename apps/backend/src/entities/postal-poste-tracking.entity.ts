import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { NotificationAttempt } from './notification-attempt.entity.js';

export type PosteTrackingStatus = 'pending' | 'delivered' | 'returned' | 'gave_up';

/** Movimento normalizzato dalla `listaMovimenti` di poste.it (dataOra epoch ms → ISO). */
export interface PosteTrackingMovement {
  at: string;
  luogo: string;
  statoLavorazione: string;
  box: string;
  flagRitorno: boolean;
}

/**
 * Verifica consegna su tracking Poste Italiane per un attempt POSTAL che
 * GlobalCom ha chiuso come `NonConsegnato` (GlobalCom smette di tracciare
 * al primo KO, Poste può consegnare giorni dopo). Una riga per attempt,
 * mai scritti i campi postal_* GlobalCom — vedi
 * docs/superpowers/specs/2026-09-24-postal-verifica-poste-design.md.
 */
@Entity('postal_poste_tracking')
@Index('IDX_postal_poste_tracking_status_next', ['status', 'nextCheckAt'])
export class PostalPosteTracking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'attempt_id', type: 'uuid', unique: true })
  attemptId!: string;

  @OneToOne(() => NotificationAttempt, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt?: NotificationAttempt;

  @Column({ name: 'tracking_code', type: 'varchar', length: 50 })
  trackingCode!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: PosteTrackingStatus;

  /** Solo controlli del cron con risposta valida: errori di rete e controlli manuali esclusi. */
  @Column({ name: 'check_count', type: 'int', default: 0 })
  checkCount!: number;

  @Column({ name: 'next_check_at', type: 'timestamptz', nullable: true })
  nextCheckAt!: Date | null;

  /** Aggiornato a OGNI tentativo, anche su errore (round-robin anti-starvation). */
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ name: 'poste_stato', type: 'varchar', length: 10, nullable: true })
  posteStato!: string | null;

  @Column({ name: 'poste_esito_ricerca', type: 'varchar', length: 10, nullable: true })
  posteEsitoRicerca!: string | null;

  @Column({ name: 'poste_product', type: 'varchar', length: 100, nullable: true })
  posteProduct!: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  /** Data esito Poste (consegna O ritorno al mittente) = data dell'ultimo movimento. */
  @Column({ name: 'outcome_at', type: 'timestamptz', nullable: true })
  outcomeAt!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  movements!: PosteTrackingMovement[] | null;

  @Column({ name: 'last_response', type: 'jsonb', nullable: true })
  lastResponse!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
