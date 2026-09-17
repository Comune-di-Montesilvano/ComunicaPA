// Ripara destinatari "fantasma": status recipients='queued' ma NESSUN
// NotificationAttempt mai creato (bug reale corretto in PR#108 — la fix
// previene solo casi FUTURI, non ripara righe già corrotte prima del
// deploy). Crea l'attempt mancante + accoda il job BullMQ reale, stesso
// identico pattern di CampaignsService.createAttemptsAndEnqueue.
//
// Estensione .cjs, non .js: "type":"module" nel package.json del backend
// tratterebbe un .js come ESM, require() fallirebbe (stesso motivo degli
// altri script in questa cartella).
//
// Dry-run di default: stampa solo quanti destinatari verrebbero riparati.
// Passare --apply per scrivere davvero.
//
// Uso: docker compose exec backend node src/debug/repair-ghost-queued-recipients.cjs <campaignId> [--apply]

const { Client } = require('pg');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

async function main() {
  const campaignId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!campaignId) {
    console.error('Uso: node repair-ghost-queued-recipients.cjs <campaignId> [--apply]');
    process.exit(1);
  }

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  try {
    const { rows: campaignRows } = await pg.query('SELECT id, name, channel_type FROM campaigns WHERE id = $1', [campaignId]);
    if (campaignRows.length === 0) {
      console.error(`Campagna ${campaignId} non trovata`);
      process.exit(1);
    }
    const { name, channel_type: channelType } = campaignRows[0];
    console.log(`Campagna: "${name}" — canale ${channelType}`);

    const { rows: ghosts } = await pg.query(
      `SELECT r.id FROM recipients r
       WHERE r.campaign_id = $1 AND r.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM notification_attempts a WHERE a.recipient_id = r.id)`,
      [campaignId],
    );
    console.log(`Destinatari fantasma trovati (queued, nessun attempt): ${ghosts.length}`);

    if (ghosts.length === 0) {
      console.log('Niente da riparare.');
      return;
    }
    if (!apply) {
      console.log('Dry-run: nessuna scrittura. Rilanciare con --apply per riparare davvero.');
      return;
    }

    const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(`notifications-${channelType.toLowerCase()}`, { connection: redis });

    const CHUNK = 500;
    let repaired = 0;
    for (let i = 0; i < ghosts.length; i += CHUNK) {
      const chunk = ghosts.slice(i, i + CHUNK).map((r) => r.id);
      const { rows: inserted } = await pg.query(
        `INSERT INTO notification_attempts (recipient_id, channel_type, status, attempt_number)
         SELECT rid, $2, 'queued', 1 FROM UNNEST($1::uuid[]) AS rid
         RETURNING id, recipient_id`,
        [chunk, channelType],
      );
      await queue.addBulk(
        inserted.map((row) => ({
          name: 'send',
          data: { campaignId, recipientId: row.recipient_id, attemptId: row.id, channel: channelType },
          opts: { jobId: row.id },
        })),
      );
      repaired += inserted.length;
      console.log(`Riparati ${repaired}/${ghosts.length}...`);
    }
    console.log(`Fatto: ${repaired} attempt+job creati.`);

    await queue.close();
    await redis.quit();
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error('Errore:', err);
  process.exit(1);
});
