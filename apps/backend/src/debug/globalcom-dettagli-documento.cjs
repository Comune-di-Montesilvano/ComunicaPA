// Script di debug manuale: chiama dettagli_documento su GlobalCom per un IDPRO
// reale, usando il provider POSTAL attivo (dev usa le credenziali GlobalCom
// REALI di produzione — vedi CLAUDE.md "Dev usa credenziali GlobalCom reali").
// Non fa parte dell'applicazione, nessun import da src/ compilato: replica a
// mano il minimo indispensabile (decrypt password + login + chiamata SOAP)
// per non dipendere da nest build/dist quando si vuole un riscontro rapido
// senza passare da un job/cron.
//
// Uso (dal container backend, workdir /app/apps/backend):
//   docker compose exec backend node src/debug/globalcom-dettagli-documento.js <IDPRO>
//
// Gotcha già presi a mazzate una volta, non ripeterli:
// - LoginAsync vuole i parametri "user"/"password"/"group" (inglese,
//   minuscolo) — "Utente"/"Password"/"Gruppo" produce un
//   NullReferenceException generico lato GlobalCom, non un errore di auth.
// - La sessione dopo Login è un cookie HTTP, non un token nel payload — va
//   ripreso da lastResponseHeaders['set-cookie'] e riapplicato con
//   client.addHttpHeader('Cookie', ...) prima di qualunque chiamata
//   successiva, altrimenti ogni metodo dopo Login torna CodiceErrore "0401"
//   "NOK: Login" anche con credenziali corrette.
// - Mai loggare la password decriptata.

const { Client } = require('pg');
const soap = require('soap');
const crypto = require('crypto');

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
  const idpro = process.argv[2];
  if (!idpro) {
    console.error('Uso: node src/debug/globalcom-dettagli-documento.js <IDPRO>');
    process.exit(1);
  }

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const { rows } = await pg.query(
    `SELECT base_url, username, password_enc, "group" FROM postal_provider_configs WHERE active = true LIMIT 1`,
  );
  await pg.end();
  if (rows.length === 0) throw new Error('Nessun provider POSTAL attivo trovato');
  const provider = rows[0];

  const key = deriveSettingsKey(process.env.JWT_SECRET);
  const password = decryptValue(provider.password_enc, key);

  const endpoint = provider.base_url.replace(/\?wsdl$/i, '');
  const client = await soap.createClientAsync(`${endpoint}?wsdl`, { endpoint });
  const [loginResult] = await client.LoginAsync({ user: provider.username, password, group: provider.group });
  if (!loginResult.LoginResult) throw new Error('Login GlobalCom fallito: ' + JSON.stringify(loginResult));
  console.log('Login OK, session:', loginResult.message);

  const setCookie = client.lastResponseHeaders && client.lastResponseHeaders['set-cookie'];
  if (setCookie) {
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((c) => c.split(';')[0]).join('; ');
    client.addHttpHeader('Cookie', cookie);
  } else {
    console.warn('ATTENZIONE: nessun set-cookie nella risposta di Login — le chiamate successive falliranno con "NOK: Login"');
  }

  const [result] = await client.dettagli_documentoAsync({ IDPRO: idpro });
  console.log('dettagli_documentoResult:', result.dettagli_documentoResult);
  console.log('Risposta:', JSON.stringify(result.Risposta, null, 2));
}

main().catch((err) => {
  console.error('ERRORE:', err.message);
  process.exit(1);
});
