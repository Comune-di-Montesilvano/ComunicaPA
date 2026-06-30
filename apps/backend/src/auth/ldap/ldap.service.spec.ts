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

describe('LdapService', () => {
  let service: LdapService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (ldapjs.createClient as jest.Mock).mockReturnValue(mockClient);
    mockClient.unbind.mockImplementation((cb: () => void) => cb());

    const module = await Test.createTestingModule({
      providers: [
        LdapService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const cfg: Record<string, unknown> = {
                'ldap.host': 'ldap://localhost:389',
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

    service = module.get<LdapService>(LdapService);
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

  it('should reject when bind fails (wrong password)', async () => {
    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: Error) => void) =>
        cb(new Error('Invalid credentials')),
    );

    await expect(service.authenticate('mario.rossi', 'wrongpass')).rejects.toThrow(
      'Credenziali non valide',
    );
  });
});
