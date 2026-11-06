import {
  Injectable,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { defer, from, switchMap, type Observable } from 'rxjs';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Campaign } from '../entities/campaign.entity.js';
import { canViewCampaign } from './campaign-access.util.js';

// req.route.path di Express = path completo registrato da Nest (prefisso del
// controller incluso), es. '/admin/campaigns/:id/stats' — vale anche per i
// controller fuori da campaigns/ (remote-sign, signature-verification,
// signed-attachments, poste-tracking) che usano lo stesso segmento.
export const CAMPAIGN_ID_ROUTE = /^\/admin\/campaigns\/:id(\/|$)/;
// Gli interceptor girano PRIMA delle pipe: un id non UUID va lasciato a
// ParseUUIDPipe (400), non passato a Postgres (errore 500 sul cast uuid).
// INVARIANTE: ogni handler `admin/campaigns/:id/...` che legge `id` DEVE
// usare `@Param('id', ParseUUIDPipe)`. Postgres accetta anche UUID senza
// trattini (o tra graffe), che qui non passano il test e saltano il
// controllo: senza ParseUUIDPipe arriverebbero al DB aggirando la
// visibilità di bozze/invii di prova. Verificato su tutti i controller da
// campaign-access.routes.spec.ts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bozze e invii di prova invisibili a chi non può leggerne gli allegati (canViewCampaign):
 * ogni route operatore `admin/campaigns/:id/...` risponde 404 come per una
 * campagna inesistente, senza toccare i singoli handler. Globale
 * (APP_INTERCEPTOR) → gira dopo JwtAuthGuard, req.user è già valorizzato.
 */
@Injectable()
export class CampaignAccessInterceptor implements NestInterceptor {
  constructor(@InjectRepository(Campaign) private readonly campaignRepo: Repository<Campaign>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      route?: { path?: unknown };
      params?: Record<string, string>;
      user?: Partial<JwtOperatorPayload> & { type?: string };
    }>();
    const user = req.user;
    const path = typeof req.route?.path === 'string' ? req.route.path : '';
    const id = req.params?.['id'];
    if (user?.type !== 'operator' || !id || !UUID.test(id) || !CAMPAIGN_ID_ROUTE.test(path)) return next.handle();

    return defer(() =>
      from(
        this.campaignRepo.findOne({
          where: { id },
          select: { id: true, createdBy: true, signerUsername: true, status: true, isTest: true },
        }),
      ),
    ).pipe(
      switchMap((campaign) => {
        if (campaign && !canViewCampaign(campaign, { username: user.username ?? '', role: user.role ?? 'user' })) {
          throw new NotFoundException(`Campaign ${id} not found`);
        }
        return next.handle();
      }),
    );
  }
}
