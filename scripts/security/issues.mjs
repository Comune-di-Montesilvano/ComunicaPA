// Testi delle tre issue dell'autofix (una per stato, aggiornata e mai duplicata) e stato
// persistente delle esclusioni, salvato nel body della issue "fallita".

export const ISSUE_TITLES = {
  pending: 'Autofix sicurezza: correzioni in attesa',
  unfixable: 'Autofix sicurezza: vulnerabilità non correggibili',
  failed: 'Autofix sicurezza: correzione fallita',
};

const STATE_RE = /<!-- autofix-state (.*?) -->/s;
const day = (iso) => String(iso).slice(0, 10);
const ids = (g) => (g ?? []).join(' ');

export function parseIssueState(body) {
  const m = String(body ?? '').match(STATE_RE);
  if (!m) return { excluded: [] };
  try {
    const s = JSON.parse(m[1]);
    return { excluded: Array.isArray(s.excluded) ? s.excluded.map(String) : [] };
  } catch { return { excluded: [] }; }
}

export function renderIssue(kind, items, state = { excluded: [] }) {
  const title = ISSUE_TITLES[kind];
  const footer = 'Issue aggiornata da `security-autofix.yml` (chiusa da sola quando non resta niente).';
  let body;
  if (kind === 'pending') {
    body = [
      'Versioni corrette disponibili ma pubblicate da meno di 48 ore: l\'autofix le applica da solo dopo la data prevista.',
      '',
      '| ecosistema | pacchetto | versione | applicabile dal | advisory | forzare subito |',
      '|---|---|---|---|---|---|',
      ...items.map((i) => `| ${i.ecosystem} | ${i.pkg} | ${i.from} → ${i.version} | ${day(i.eta)} | ${ids(i.ghsa)} | \`gh workflow run security-autofix.yml -f force=${i.pkg}@${i.version}\` |`),
      '',
      '`force` salta solo l\'attesa delle 48 ore, mai la verifica di provenienza.',
    ];
  } else if (kind === 'unfixable') {
    body = [
      'Vulnerabilità HIGH/CRITICAL che l\'autofix non può correggere da solo: vanno gestite a mano (aggiornamento, oppure eccezione motivata in `auditConfig.ignoreGhsas` / `.trivyignore.yaml`).',
      '',
      '| ecosistema | pacchetto | versione | advisory | motivo |',
      '|---|---|---|---|---|',
      ...items.map((i) => `| ${i.ecosystem} | ${i.pkg} | ${i.from ?? ''} | ${ids(i.ghsa)} | ${i.reason} |`),
    ];
  } else {
    body = [
      'Correzioni che non hanno passato i test o la verifica: escluse dai giri successivi finché non esce una nuova versione corretta. Per riprovarle togliere la riga dallo stato qui sotto (o chiudere la issue).',
      '',
      '| pacchetto | versione | PR / run |',
      '|---|---|---|',
      ...items.map((i) => `| ${i.pkg} | ${i.version} | ${i.pr ?? ''} |`),
      '',
      `<!-- autofix-state ${JSON.stringify({ excluded: state.excluded })} -->`,
    ];
  }
  return { title, body: [...body, '', footer].join('\n') };
}
