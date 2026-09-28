// Debug: stesso flusso di PosteTrackingClient (verifica + cookie + ricerca).
// Uso: docker compose exec -w /app/apps/backend backend node src/debug/poste-tracking-probe.mjs <codice>
const code = process.argv[2];
const H = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.poste.it',
  Referer: 'https://www.poste.it/cerca-spedizioni/index.html',
  'User-Agent': 'ComunicaPA/1.0 (verifica consegna raccomandate PA)',
};
const v = await fetch('https://www.poste.it/online/dovequando/DQ-REST/verificaricercasemplice', {
  method: 'POST', headers: H, body: JSON.stringify({ codiceSpedizione: code, tipoRichiedente: 'WEB' }),
});
const cookie = v.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const r = await fetch('https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice', {
  method: 'POST', headers: { ...H, Cookie: cookie },
  body: JSON.stringify({ tipoRichiedente: 'WEB', codiceSpedizione: code, periodoRicerca: 1 }),
});
console.log('verify', v.status, 'search', r.status);
const { listaMovimenti, ...rest } = await r.json();
console.log(JSON.stringify(rest));
for (const m of listaMovimenti ?? []) {
  console.log(new Date(Number(m.dataOra)).toISOString(), '| box', m.box, '| flagRitorno', m.flagRitorno, '|', m.luogo, '|', m.statoLavorazione);
}
