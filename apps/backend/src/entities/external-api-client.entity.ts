import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('external_api_clients')
export class ExternalApiClient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'varchar', name: 'api_key_hash', length: 64, unique: true })
  apiKeyHash!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt!: Date | null;
}
