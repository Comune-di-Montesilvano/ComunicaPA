import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Elenco utenti 'user' abilitati ad avviare campagne POSTAL (oltre agli
 * admin, sempre autorizzati). Nessun campo ruolo: la presenza della riga
 * = autorizzato. username normalizzato lowercase/trim in
 * PostalAuthorizedUsersService — deve combaciare con
 * JwtOperatorPayload.username al momento del check in launch().
 */
@Entity('postal_authorized_users')
export class PostalAuthorizedUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  username!: string;

  @Column({ name: 'added_by', type: 'varchar', length: 255 })
  addedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
