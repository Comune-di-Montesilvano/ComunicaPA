import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { CitizenAuthController } from './citizen-auth.controller.js';
import { LdapService } from './ldap/ldap.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { OidcCitizenStrategy } from './strategies/oidc-citizen.strategy.js';
import { OidcFlowService } from './oidc/oidc-flow.service.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import type { AppConfiguration } from '../config/configuration.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>) => ({
        secret: config.get('jwt.secret', { infer: true }),
        signOptions: { expiresIn: config.get('jwt.expiresIn', { infer: true }) },
      }),
    }),
    OperatorDirectoryModule,
  ],
  providers: [AuthService, LdapService, JwtStrategy, OidcCitizenStrategy, OidcFlowService],
  controllers: [AuthController, CitizenAuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
