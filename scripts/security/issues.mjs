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
  if (!m) return { excluded: [], failed: [] };
  try {
    const s = JSON.parse(m[1]);
    return {
      excluded: Array.isArray(s.excluded) ? s.excluded.map(String) : [],
      failed: Array.isArray(s.failed) ? s.failed.filter((f) => f && f.pkg).map((f) => ({ pkg: String(f.pkg), version: String(f.version ?? ''), pr: String(f.pr ?? '') })) : [],
    };
  } catch { return { excluded: [], failed: [] }; }
}

const forceArg = (i) => (i.ecosystem === 'image' ? i.pkg : `${i.pkg}@${i.version}`);

/** Storico delle fallite: righe precedenti + nuove, solo quelle ancora escluse (o senza versione: PR unica). */
function failedHistory(items, state) {
  const out = new Map();
  for (const i of [...(state.failed ?? []), ...items]) {
    const key = `${i.pkg}@${i.version}`;
    if (i.version && !state.excluded.includes(key)) continue;
    out.set(`${key} ${i.pr ?? ''}`, { pkg: i.pkg, version: i.version, pr: i.pr ?? '' });
  }
  return [...out.values()];
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
      ...items.map((i) => `| ${i.ecosystem} | ${i.pkg} | ${i.from} → ${i.version} | ${day(i.eta)} | ${ids(i.ghsa)} | \`gh workflow run security-autofix.yml -f force=${forceArg(i)}\` |`),
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
    const failed = failedHistory(items, state);
    body = [
      'Correzioni che non hanno passato i test o la verifica: escluse dai giri successivi finché non esce una nuova versione corretta. Per riprovarle togliere la riga dallo stato qui sotto (o chiudere la issue).',
      '',
      '| pacchetto | versione | PR / run |',
      '|---|---|---|',
      ...failed.map((i) => `| ${i.pkg} | ${i.version} | ${i.pr} |`),
      '',
      `<!-- autofix-state ${JSON.stringify({ excluded: state.excluded, failed: failed.filter((i) => i.version) })} -->`,
    ];
  }
  return { title, body: [...body, '', footer].join('\n') };
}
