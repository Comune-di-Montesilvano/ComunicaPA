import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
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
  mkdirSync('/tmp/comunicapa-uploads', { recursive: true });

  const logLevelName = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  const logger = LOG_LEVELS_BY_NAME[logLevelName] ?? LOG_LEVELS_BY_NAME['info'];
  const app = await NestFactory.create(AppModule, { logger });

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
