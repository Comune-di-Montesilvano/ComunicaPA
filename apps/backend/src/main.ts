import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import type { AppConfiguration } from './config/configuration';
import { assertProductionSecrets } from './config/production-guards';

// docker-compose.yml passa già LOG_LEVEL al container (default 'info'), ma
// finora nessun codice lo leggeva: il default NestJS esclude 'debug'/
// 'verbose', quindi i log di dettaglio dei motori di invio (payload/risposte
// PEC/Email/App IO/SEND/Postal) non comparivano mai. Impostare LOG_LEVEL=debug
// in .env e riavviare il container li abilita senza rebuild.
const LOG_LEVELS_BY_NAME: Record<string, LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  info: ['error', 'warn', 'log'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

async function bootstrap(): Promise<void> {
  // Attivo SOLO se SENTRY_DSN_BACKEND è valorizzata — nessun invio di
  // default, specialmente in dev locale. Un solo progetto GlitchTip
  // condiviso per il backend, le istanze si distinguono con SENTRY_ENVIRONMENT.
  const sentryDsn = process.env['SENTRY_DSN_BACKEND'];
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: process.env['SENTRY_ENVIRONMENT'] ?? 'unknown',
      tracesSampleRate: 0,
    });
  }

  mkdirSync('/tmp/comunicapa-uploads', { recursive: true });

  const logLevelName = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  const logger = LOG_LEVELS_BY_NAME[logLevelName] ?? LOG_LEVELS_BY_NAME['info'];
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });

  // Default Nest/Express è 100kb, troppo basso per body legittimi non-file
  // (es. POST recipients/retry-bulk con array di UUID — 3205 destinatari
  // ~130KB, un batch TARI da 20100 ~800KB). Bug reale in produzione:
  // "PayloadTooLargeError: request entity too large" su un retry-bulk con
  // solo qualche migliaio di id, ben sotto il limite ~1MB del reverse proxy
  // esterno (vedi CLAUDE.md) — il collo di bottiglia era tutto interno, mai
  // arrivato al proxy. 2mb resta comunque sotto quel limite, quindi non
  // sposta il vincolo reale (upload file passano da multer/chunked upload,
  // non da questo body parser, e non sono impattati).
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });

  // Guardia di sicurezza: rifiuta l'avvio in ambienti non-development con segreti di default.
  const config = app.get<ConfigService<AppConfiguration, true>>(ConfigService);
  assertProductionSecrets(
    config.get('nodeEnv', { infer: true }),
    config.get('downloadLink.secret', { infer: true }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      process.env['ADMIN_ORIGIN'] ?? '',
      process.env['CITIZEN_ORIGIN'] ?? '',
    ].filter(Boolean),
    credentials: true,
  });

  const port = Number(process.env['PORT'] ?? 8080);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend running on http://0.0.0.0:${port}`);
}

void bootstrap();
