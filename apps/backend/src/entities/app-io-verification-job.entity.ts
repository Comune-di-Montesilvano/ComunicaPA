import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AppIoVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity('app_io_verification_jobs')
export class AppIoVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: AppIoVerificationJobStatus,
    default: AppIoVerificationJobStatus.QUEUED,
  })
  status!: AppIoVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  @Column({ name: 'processed_rows', type: 'int', default: 0 })
  processedRows!: number;

  @Column({ name: 'present_count', type: 'int', default: 0 })
  presentCount!: number;

  @Column({ name: 'absent_count', type: 'int', default: 0 })
  absentCount!: number;

  /** Contenuto raw del CSV caricato, riparsato dal processor all'avvio del job. */
  @Column({ name: 'source_csv', type: 'text' })
  sourceCsv!: string;

  @Column({ name: 'csv_headers', type: 'jsonb' })
  csvHeaders!: string[];

  @Column({ name: 'cf_column', type: 'varchar', length: 256 })
  cfColumn!: string;

  @Column({ name: 'has_headers', type: 'boolean', default: true })
  hasHeaders!: boolean;

  @Column({ name: 'io_service_id', type: 'uuid' })
  ioServiceId!: string;

  @Column({ name: 'result_present_csv', type: 'text', nullable: true })
  resultPresentCsv!: string | null;

  @Column({ name: 'result_absent_csv', type: 'text', nullable: true })
  resultAbsentCsv!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
