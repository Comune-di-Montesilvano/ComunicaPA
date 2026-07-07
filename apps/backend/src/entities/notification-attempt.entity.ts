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

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne('Recipient', 'attempts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;
}
