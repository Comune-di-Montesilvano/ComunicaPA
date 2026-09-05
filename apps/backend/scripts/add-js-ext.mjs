// apps/backend/scripts/add-js-ext.mjs
// Codemod one-off: aggiunge estensione .js ai relative import/export/
// dynamic-import per compatibilita NodeNext ESM. Verificato sufficiente
// per questo backend (nessun caso limite oltre from/import() con path
// relativo senza estensione - vedi spec 2026-09-05).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2] ?? 'src';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const RE = /((?:from|import\()\s*)(['"])(\.[^'"]*)\2/g;
let changedFiles = 0;
let totalSubs = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  let subs = 0;
  const next = src.replace(RE, (match, prefix, quote, specifier) => {
    if (/\.(js|json|css|node)$/.test(specifier)) return match;
    subs++;
    return `${prefix}${quote}${specifier}.js${quote}`;
  });
  if (subs > 0) {
    writeFileSync(file, next, 'utf8');
    changedFiles++;
    totalSubs += subs;
  }
}

console.log(`File modificati: ${changedFiles}, sostituzioni: ${totalSubs}`);
