// Script di debug manuale: legge GET /delivery/v2.9/notifications/sent/{iun}
// su PN (SEND) e stampa SOLO stato, categorie timeline e dati di costo
// (analogCost/productType/pagine/peso) — nessun indirizzo né dato personale.
// Serve a verificare cosa PN espone per il costo di un invio cartaceo, senza
// passare da nest build/dist. Stesso pattern di registro-imprese-dettaglio.cjs
// (voucher PDND bearer standard + x-api-key, vedi CLAUDE.md "SEND").
//
// Uso (dal container backend, workdir /app/apps/backend):
//   docker compose exec backend node src/debug/send-notification-costi.cjs <IUN>

const { Client } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function deriveSettingsKey(masterSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', masterSecret, 'comunicapa-settings', 'settings-encryption-v1', 32));
}

function decryptValue(stored, key) {
  const PREFIX = 'enc:v1:';
  const parts = stored.slice(PREFIX.length).split(':');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function main() {
  const iun = process.argv[2];
  if (!iun) {
    console.error('Uso: node src/debug/send-notification-costi.cjs <IUN>');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query('SELECT key, value FROM app_settings');
  await client.end();

  const key = deriveSettingsKey(process.env.JWT_SECRET);
  const settings = {};
  for (const r of rows) {
    const v = r.value;
    settings[r.key] = typeof v === 'string' && v.startsWith('enc:v1:') ? decryptValue(v, key) : v;
  }

  const envKey = settings['send.environment'] === 'produzione' ? 'prod' : 'test';
  const baseUrl = settings[`send.${envKey}.baseUrl`];
  const apiKey = settings[`send.${envKey}.apiKey`];
  const purposeId = settings[`send.${envKey}.purposeId`];
  const p = `pdnd.${envKey}`;
  const clientId = settings[`${p}.clientId`];

  const assertion = jwt.sign(
    { iss: clientId, sub: clientId, aud: settings[`${p}.audience`], purposeId, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) },
    settings[`${p}.privateKey`],
    { algorithm: 'RS256', expiresIn: 60, keyid: settings[`${p}.kid`] },
  );
  const tokenRes = await fetch(settings[`${p}.tokenUrl`], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_assertion: assertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      grant_type: 'client_credentials',
    }),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Voucher PDND fallito: HTTP ${tokenRes.status} — ${tokenText.slice(0, 300)}`);
  const voucher = JSON.parse(tokenText).access_token;

  const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${encodeURIComponent(iun)}`, {
    headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
  });
  const text = await res.text();
  console.log(`Ambiente: ${envKey} — HTTP ${res.status}`);
  if (!res.ok) {
    console.log(text.slice(0, 500));
    return;
  }
  const data = JSON.parse(text);
  console.log(`notificationStatus: ${data.notificationStatus}`);
  console.log(`notificationFeePolicy: ${data.notificationFeePolicy} · paFee: ${data.paFee ?? '-'} · vat: ${data.vat ?? '-'} · amount: ${data.amount ?? '-'}`);
  console.log('Storico stati:', (data.notificationStatusHistory || []).map((h) => `${h.status}@${h.activeFrom}`).join(' → '));
  console.log('Timeline:');
  for (const el of data.timeline || []) {
    const d = el.details || {};
    const costFields = Object.fromEntries(
      ['analogCost', 'productType', 'numberOfPages', 'envelopeWeight', 'sentAttemptMade', 'serviceLevel', 'deliveryFailureCause']
        .filter((k) => d[k] !== undefined)
        .map((k) => [k, d[k]]),
    );
    const addrType = d.digitalAddress?.type ? ` digitalAddress.type=${d.digitalAddress.type}` : '';
    console.log(`  ${el.timestamp}  ${el.category}${addrType} ${Object.keys(costFields).length ? JSON.stringify(costFields) : ''}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
