// apps/backend/src/entities/notification-review.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { Recipient } from './recipient.entity.js';
import type { LegalAttentionAction, LegalAttentionKind } from '../legal-attention/legal-attention.util.js';

/**
 * Presa visione / posticipo di una notifica senza esito legale. Storico
 * append-only: una riga per azione, mai update. Vale l'ultima riga per
 * (recipient_id, kind): una presa visione su "ferma" non copre un successivo
 * "bloccante".
 */
@Entity('notification_reviews')
@Index('IDX_notification_reviews_recipient_kind', ['recipientId', 'kind', 'createdAt'])
export class NotificationReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'recipient_id' })
  recipientId!: string;

  @ManyToOne('Recipient', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;

  @Index('IDX_notification_reviews_campaign')
  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ type: 'varchar', length: 10 })
  kind!: LegalAttentionKind;

  @Column({ type: 'varchar', length: 10 })
  action!: LegalAttentionAction;

  @Column({ name: 'snoozed_until', type: 'timestamptz', nullable: true })
  snoozedUntil!: Date | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', length: 255 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
