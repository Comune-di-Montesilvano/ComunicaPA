import 'reflect-metadata';
import { Controller, Get, Injectable, Param, ParseUUIDPipe, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { CampaignAccessInterceptor } from './campaign-access.interceptor.js';

/**
 * Boot reale (adapter Express) con controller che replicano i prefissi veri
 * delle route campagna — campaigns, signed-attachments, signature-verification,
 * remote-sign ('admin' + 'campaigns/:id/...'), poste-tracking: verifica che
 * req.route.path visto dall'interceptor globale contenga il prefisso completo
 * del controller, qualunque sia lo split prefisso/metodo.
 */
const BOZZA = '11111111-2222-4333-8444-555555555555';

@Controller('admin/campaigns')
class CampaignsLike {
  @Get('stats/global') global() { return 'ok'; }
  @Get(':id') one(@Param('id', ParseUUIDPipe) _id: string) { return 'ok'; }
  @Get(':id/stats') stats() { return 'ok'; }
  @Get(':id/postal/poste-check') poste() { return 'ok'; }
}
@Controller('admin/campaigns/:id')
class SignedAttachmentsLike {
  @Get('signature/unsigned.zip') zip() { return 'ok'; }
}
@Controller('admin/campaigns/:id/signature-verification')
class SignatureVerificationLike {
  @Get() status() { return 'ok'; }
}
@Controller('admin')
class RemoteSignLike {
  @Get('campaigns/:id/remote-sign') status() { return 'ok'; }
}

@Injectable()
class FakeJwtGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { username: req.headers['x-user'], role: req.headers['x-role'] ?? 'user', type: 'operator' };
    return true;
  }
}

describe('CampaignAccessInterceptor — route reali Express (integration)', () => {
  let app: INestApplication;
  const repo = {
    findOne: jest.fn(async () => ({ id: BOZZA, createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CampaignsLike, SignedAttachmentsLike, SignatureVerificationLike, RemoteSignLike],
      providers: [
        { provide: getRepositoryToken(Campaign), useValue: repo },
        { provide: APP_GUARD, useClass: FakeJwtGuard },
        { provide: APP_INTERCEPTOR, useClass: CampaignAccessInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    `/admin/campaigns/${BOZZA}`,
    `/admin/campaigns/${BOZZA}/stats`,
    `/admin/campaigns/${BOZZA}/postal/poste-check`,
    `/admin/campaigns/${BOZZA}/signature/unsigned.zip`,
    `/admin/campaigns/${BOZZA}/signature-verification`,
    `/admin/campaigns/${BOZZA}/remote-sign`,
  ])('%s: bozza altrui → 404, creatore → 200', async (url) => {
    await request(app.getHttpServer()).get(url).set('x-user', 'bianchi').expect(404);
    await request(app.getHttpServer()).get(url).set('x-user', 'rossi').expect(200);
  });

  it('route statica sotto admin/campaigns → nessuna query', async () => {
    repo.findOne.mockClear();
    await request(app.getHttpServer()).get('/admin/campaigns/stats/global').set('x-user', 'bianchi').expect(200);
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('id non UUID → 400 da ParseUUIDPipe, nessuna query', async () => {
    repo.findOne.mockClear();
    await request(app.getHttpServer()).get('/admin/campaigns/non-uuid').set('x-user', 'bianchi').expect(400);
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
