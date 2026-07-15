import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Recipient } from './recipient.entity';

export enum AttemptStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('notification_attempts')
export class NotificationAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'recipient_id' })
  recipientId!: string;

  @Column({ name: 'channel_type', length: 20 })
  channelType!: string;

  @Column({
    type: 'enum',
    enum: AttemptStatus,
    default: AttemptStatus.QUEUED,
  })
  status!: AttemptStatus;

  @Column({ name: 'attempt_number', default: 1 })
  attemptNumber!: number;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ type: 'jsonb', name: 'response_payload', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 26, nullable: true })
  iun!: string | null;

  @Column({ name: 'send_status', type: 'varchar', length: 30, nullable: true })
  sendStatus!: string | null;

  @Column({ name: 'send_status_updated_at', type: 'timestamptz', nullable: true })
  sendStatusUpdatedAt!: Date | null;

  @Column({ type: 'int', name: 'protocol_number', nullable: true })
  protocolNumber!: number | null;

  @Column({ type: 'int', name: 'protocol_year', nullable: true })
  protocolYear!: number | null;

  @Column({ name: 'protocolled_at', type: 'timestamptz', nullable: true })
  protocolledAt!: Date | null;

  // Allegati SEND già caricati su PN (key/versionToken/sha256 per docIdx),
  // scritti man mano durante il loop di upload — un retry (nuovo attempt,
  // vedi campaigns.service.ts#retryRecipient) può ereditare questo campo
  // dall'ultimo tentativo dello stesso destinatario ed evitare di ricaricare
  // documenti già presenti su PN.
  @Column({ type: 'jsonb', name: 'uploaded_documents', nullable: true })
  uploadedDocuments!: Array<{ docIdx: number; key: string; versionToken: string; sha256Base64: string }> | null;

  // Tracking consegna GlobalCom (canale POSTAL) — analogo a iun/sendStatus
  // per SEND, ma qui esiste un'operazione di poll dedicata (dettagli_documento)
  // verificata sul manuale tecnico ufficiale, vedi PostalStatusSyncService.
  @Column({ name: 'postal_tracking_id', type: 'varchar', length: 50, nullable: true })
  postalTrackingId!: string | null;

  @Column({ name: 'postal_status', type: 'varchar', length: 30, nullable: true })
  postalStatus!: string | null;

  @Column({ name: 'postal_status_updated_at', type: 'timestamptz', nullable: true })
  postalStatusUpdatedAt!: Date | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Recipient', 'attempts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;
}
