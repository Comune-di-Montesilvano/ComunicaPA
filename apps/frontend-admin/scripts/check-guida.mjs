// Controlla la guida operatori (public/guida/guida.md):
// - ogni ancora citata nel codice (guidaLink('…'), openGuida('…'), costanti
//   di src/guida.ts) corrisponde a un titolo della guida;
// - nessun titolo è ripetuto (rehype-slug aggiungerebbe "-1" all'ancora);
// - nessun tag HTML (la vista lo scarta: resterebbe testo mancante).
// Gira con `pnpm test` (CI). Stessa regola di guidaSlug in src/guida.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(root, 'public/guida/guida.md'), 'utf8');

const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

const errors = [];
const slugs = new Set();
let inCode = false;
for (const line of md.split('\n')) {
  if (line.startsWith('```')) inCode = !inCode;
  if (inCode) continue;
  const m = /^#{1,6} (.+)$/.exec(line);
  if (m) {
    const s = slug(m[1].trim());
    if (slugs.has(s)) errors.push(`titolo ripetuto: "${m[1]}"`);
    slugs.add(s);
  }
  const noComments = line.replace(/<!--.*?-->/g, '').replace(/`[^`]*`/g, '');
  if (/<\/?[a-zA-Z][^>]*>/.test(noComments)) errors.push(`HTML nella guida: ${line.trim()}`);
}

const srcDir = join(root, 'src');
const files = readdirSync(srcDir, { recursive: true }).filter((f) => /\.tsx?$/.test(f));
const refRe = /(?:guidaLink|openGuida)\(\s*'([^']+)'|'([a-z0-9à-ù-]+-[a-z0-9à-ù-]+)'(?=,?\s*(?:$|\n|\}|;))/gm;
for (const f of files) {
  const text = readFileSync(join(srcDir, f), 'utf8');
  const isGuidaModule = f.replace(/\\/g, '/') === 'guida.ts';
  for (const m of text.matchAll(refRe)) {
    const anchor = m[1] ?? (isGuidaModule ? m[2] : undefined);
    if (anchor && !slugs.has(anchor)) errors.push(`${f}: ancora "${anchor}" non presente nella guida`);
  }
}

if (errors.length > 0) {
  console.error('check-guida: ' + errors.length + ' errori');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`check-guida: ok (${slugs.size} titoli)`);
