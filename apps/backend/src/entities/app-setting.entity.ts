import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('app_settings')
export class AppSetting {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: string | number | boolean;

  @Column({ type: 'boolean', default: false })
  encrypted!: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'varchar', length: 128, nullable: true })
  updatedBy!: string | null;
}
