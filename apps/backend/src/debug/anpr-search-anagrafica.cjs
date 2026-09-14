// Script di debug SPIKE (throwaway, non fa parte dell'app, mai da committare
// così com'è oltre questa sessione): chiama ANPR C002 con criteriRicerca
// libero (cognome/nome/sesso/datiNascita) invece del solo codiceFiscale
// hardcoded in AnprService.getResidenza(), per scoprire dal vivo quali
// combinazioni di input il servizio accetta e cosa restituisce.
//
// Stesso pattern del debug GlobalCom: nessun import da src/ compilato,
// replica a mano auth PDND (client assertion + digest TrackingEvidence,
// vedi pdnd-auth.service.ts / anpr.service.ts) leggendo/decriptando i
// settings direttamente da Postgres.
//
// Uso (dal container backend, workdir /app/apps/backend):
//   docker compose exec backend node src/debug/anpr-search-anagrafica.cjs \
//     --cognome=Rossi --nome=Mario --sesso=M --dataNascita=1980-01-01 \
//     --luogoComune="Roma" --luogoProvincia=RM
//
// Query REALE su ANPR prod (nessun sandbox, stesso vincolo di InadService/
// AnprService) — usare SOLO con dati anagrafici per cui esiste un motivo
// legittimo (self-test con consenso, o pratica PA reale). Mai loggare/
// salvare risposte con dati di terzi non autorizzati.

const { Client } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ANPR_C002_ENDPOINT =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C002-servizioComunicazione/v1/anpr-service-e002';
const ANPR_C002_AUD =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C002-servizioComunicazione/v1';

const PREFIX = 'enc:v1:';
function deriveSettingsKey(masterSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', masterSecret, 'comunicapa-settings', 'settings-encryption-v1', 32));
}
function decryptValue(stored, key) {
  const parts = stored.slice(PREFIX.length).split(':');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function getSetting(pg, key, cryptoKey) {
  const { rows } = await pg.query('SELECT value, encrypted FROM app_settings WHERE key = $1', [key]);
  if (rows.length === 0) return undefined;
  let v = rows[0].value;
  // jsonb: stringa salvata come JSON string (con virgolette)
  if (typeof v === 'string' && v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
  if (rows[0].encrypted && typeof v === 'string' && v.startsWith(PREFIX)) v = decryptValue(v, cryptoKey);
  return v;
}

async function main() {
  const args = parseArgs();
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const cryptoKey = deriveSettingsKey(process.env.JWT_SECRET);

  const [tokenUrl, audience, clientId, kid, privateKey, purposeId, userLocation, loA] = await Promise.all([
    getSetting(pg, 'pdnd.prod.tokenUrl', cryptoKey),
    getSetting(pg, 'pdnd.prod.audience', cryptoKey),
    getSetting(pg, 'pdnd.prod.clientId', cryptoKey),
    getSetting(pg, 'pdnd.prod.kid', cryptoKey),
    getSetting(pg, 'pdnd.prod.privateKey', cryptoKey),
    getSetting(pg, 'anpr.c002.purposeId', cryptoKey),
    getSetting(pg, 'anpr.trackingUserLocation', cryptoKey),
    getSetting(pg, 'anpr.trackingLoA', cryptoKey),
  ]);
  await pg.end();

  const missing = Object.entries({ tokenUrl, audience, clientId, kid, privateKey, purposeId })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) throw new Error(`Config PDND/ANPR incompleta, mancano: ${missing.join(', ')} (usare default env se non in DB)`);

  // criteriRicerca libero da argv
  const criteriRicerca = {};
  if (args.codiceFiscale) criteriRicerca.codiceFiscale = args.codiceFiscale;
  if (args.idANPR) criteriRicerca.idANPR = args.idANPR;
  if (args.cognome) criteriRicerca.cognome = args.cognome;
  if (args.nome) criteriRicerca.nome = args.nome;
  if (args.sesso) criteriRicerca.sesso = args.sesso;
  if (args.dataNascita || args.luogoComune) {
    criteriRicerca.datiNascita = {};
    if (args.dataNascita) criteriRicerca.datiNascita.dataEvento = args.dataNascita;
    if (args.luogoComune) {
      criteriRicerca.datiNascita.luogoNascita = { comune: { nomeComune: args.luogoComune } };
      if (args.luogoProvincia) criteriRicerca.datiNascita.luogoNascita.comune.siglaProvinciaIstat = args.luogoProvincia;
    }
  }
  console.log('criteriRicerca:', JSON.stringify(criteriRicerca, null, 2));

  // 1. TrackingEvidence
  const trackingPayload = {
    iss: clientId,
    sub: clientId,
    aud: ANPR_C002_AUD,
    jti: crypto.randomUUID(),
    purposeId,
    dnonce: Date.now().toString(),
    userID: args.operator || 'debug-spike',
    userLocation,
    LoA: loA,
  };
  const trackingEvidence = jwt.sign(trackingPayload, privateKey, { algorithm: 'RS256', keyid: kid, expiresIn: 60, notBefore: 0 });
  const trackingDigestHex = crypto.createHash('sha256').update(trackingEvidence).digest('hex');

  // 2. Voucher con digest
  const clientAssertion = jwt.sign(
    {
      iss: clientId,
      sub: clientId,
      aud: audience,
      purposeId,
      digest: { alg: 'SHA256', value: trackingDigestHex },
      jti: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    },
    privateKey,
    { algorithm: 'RS256', expiresIn: 60, keyid: kid },
  );
  const voucherBody = new URLSearchParams({
    client_id: clientId,
    client_assertion: clientAssertion,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    grant_type: 'client_credentials',
  });
  const voucherResp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: voucherBody,
  });
  const voucherText = await voucherResp.text();
  if (!voucherResp.ok) throw new Error(`Voucher PDND fallito: HTTP ${voucherResp.status} — ${voucherText}`);
  const voucher = JSON.parse(voucherText).access_token;

  // 3. Body + Agid-JWT-Signature
  const idOperazioneClient = `${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
  const body = {
    idOperazioneClient,
    criteriRicerca,
    datiRichiesta: {
      dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
      motivoRichiesta: args.motivo || 'comunicapa-spike-test-tecnico-self',
      casoUso: 'C002',
    },
  };
  const bodyStr = JSON.stringify(body);
  const digest = `SHA-256=${crypto.createHash('sha256').update(bodyStr).digest('base64')}`;
  const signature = jwt.sign(
    { iss: clientId, sub: clientId, aud: ANPR_C002_AUD, jti: crypto.randomUUID(), signed_headers: [{ digest }, { 'Content-Type': 'application/json' }] },
    privateKey,
    { algorithm: 'RS256', keyid: kid, expiresIn: 60, notBefore: 0 },
  );

  console.log('--- request body ---');
  console.log(bodyStr);

  const response = await fetch(ANPR_C002_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${voucher}`,
      Digest: digest,
      'Agid-JWT-Signature': signature,
      'Agid-JWT-TrackingEvidence': trackingEvidence,
      'Content-Type': 'application/json',
    },
    body: bodyStr,
  });
  const text = await response.text();
  console.log(`--- response HTTP ${response.status} ---`);
  console.log(text);
}

main().catch((err) => {
  console.error('ERRORE:', err.message);
  process.exit(1);
});
