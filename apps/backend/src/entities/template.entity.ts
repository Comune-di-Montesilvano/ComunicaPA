import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type TemplateType = 'MAIL' | 'APP_IO';

@Entity('templates')
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 10 })
  type!: TemplateType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  subject!: string;

  /** Popolato solo per type='MAIL' — HTML prodotto dall'editor Tiptap. */
  @Column({ name: 'body_html', type: 'text', default: '' })
  bodyHtml!: string;

  /** Popolato solo per type='APP_IO' — Markdown secondo le regole App IO. */
  @Column({ name: 'body_markdown', type: 'text', default: '' })
  bodyMarkdown!: string;

  @Column({ name: 'paired_template_id', type: 'uuid', nullable: true })
  pairedTemplateId!: string | null;

  @ManyToOne('Template', { nullable: true, onDelete: 'SET NULL' })
  pairedTemplate!: Template | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
