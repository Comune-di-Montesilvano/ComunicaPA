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
    const baseDn = this.config.get('ldap.baseDn', { infer: true });
    const dnTemplate = this.config.get('ldap.userDnTemplate', { infer: true });
    const tlsSkipVerify = this.config.get('ldap.tlsSkipVerify', { infer: true });
    const adminGroup = this.config.get('ldap.adminGroup', { infer: true });
    const requiredGroup = this.config.get('ldap.requiredGroup', { infer: true });

    const userDn = dnTemplate.replace('%s', username);

    const client = ldapjs.createClient({
      url: host,
      tlsOptions: { rejectUnauthorized: !tlsSkipVerify },
      timeout: 5000,
      connectTimeout: 5000,
    });

    try {
      await this.bind(client, userDn, password);
      const entry = await this.searchUser(client, baseDn, username);

      if (!entry) {
        throw new UnauthorizedException('Utente non trovato in Active Directory');
      }

      const memberOf = this.extractMemberOf(entry);
      const groupCns = memberOf.map((dn) => this.extractCn(dn));

      this.logger.debug(`User ${username} memberOf: ${groupCns.join(', ')}`);

      if (!groupCns.includes(requiredGroup) && !groupCns.includes(adminGroup)) {
        throw new UnauthorizedException('Accesso non autorizzato: gruppo AD richiesto non trovato');
      }

      const role: OperatorRole = groupCns.includes(adminGroup) ? 'admin' : 'user';

      return {
        username,
        displayName: String(entry['displayName'] ?? username),
        role,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(`LDAP error for user ${username}: ${String(error)}`);
      throw new UnauthorizedException('Credenziali non valide');
    } finally {
      client.unbind(() => {
        /* fire and forget */
      });
    }
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
    return new Promise((resolve, reject) => {
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter: `(sAMAccountName=${username})`,
          attributes: ['sAMAccountName', 'displayName', 'mail', 'memberOf'],
        },
        (err, res) => {
          if (err) return reject(err);

          let found: Record<string, unknown> | null = null;

          res.on('searchEntry', (entry: ldapjs.SearchEntry) => {
            found = (entry as unknown as { object: Record<string, unknown> }).object;
          });
          res.on('error', reject);
          res.on('end', () => resolve(found));
        },
      );
    });
  }

  private extractMemberOf(entry: Record<string, unknown>): string[] {
    const val = entry['memberOf'];
    if (!val) return [];
    if (Array.isArray(val)) return val as string[];
    return [String(val)];
  }

  private extractCn(dn: string): string {
    const match = /^CN=([^,]+)/i.exec(dn);
    return match ? match[1] : dn;
  }
}
