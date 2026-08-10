import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ExternalApiClientsService } from '../external-api-clients.service';
import type { ExternalApiClient } from '../../entities/external-api-client.entity';

export type RequestWithApiClient = Request & { apiClient: ExternalApiClient };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly clientsService: ExternalApiClientsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithApiClient>();
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Header X-Api-Key mancante');
    }
    const client = await this.clientsService.findActiveByKey(apiKey);
    if (!client) {
      throw new UnauthorizedException('API key non valida o revocata');
    }
    req.apiClient = client;
    this.clientsService.touchLastUsed(client.id).catch(() => {});
    return true;
  }
}
