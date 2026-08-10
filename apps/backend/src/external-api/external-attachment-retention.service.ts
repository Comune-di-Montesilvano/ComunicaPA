import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, coerente col design

@Injectable()
export class ExternalAttachmentRetentionService {
  private readonly logger = new Logger(ExternalAttachmentRetentionService.name);

  constructor(private readonly tokens: ExternalAttachmentTokensService) {}

  @Cron(CronExpression.EVERY_HOUR)
  cleanupStaleTokens(): void {
    const staleDirs = this.tokens.listStaleTokenDirs(MAX_AGE_MS);
    for (const dir of staleDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (staleDirs.length > 0) {
      this.logger.log(`Rimossi ${staleDirs.length} token allegato esterni non consumati entro 24h`);
    }
  }
}
