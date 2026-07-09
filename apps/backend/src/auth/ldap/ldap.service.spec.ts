import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LdapService } from './ldap.service';
import * as ldapjs from 'ldapjs';

jest.mock('ldapjs');

const mockClient = {
  bind: jest.fn(),
  search: jest.fn(),
  unbind: jest.fn(),
};

async function buildService(host: string): Promise<LdapService> {
  const module = await Test.createTestingModule({
    providers: [
      LdapService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            const cfg: Record<string, unknown> = {
              'ldap.host': host,
              'ldap.baseDn': 'DC=test,DC=local',
              'ldap.userDnTemplate': '%s@test.local',
              'ldap.tlsSkipVerify': true,
              'ldap.adminGroup': 'COMUNICAPA_ADMINS',
              'ldap.requiredGroup': 'COMUNICAPA_USERS',
            };
            return cfg[key];
          },
        },
      },
    ],
  }).compile();
  return module.get<LdapService>(LdapService);
}

describe('LdapService', () => {
  let service: LdapService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (ldapjs.createClient as jest.Mock).mockReturnValue(mockClient);
    mockClient.unbind.mockImplementation((cb: () => void) => cb());

    service = await buildService('ldap://localhost:389');
  });

  it('should resolve with role=admin when user is in admin group', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: null) => void) => cb(null),
    );

    const mockSearchRes = {
      on: jest.fn().mockImplementation(function (
        this: typeof mockSearchRes,
        event: string,
        cb: (...args: unknown[]) => void,
      ) {
        if (event === 'searchEntry') {
          cb({
            object: {
              sAMAccountName: 'mario.rossi',
              displayName: 'Mario Rossi',
              memberOf: [
                'CN=COMUNICAPA_ADMINS,OU=Groups,DC=test,DC=local',
                'CN=COMUNICAPA_USERS,OU=Groups,DC=test,DC=local',
              ],
            },
          });
        }
        if (event === 'end') {
          cb({ status: 0 });
        }
        return this;
      }),
    };

    mockClient.search.mockImplementation(
      (
        _base: string,
        _opts: unknown,
        cb: (err: null, res: typeof mockSearchRes) => void,
      ) => cb(null, mockSearchRes),
    );

    const result = await service.authenticate('mario.rossi', 'password123');

    expect(result.username).toBe('mario.rossi');
    expect(result.role).toBe('admin');
    expect(result.displayName).toBe('Mario Rossi');
  });

  it('should resolve with role=user using recursive membership check if user is not in required group directly', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: null) => void) => cb(null),
    );

    mockClient.search.mockImplementation((_base: string, searchOpts: any, cb: any) => {
      const filter = searchOpts.filter || '';

      const mockSearchRes = {
        on: jest.fn().mockImplementation(function (
          this: typeof mockSearchRes,
          event: string,
          eventCb: (...args: unknown[]) => void,
        ) {
          if (event === 'searchEntry') {
            if (filter.includes('1.2.840.113556.1.4.1941')) {
              // recursive check
              if (filter.includes('CN=COMUNICAPA_USERS')) {
                eventCb({
                  object: {
                    sAMAccountName: 'mario.rossi',
                  },
                });
              }
            } else if (filter.includes('sAMAccountName=mario.rossi')) {
              // User search: returns user with only unrelated direct groups
              eventCb({
                object: {
                  sAMAccountName: 'mario.rossi',
                  displayName: 'Mario Rossi',
                  memberOf: ['CN=UNRELATED_GROUP,OU=Groups,DC=test,DC=local'],
                },
              });
            } else if (filter.includes('objectClass=group')) {
              // findGroupDns search: returns group CNs and DNs
              eventCb({
                object: {
                  cn: 'COMUNICAPA_USERS',
                  distinguishedName: 'CN=COMUNICAPA_USERS,OU=Groups,DC=test,DC=local',
                },
              });
              eventCb({
                object: {
                  cn: 'COMUNICAPA_ADMINS',
                  distinguishedName: 'CN=COMUNICAPA_ADMINS,OU=Groups,DC=test,DC=local',
                },
              });
            }
          }
          if (event === 'end') {
            eventCb({ status: 0 });
          }
          return this;
        }),
      };
      cb(null, mockSearchRes);
    });

    const result = await service.authenticate('mario.rossi', 'password123');

    expect(result.username).toBe('mario.rossi');
    expect(result.role).toBe('user');
    expect(result.displayName).toBe('Mario Rossi');
  });

  it('should reject when bind fails (wrong password)', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: Error) => void) =>
        cb(new Error('Invalid credentials')),
    );

    await expect(service.authenticate('mario.rossi', 'wrongpass')).rejects.toThrow(
      'Credenziali non valide',
    );
  });

  it('should NOT accept mock credentials when host is a real LDAP server', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: Error) => void) =>
        cb(new Error('Invalid credentials')),
    );

    await expect(service.authenticate('admin', 'admin')).rejects.toThrow(
      'Credenziali non valide',
    );
    expect(mockClient.bind).toHaveBeenCalled();
  });

  describe('mock mode (LDAP_HOST=mock)', () => {
    beforeEach(async () => {
      service = await buildService('mock');
    });

    it('accepts admin/admin with role=admin', async () => {
      const result = await service.authenticate('admin', 'admin');
      expect(result.role).toBe('admin');
      expect(ldapjs.createClient).not.toHaveBeenCalled();
    });

    it('accepts operator/operator with role=user', async () => {
      const result = await service.authenticate('operator', 'operator');
      expect(result.role).toBe('user');
    });

    it('rejects any other credentials without contacting LDAP', async () => {
      await expect(service.authenticate('admin', 'wrong')).rejects.toThrow(
        'Credenziali non valide',
      );
      expect(ldapjs.createClient).not.toHaveBeenCalled();
    });
  });
});
