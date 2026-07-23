import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

// Cache username -> display name, aggiornata a ogni login LDAP riuscito
// (vedi AuthService.loginWithLdap). Permette di risolvere lato UI un nome
// leggibile per operatori diversi da quello loggato (es. Campaign.createdBy)
// senza dover ri-interrogare LDAP per ogni render — resta fresca quanto
// l'ultimo login di quell'operatore, con fallback allo username grezzo per
// account mai loggati dopo l'introduzione di questa tabella.
@Entity('operator_directory')
export class OperatorDirectoryEntry {
  @PrimaryColumn({ length: 255 })
  username!: string;

  @Column({ name: 'display_name', length: 255 })
  displayName!: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
