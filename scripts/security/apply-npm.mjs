#!/usr/bin/env node
// Applicazione delle correzioni npm scelte da chooseVersion.
//  - dipendenza dichiarata in un package.json del workspace → `pnpm add <pkg>@<versione>`
//    (lockfile alla versione esatta scelta, range salvato con lo stesso prefisso di prima);
//  - transitiva → override in pnpm-workspace.yaml limitato alla versione installata
//    vulnerabile (stesso schema di 'multer@2.4.0'), commentato con GHSA e data.
//
//   node scripts/security/apply-npm.mjs --fixes fixes.json
//   fixes.json: [{ pkg, version (installata), to, ghsa: [..] }]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { satisfies } from './semver-lite.mjs';
import { MIN_AGE_HOURS } from './choose-version.mjs';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

export function planNpmFix(finding, version, manifests) {
  // `direct` solo se il range dichiarato copre la versione vulnerabile installata: altrimenti la
  // copia vulnerabile è un'altra (transitiva, altra major) e `pnpm add` cambierebbe quella
  // sbagliata, fino a declassare la dipendenza diretta.
  for (const m of manifests) {
    for (const depField of FIELDS) {
      const from = m.json[depField]?.[finding.pkg];
      if (from && satisfies(finding.version, from)) {
        return { kind: 'direct', path: m.path, workspace: m.json.name, depField, pkg: finding.pkg, from, to: version };
      }
    }
  }
  return { kind: 'override', pkg: finding.pkg, selector: `${finding.pkg}@${finding.version}`, to: version };
}

// Anche le dipendenze NUOVE o allargate dalla versione scelta (risolte da pnpm) devono avere
// almeno 48h: pnpm >= 10.16 rifiuta le versioni più giovani (minuti).
export const MIN_AGE_FLAG = `--config.minimum-release-age=${MIN_AGE_HOURS * 60}`;

export function directCommand(fix) {
  const target = fix.path === 'package.json' ? ['-w'] : ['--filter', fix.workspace];
  const args = [...target, 'add', `${fix.pkg}@${fix.to}`, '--lockfile-only', '--ignore-scripts', MIN_AGE_FLAG];
  if (fix.depField === 'devDependencies') args.push('-D');
  if (fix.depField === 'optionalDependencies') args.push('-O');
  if (fix.from.startsWith('~')) args.push('--save-prefix=~');
  else if (/^\d/.test(fix.from)) args.push('--save-exact');
  return args;
}

export function applyOverride(text, fix, { ghsa, date }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entry = `  '${fix.selector}': ${fix.to}`;
  const comment = `  # ${ghsa.join(' ')} (${date}, security-autofix): rimuovere quando il padre si aggiorna`;

  const start = lines.findIndex((l) => /^overrides:\s*$/.test(l));
  if (start === -1) {
    const body = text.endsWith(eol) ? text : text + eol;
    return `${body}overrides:${eol}${comment}${eol}${entry}${eol}`;
  }
  let lastEntry = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^\s+\S/.test(lines[i]) && !/^\s+#/.test(lines[i])) lastEntry = i;
  }
  const existing = lines.findIndex((l, i) => i > start && i <= lastEntry
    && new RegExp(`^\\s+['"]?${fix.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?:`).test(l));
  if (existing !== -1) lines[existing] = entry;
  else lines.splice(lastEntry + 1, 0, comment, entry);
  return lines.join(eol);
}

export function workspaceManifests(root) {
  const out = [{ path: 'package.json', json: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) }];
  for (const dir of ['apps', 'packages']) {
    if (!existsSync(join(root, dir))) continue;
    for (const d of readdirSync(join(root, dir))) {
      const p = join(dir, d, 'package.json');
      if (existsSync(join(root, p))) out.push({ path: p.replaceAll('\\', '/'), json: JSON.parse(readFileSync(join(root, p), 'utf8')) });
    }
  }
  return out;
}

/** Applica le correzioni npm nel workspace `root`; ritorna le correzioni con il tipo applicato. */
export function applyNpmFixes(fixes, root = '.') {
  const manifests = workspaceManifests(root);
  const date = new Date().toISOString().slice(0, 10);
  const wsPath = join(root, 'pnpm-workspace.yaml');
  let overridden = false;
  const applied = [];
  for (const f of fixes) {
    const plan = planNpmFix({ pkg: f.pkg, version: f.version }, f.to, manifests);
    if (plan.kind === 'override') {
      writeFileSync(wsPath, applyOverride(readFileSync(wsPath, 'utf8'), plan, { ghsa: f.ghsa, date }));
      overridden = true;
    } else {
      execFileSync('pnpm', directCommand(plan), { cwd: root, stdio: 'inherit' });
    }
    applied.push({ ...f, kind: plan.kind });
  }
  if (overridden) execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', MIN_AGE_FLAG], { cwd: root, stdio: 'inherit' });
  return applied;
}

function main() {
  const { values } = parseArgs({ options: { fixes: { type: 'string' }, root: { type: 'string', default: '.' } } });
  console.log(JSON.stringify(applyNpmFixes(JSON.parse(readFileSync(values.fixes, 'utf8')), values.root)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
