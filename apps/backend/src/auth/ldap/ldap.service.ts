import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ldapjs from 'ldapjs';
import type { OperatorRole } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';

export interface LdapUser {
  username: string;
  displayName: string;
  role: OperatorRole;
}

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async authenticate(username: string, password: string): Promise<LdapUser> {
    const host = this.config.get('ldap.host', { infer: true });

    // Credenziali simulate SOLO in sviluppo locale (LDAP_HOST=mock):
    // con un host reale non esiste alcun bypass
    if (host === 'mock') {
      if (username === 'admin' && password === 'admin') {
        return {
          username: 'admin',
          displayName: 'Amministratore Simulato',
          role: 'admin',
        };
      }
      if (username === 'operator' && password === 'operator') {
        return {
          username: 'operator',
          displayName: 'Operatore Simulato',
          role: 'user',
        };
      }
      throw new UnauthorizedException('Credenziali non valide');
    }
    const baseDn = this.config.get('ldap.baseDn', { infer: true });
    const dnTemplate = this.config.get('ldap.userDnTemplate', { infer: true });
    const tlsSkipVerify = this.config.get('ldap.tlsSkipVerify', { infer: true });
    const adminGroup = this.config.get('ldap.adminGroup', { infer: true });
    const requiredGroup = this.config.get('ldap.requiredGroup', { infer: true });

    if (!host) {
      throw new UnauthorizedException('Servizio LDAP non configurato');
    }

    const userDn = dnTemplate.replace('%s', username);

    return this.connectAndAuthenticate({
      host,
      baseDn,
      userDn,
      username,
      password,
      tlsSkipVerify,
      adminGroup,
      requiredGroup,
    });
  }

  private async connectAndAuthenticate(opts: {
    host: string;
    baseDn: string;
    userDn: string;
    username: string;
    password: string;
    tlsSkipVerify: boolean;
    adminGroup: string;
    requiredGroup: string;
  }): Promise<LdapUser> {
    const client = ldapjs.createClient({
      url: opts.host,
      tlsOptions: { rejectUnauthorized: !opts.tlsSkipVerify },
      timeout: 5000,
      connectTimeout: 5000,
      referrals: false,
    } as any);

    try {
      await this.bind(client, opts.userDn, opts.password);
      const entry = await this.searchUser(client, opts.baseDn, opts.username);

      if (!entry) {
        throw new UnauthorizedException('Utente non trovato in Active Directory');
      }

      const memberOf = this.extractMemberOf(entry);
      const groupCns = memberOf.map((dn) => this.extractCn(dn));

      let isUser = groupCns.includes(opts.requiredGroup);
      let isAdmin = groupCns.includes(opts.adminGroup);

      if (!isUser || !isAdmin) {
        try {
          const groupDns = await this.findGroupDns(client, opts.baseDn, [
            opts.requiredGroup,
            opts.adminGroup,
          ]);

          const requiredGroupDn = groupDns[opts.requiredGroup.toUpperCase()];
          const adminGroupDn = groupDns[opts.adminGroup.toUpperCase()];

          if (!isUser && requiredGroupDn) {
            isUser = await this.checkRecursiveMembership(
              client,
              opts.baseDn,
              opts.username,
              requiredGroupDn,
            );
          }

          if (!isAdmin && adminGroupDn) {
            isAdmin = await this.checkRecursiveMembership(
              client,
              opts.baseDn,
              opts.username,
              adminGroupDn,
            );
          }
        } catch (groupError) {
          this.logger.warn(
            `Errore nella risoluzione dei gruppi ricorsivi per ${opts.username}: ${String(
              groupError,
            )}`,
          );
        }
      }

      if (!isUser && !isAdmin) {
        throw new UnauthorizedException('Accesso non autorizzato: gruppo AD richiesto non trovato');
      }

      const role: OperatorRole = isAdmin ? 'admin' : 'user';

      const givenName = String(entry['givenName'] ?? entry['givenname'] ?? '');
      const sn = String(entry['sn'] ?? entry['surname'] ?? '');
      const fullNameFromParts = (givenName && sn) ? `${givenName} ${sn}`.trim() : null;

      const rawDisplayName =
        entry['displayName'] ??
        entry['displayname'] ??
        fullNameFromParts ??
        entry['cn'] ??
        opts.username;

      return {
        username: opts.username,
        displayName: String(rawDisplayName),
        role,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(`LDAP error for user ${opts.username}: ${String(error)}`);
      throw new UnauthorizedException('Credenziali non valide');
    } finally {
      client.unbind(() => {
        /* fire and forget */
      });
    }
  }

  private async findGroupDns(
    client: ldapjs.Client,
    baseDn: string,
    groupCns: string[],
  ): Promise<Record<string, string>> {
    const filter = `(&(objectClass=group)(|${groupCns.map((cn) => `(cn=${cn})`).join('')}))`;
    return new Promise((resolve) => {
      const dns: Record<string, string> = {};
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter: filter,
          attributes: ['cn', 'distinguishedName'],
          referrals: false,
        } as any,
        (err: any, res: any) => {
          if (err) return resolve(dns);

          res.on('searchEntry', (entry: ldapjs.SearchEntry) => {
            const raw = entry as any;
            let cn = '';
            let dn = '';
            if (raw.pojo?.attributes) {
              for (const attr of raw.pojo.attributes) {
                if (attr.type === 'cn') cn = attr.values[0];
                if (attr.type === 'distinguishedName') dn = attr.values[0];
              }
            } else if (raw.object) {
              cn = String(raw.object.cn);
              dn = String(raw.object.distinguishedName || raw.object.dn);
            }
            if (!dn && raw.dn) {
              dn = String(raw.dn);
            }
            if (cn && dn) {
              dns[cn.toUpperCase()] = dn;
            }
          });
          res.on('error', () => {
            // ignore
          });
          res.on('end', () => {
            resolve(dns);
          });
        },
      );
    });
  }

  private async checkRecursiveMembership(
    client: ldapjs.Client,
    baseDn: string,
    username: string,
    groupDn: string,
  ): Promise<boolean> {
    const filter = `(&(|(sAMAccountName=${username})(userPrincipalName=${username}))(memberOf:1.2.840.113556.1.4.1941:=${groupDn}))`;
    return new Promise((resolve) => {
      let matched = false;
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter: filter,
          attributes: ['sAMAccountName'],
          referrals: false,
        } as any,
        (err: any, res: any) => {
          if (err) return resolve(false);
          res.on('searchEntry', () => {
            matched = true;
          });
          res.on('error', () => {
            // ignore
          });
          res.on('end', () => {
            resolve(matched);
          });
        },
      );
    });
  }


  private bind(client: ldapjs.Client, dn: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.bind(dn, password, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private searchUser(
    client: ldapjs.Client,
    baseDn: string,
    username: string,
  ): Promise<Record<string, unknown> | null> {
    const filter = `(|(sAMAccountName=${username})(userPrincipalName=${username}))`;
    return new Promise((resolve, reject) => {
      let resolved = false;
      let found: Record<string, unknown> | null = null;

      client.search(
        baseDn,
        {
          scope: 'sub',
          filter: filter,
          attributes: ['sAMAccountName', 'displayName', 'cn', 'givenName', 'sn', 'mail', 'memberOf'],
          referrals: false,
        } as any,
        (err: any, res: any) => {
          if (err) return reject(err);

          res.on('searchEntry', (entry: ldapjs.SearchEntry) => {
            // ldapjs v3: attributes are in entry.pojo.attributes as {type, values}[]
            const raw = entry as unknown as {
              object?: Record<string, unknown>;
              pojo?: { attributes: { type: string; values: string[] }[] };
            };
            const result: Record<string, unknown> = {};
            if (raw.pojo?.attributes) {
              for (const attr of raw.pojo.attributes) {
                result[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
              }
            } else if (raw.object) {
              Object.assign(result, raw.object);
            }
            found = result;
            if (!resolved) {
              resolved = true;
              resolve(found);
            }
          });
          res.on('error', (searchErr: any) => {
            if (!resolved) {
              resolved = true;
              reject(searchErr);
            }
          });
          res.on('end', () => {
            if (!resolved) {
              resolved = true;
              resolve(found);
            }
          });
        },
      );
    });
  }

  private extractMemberOf(entry: Record<string, unknown>): string[] {
    const val = entry['memberOf'] || entry['memberof'];
    if (!val) return [];
    if (Array.isArray(val)) return val as string[];
    return [String(val)];
  }

  private extractCn(dn: string): string {
    const match = /^CN=([^,]+)/i.exec(dn);
    return match ? match[1] : dn;
  }
}
