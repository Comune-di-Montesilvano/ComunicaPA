import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Singola riga (sempre id fisso 'current'): cache della TSL-IT.xml
 * (ETSI TS 119612, certificati CA qualificate italiane). Refresh via
 * AgidTrustListService.refresh() (@Cron giornaliero) — se il fetch
 * fallisce si continua a usare questa cache (fail-open sulla
 * disponibilità del TSL, mai bloccare tutte le verifiche per un TSL
 * momentaneamente irraggiungibile).
 */
@Entity('agid_trust_list_cache')
export class AgidTrustListCache {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Certificati X.509 in PEM, uno per CA qualificata trovata nella TSL. */
  @Column({ type: 'jsonb', name: 'certificates_pem' })
  certificatesPem!: string[];

  @UpdateDateColumn({ name: 'fetched_at' })
  fetchedAt!: Date;
}
