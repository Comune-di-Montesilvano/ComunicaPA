import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LdapService } from './ldap/ldap.service';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service';
import type { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let ldapService: jest.Mocked<LdapService>;
  let jwtService: jest.Mocked<JwtService>;
  let operatorDirectory: jest.Mocked<OperatorDirectoryService>;
  let ldapHost = 'ldap://ad.example.it:389';

  beforeEach(async () => {
    ldapHost = 'ldap://ad.example.it:389';
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: LdapService,
          useValue: {
            authenticate: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('mock.jwt.token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'ldap.host' ? ldapHost : undefined)),
          },
        },
        {
          provide: OperatorDirectoryService,
          useValue: {
            upsert: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    ldapService = module.get(LdapService);
    jwtService = module.get(JwtService);
    operatorDirectory = module.get(OperatorDirectoryService);
  });

  it('should return access_token on valid LDAP credentials', async () => {
    ldapService.authenticate.mockResolvedValue({
      username: 'mario.rossi',
      displayName: 'Mario Rossi',
      role: 'admin',
    });

    const dto: LoginDto = { username: 'mario.rossi', password: 'pass' };
    const result = await service.loginWithLdap(dto);

    expect(result.access_token).toBe('mock.jwt.token');
    expect(result.role).toBe('admin');
    expect(result.username).toBe('mario.rossi');
    expect(result.displayName).toBe('Mario Rossi');
    expect(result.token_type).toBe('Bearer');
    expect(operatorDirectory.upsert).toHaveBeenCalledWith('mario.rossi', 'Mario Rossi');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: 'mario.rossi',
      username: 'mario.rossi',
      displayName: 'Mario Rossi',
      role: 'admin',
      type: 'operator',
    });
  });

  it('should propagate UnauthorizedException from LDAP', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    ldapService.authenticate.mockRejectedValue(
      new UnauthorizedException('Credenziali non valide'),
    );

    await expect(service.loginWithLdap({ username: 'x', password: 'y' })).rejects.toThrow(
      'Credenziali non valide',
    );
  });

  it('citizen mock token: 403 con LDAP host reale', async () => {
    await expect(
      service.generateCitizenToken({ codiceFiscale: 'RSSMRA80A01H501X' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('citizen mock token: emesso con LDAP_HOST=mock', async () => {
    ldapHost = 'mock';
    const result = await service.generateCitizenToken({ codiceFiscale: 'rssmra80a01h501x' });
    expect(result.access_token).toBe('mock.jwt.token');
    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ codiceFiscale: 'RSSMRA80A01H501X' }),
    );
  });
});
