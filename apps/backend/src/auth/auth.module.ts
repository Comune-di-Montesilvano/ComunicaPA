import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { SignOptions } from 'jsonwebtoken';
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
    // @nestjs/passport v12: AuthGuard() richiede AuthModuleOptions via DI
    // anche se dichiarato @Optional() nel mixin (regressione framework,
    // verificata su OidcAuthGuard in CitizenModule) - import nudo di
    // PassportModule non fornisce alcun provider (modulo vuoto), serve
    // .register({}) esplicito per fornire AuthModuleOptions anche vuoto.
    PassportModule.register({}),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>): JwtModuleOptions => ({
        secret: config.get('jwt.secret', { infer: true }),
        signOptions: {
          expiresIn: config.get('jwt.expiresIn', { infer: true }) as SignOptions['expiresIn'],
        },
      }),
    }),
    OperatorDirectoryModule,
  ],
  providers: [AuthService, LdapService, JwtStrategy, OidcCitizenStrategy, OidcFlowService],
  controllers: [AuthController, CitizenAuthController],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
