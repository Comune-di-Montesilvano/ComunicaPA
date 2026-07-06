import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Recipient } from './recipient.entity';

/**
 * Una riga per ogni download effettivo di un allegato, qualunque canale
 * (link firmato email/PEC/App IO, o portale cittadino autenticato). Fonte di
 * verità per le statistiche per canale — si aggiunge ai contatori esistenti
 * su Recipient/extraData, non li sostituisce (retrocompatibilità UI).
 */
@Entity('download_events')
export class DownloadEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'recipient_id' })
  recipientId!: string;

  @Column({ length: 20 })
  channel!: string;

  @Column({ name: 'attachment_index', default: 0 })
  attachmentIndex!: number;

  @CreateDateColumn({ name: 'downloaded_at' })
  downloadedAt!: Date;

  @ManyToOne('Recipient', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;
}
