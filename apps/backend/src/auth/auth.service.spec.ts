import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LdapService } from './ldap/ldap.service';
import type { LoginDto } from './dto/login.dto';

describe('AuthService', () => {
  let service: AuthService;
  let ldapService: jest.Mocked<LdapService>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    ldapService = module.get(LdapService);
    jwtService = module.get(JwtService);
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
    expect(result.token_type).toBe('Bearer');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: 'mario.rossi',
      username: 'mario.rossi',
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
});
