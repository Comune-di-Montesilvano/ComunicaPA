import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SendDispatchService } from './channels/send/send-dispatch.service';

// ProtocollazioneSyncService (cron poll) è stato sostituito da
// ProtocollazioneProcessor (BullMQ worker, apps/backend/src/queue/protocollazione.processor.ts)
// — non più invocabile manualmente via handleCron(), gira solo per job.

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const s = app.get(SendDispatchService);
  try {
    await s.handleCron();
    console.log('SendDispatchService.handleCron() OK');
  } catch (e: any) {
    console.error('SendDispatchService FAILED:', e.stack || e);
  }
  await app.close();
  process.exit(0);
}
main();
