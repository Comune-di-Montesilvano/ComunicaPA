// Script di debug manuale: chiama dettaglio/codicefiscale su Registro
// Imprese (PCAD-PDND, Unioncamere) per una Partita IVA reale, replicando a
// mano voucher PDND (bearerAuth standard, no digest — vedi PdndAuthService)
// + chiamata REST, senza passare da nest build/dist. Stesso pattern già
// usato per globalcom-dettagli-documento.js (vedi CLAUDE.md).
//
// Uso (dal container backend, workdir /app/apps/backend):
//   docker compose exec backend node src/debug/registro-imprese-dettaglio.js <PARTITA_IVA>

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

const REGISTRO_IMPRESE_BASE_URL = {
  test: 'https://pdndcl.registroimprese.it',
  prod: 'https://pdnd.registroimprese.it',
};

async function main() {
  const partitaIva = process.argv[2];
  if (!partitaIva) {
    console.error('Uso: node src/debug/registro-imprese-dettaglio.js <PARTITA_IVA>');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    `SELECT key, value FROM app_settings WHERE key IN (
      'pdnd.prod.tokenUrl', 'pdnd.prod.audience', 'pdnd.prod.clientId', 'pdnd.prod.kid', 'pdnd.prod.privateKey',
      'registroImprese.prod.purposeId'
    )`,
  );
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  await client.end();

  const purposeId = settings['registroImprese.prod.purposeId'];
  if (!purposeId) {
    console.error('registroImprese.prod.purposeId non impostato in app_settings.');
    process.exit(1);
  }

  const settingsKey = deriveSettingsKey(process.env.JWT_SECRET);
  const privateKey = decryptValue(settings['pdnd.prod.privateKey'], settingsKey);
  const { tokenUrl, audience, clientId, kid } = {
    tokenUrl: settings['pdnd.prod.tokenUrl'],
    audience: settings['pdnd.prod.audience'],
    clientId: settings['pdnd.prod.clientId'],
    kid: settings['pdnd.prod.kid'],
  };

  console.log('--- Richiesta voucher PDND (bearerAuth standard, purposeId=%s) ---', purposeId);
  const clientAssertion = jwt.sign(
    {
      iss: clientId,
      sub: clientId,
      aud: audience,
      purposeId,
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: 60, keyid: kid },
  );

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    client_assertion: clientAssertion,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    grant_type: 'client_credentials',
  });

  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  const tokenText = await tokenResponse.text();
  console.log('Voucher status:', tokenResponse.status);
  if (!tokenResponse.ok) {
    console.log('Voucher body:', tokenText);
    process.exit(1);
  }
  const { access_token: voucher } = JSON.parse(tokenText);
  console.log('Voucher ottenuto (len=%d)', voucher.length);

  const url = `${REGISTRO_IMPRESE_BASE_URL.prod}/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=${encodeURIComponent(partitaIva)}`;
  console.log('\n--- Richiesta dettaglio Registro Imprese ---');
  console.log('URL:', url);

  const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });
  const text = await response.text();
  console.log('Status:', response.status);
  console.log('Headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));
  console.log('\n--- Body ---');
  console.log(text);
}

main().catch((err) => {
  console.error('ERRORE:', err);
  process.exit(1);
});
