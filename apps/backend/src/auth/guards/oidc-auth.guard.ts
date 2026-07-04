import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OidcAuthGuard extends AuthGuard('oidc-citizen') {
  private readonly logger = new Logger(OidcAuthGuard.name);

  handleRequest<TUser = unknown>(err: unknown, user: unknown, info: unknown): TUser {
    if (err || !user) {
      // passport-jwt non espone altrimenti il motivo del rigetto (firma non
      // valida, token scaduto, issuer/audience non ammessi...): senza questo
      // log ogni fallimento della strategia risulta un 401 muto e identico
      const reason =
        info instanceof Error ? info.message : typeof info === 'string' ? info : JSON.stringify(info);
      this.logger.error(`Autenticazione OIDC cittadino rifiutata: ${reason}`, err instanceof Error ? err.stack : undefined);
    }
    if (err || !user) {
      throw err instanceof Error ? err : new UnauthorizedException();
    }
    return user as TUser;
  }
}
