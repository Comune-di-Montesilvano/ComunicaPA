#!/usr/bin/env node
// Orchestratore dell'autofix di sicurezza (security-autofix.yml): rileva → sceglie → applica
// → verifica. Lavora sul working tree; branch, commit, PR e issue li fa il workflow.
//
// Directory pnpm, Dockerfile e parte pip da autofix.config.json (config.mjs).
//
//   node scripts/security/autofix.mjs --pnpm [<dir>=]audit.json ... [--trivy-fs fs.json]
//        [--trivy-image <app>=<file> ...] [--state state.json] [--force pkg@ver]
//        [--only <pkg>] [--dry-run] [--no-verify] --out summary.json
//
// summary.json: { fixed[], pending[], unfixable[], verification: 'ok'|'failed'|'skipped', details? }
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parsePnpmAudit, parseTrivy, diffFindings, readIgnoreGhsas } from './findings.mjs';
import { chooseVersion } from './choose-version.mjs';
import { fetchCandidates } from './npm-registry.mjs';
import { applyNpmFixes, planNpmFix, workspaceManifests } from './apply-npm.mjs';
import { checkImages, runtimeImage } from './base-image.mjs';
import { loadConfig, findingKey } from './config.mjs';

/** Ore dopo cui una PR autofix ancora aperta si considera fallita (la merge queue impiega meno). */
export const FAILED_AFTER_HOURS = 6;

/**
 * @param {{ openPrs: { number:number, mode:'single'|'split', pkg?:string, createdAt:Date, failedChecks:boolean }[], now: Date }} p
 * @returns {{ mode: 'single'|'split'|'update'|'wait', failed: object[], replace?: object }}
 */
export function nextMode({ openPrs, now }) {
  const isFailed = (pr) => pr.failedChecks || now - pr.createdAt >= FAILED_AFTER_HOURS * 3600e3;
  const failed = openPrs.filter(isFailed);
  const running = openPrs.filter((pr) => !isFailed(pr));
  // PR unica in corso: si rifà il giro e la si sostituisce se l'insieme di correzioni è cambiato.
  if (running.length === 1 && running[0].mode === 'single' && !failed.some((pr) => pr.mode === 'single')) {
    return { mode: 'update', failed, replace: running[0] };
  }
  if (running.length) return { mode: 'wait', failed };
  if (failed.some((pr) => pr.mode === 'single')) return { mode: 'split', failed };
  return { mode: 'single', failed };
}

/** Un gruppo per ecosystem+pkg+versione installata, con range vulnerabili e advisory uniti. */
export function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = findingKey(f);
    const g = groups.get(key) ?? { key, ecosystem: f.ecosystem, dir: f.dir ?? '.', pkg: f.pkg, current: f.version, vulnerableRanges: [], fixedRanges: [], ghsa: [], targets: [] };
    if (f.vulnerableRange && !g.vulnerableRanges.includes(f.vulnerableRange)) g.vulnerableRanges.push(f.vulnerableRange);
    if (f.fixedRange && !g.fixedRanges.includes(f.fixedRange)) g.fixedRanges.push(f.fixedRange);
    const id = [f.id, ...f.aliases].find((x) => x.startsWith('GHSA-')) ?? f.id;
    if (!g.ghsa.includes(id)) g.ghsa.push(id);
    if (!g.targets.includes(f.target)) g.targets.push(f.target);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Versioni (o digest) esclusi per un pacchetto/immagine da voci `nome@versione`. */
export function skipFor(excluded, name) {
  return excluded.filter((e) => e.lastIndexOf('@') > 0 && e.slice(0, e.lastIndexOf('@')) === name)
    .map((e) => e.slice(e.lastIndexOf('@') + 1));
}

/**
 * PR per pacchetto: in modalità split, oppure quando la verifica locale della PR unica fallisce
 * (si rifà ogni correzione da sola per trovare quella responsabile, senza trattenere le altre).
 */
export function shouldSplit({ mode, fixed, verification }) {
  if (fixed === 0 || mode === 'wait') return false;
  return mode === 'split' || verification === 'failed';
}

/** Marker `<!-- autofix-fix pkg@versione -->` dal body di una PR autofix. */
export function prFixMarkers(body) {
  return [...String(body ?? '').matchAll(/<!-- autofix-fix (\S+) -->/g)].map((m) => m[1]);
}

/** La PR aperta (marker pkg@versione) contiene già esattamente queste correzioni? */
export function sameFixes(prPkgs, fixed) {
  const a = [...new Set(prPkgs)].sort(), b = [...new Set(fixed.map((f) => `${f.pkg}@${f.version}`))].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Righe `pkg versione ok|failed` del giro per pacchetto → voci da escludere (solo le fallite). */
export function splitExclusions(lines) {
  return lines.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 3 && p[2] === 'failed')
    .map(([pkg, ver]) => `${pkg}@${ver}`);
}

/** Range con `||` → specifier PEP 440 separati (pip_fix li tratta come OR). */
export function pipRanges(ranges) {
  return ranges.flatMap((r) => r.split('||').map((s) => s.trim()).filter(Boolean));
}

/** I finding dei gruppi corretti devono sparire e nessun finding nuovo deve comparire. */
export function verifyFixed({ before, after, fixedKeys }) {
  const fixedIds = new Map();
  const where = (f) => `${f.ecosystem}:${f.dir ?? '.'}:${f.pkg}`;
  for (const f of before) {
    if (!fixedKeys.includes(findingKey(f))) continue;
    const k = where(f);
    const s = fixedIds.get(k) ?? new Set();
    [f.id, ...f.aliases].forEach((i) => s.add(i));
    fixedIds.set(k, s);
  }
  const remaining = after.filter((f) => [f.id, ...f.aliases].some((i) => fixedIds.get(where(f))?.has(i)));
  const introduced = diffFindings(after, before);
  return { ok: remaining.length === 0 && introduced.length === 0, remaining, introduced };
}

export function prBody({ fixed, pending, unfixable }) {
  const lines = [
    'Correzioni di sicurezza applicate da `security-autofix.yml` (design: `docs/superpowers/specs/2026-11-02-security-autofix-design.md`).',
    'Versione corretta più bassa, pubblicata da almeno 48 ore, provenienza verificata. Merge automatico dopo i test della merge queue.',
    '',
    '| ecosistema | pacchetto | da | a | tipo | advisory | età | provenienza |',
    '|---|---|---|---|---|---|---|---|',
    ...fixed.map((f) => `| ${f.ecosystem} | ${f.pkg} | ${f.from} | ${f.version} | ${f.kind} | ${f.ghsa.join(' ')} | ${f.ageHours ?? '?'}h | ${f.provenance ?? ''} |`),
  ];
  if (pending.length) lines.push('', `In attesa (< 48h): ${pending.map((p) => `${p.pkg}@${p.version}`).join(', ')}.`);
  if (unfixable.length) lines.push('', `Non correggibili: ${unfixable.map((u) => `${u.pkg} (${u.reason})`).join(', ')}.`);
  return lines.join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ageHours = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 3600e3) : null);

/** `--pnpm file` (radice) o `--pnpm dir=file` → [[dir, file]]; solo directory della config. */
export function pnpmInputs(specs, config) {
  return specs.map((s) => {
    const i = s.indexOf('=');
    const [dir, file] = i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ['.', s];
    if (!config.pnpmDirs.includes(dir)) throw new Error(`--pnpm: ${dir} non è in pnpmDirs di autofix.config.json`);
    return [dir, file];
  });
}

/** Finding npm di una directory pnpm, con la directory e le eccezioni del suo pnpm-workspace.yaml. */
function npmFindings(dir, auditJson) {
  const ignoreGhsas = readIgnoreGhsas(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'));
  return parsePnpmAudit(auditJson, { ignoreGhsas })
    .map((f) => ({ ...f, dir, target: dir === '.' ? f.target : `${dir}/${f.target}` }));
}

function scanNow(config) {
  const out = [];
  for (const dir of config.pnpmDirs) {
    const audit = spawnSync('pnpm', ['audit', '--prod', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    out.push(...npmFindings(dir, JSON.parse(audit.stdout)));
  }
  if (config.pip) {
    const trivy = spawnSync('trivy', ['fs', '--quiet', '--skip-db-update', '--scanners', 'vuln', '--severity', 'CRITICAL,HIGH',
      '--ignore-unfixed', '--ignorefile', '.trivyignore.yaml', '--skip-dirs', '.cache', '--format', 'json', '.'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (trivy.status !== 0) throw new Error(`trivy: ${trivy.stderr.slice(-300)}`);
    out.push(...parseTrivy(JSON.parse(trivy.stdout)).filter((f) => f.ecosystem === 'pip'));
  }
  return out;
}

async function main() {
  const { values: a } = parseArgs({ options: {
    pnpm: { type: 'string', multiple: true, default: [] }, 'trivy-fs': { type: 'string' }, 'trivy-image': { type: 'string', multiple: true, default: [] },
    state: { type: 'string' }, force: { type: 'string' }, only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, 'no-verify': { type: 'boolean', default: false },
    out: { type: 'string' },
  } });
  const config = loadConfig();
  const excluded = a.state ? readJson(a.state).excluded ?? [] : [];
  // --force pkg@versione (npm/pip, la @ iniziale degli scope non conta) oppure image:tag.
  const at = a.force ? a.force.lastIndexOf('@') : -1;
  const [forcePkg, forceVer] = !a.force ? [] : at > 0 ? [a.force.slice(0, at), a.force.slice(at + 1)] : [a.force, undefined];
  const dry = a['dry-run'];

  // npm dal pnpm audit (fonte con range e advisory), pip dal Trivy fs, immagini dagli scan di latest.
  const before = [
    ...pnpmInputs(a.pnpm, config).flatMap(([dir, file]) => npmFindings(dir, readJson(file))),
    ...(config.pip && a['trivy-fs'] ? parseTrivy(readJson(a['trivy-fs'])).filter((f) => f.ecosystem === 'pip') : []),
  ];
  const imageApps = new Map();
  for (const spec of a['trivy-image']) {
    const [app, file] = spec.split('=');
    const f = parseTrivy(readJson(file)).filter((x) => x.ecosystem === 'os' || x.ecosystem === 'image-lang');
    if (f.length) imageApps.set(app, f);
  }

  let groups = groupFindings(before);
  if (a.only) groups = groups.filter((g) => g.pkg === a.only);
  const fixed = [], pending = [], unfixable = [];

  // npm
  const npmFixes = new Map(); // dir → correzioni
  for (const g of groups.filter((x) => x.ecosystem === 'npm')) {
    let r;
    try {
      const { candidates, previous } = await fetchCandidates(g.pkg, g.current);
      r = chooseVersion({ current: g.current, vulnerableRanges: g.vulnerableRanges, fixedRanges: g.fixedRanges,
        skipVersions: skipFor(excluded, g.pkg), candidates, previous, now: new Date(),
        forceVersion: forcePkg === g.pkg ? forceVer : undefined });
      if (r.action === 'fix') {
        const c = candidates.find((x) => x.version === r.version);
        r.ageHours = ageHours(c.publishedAt);
        r.provenance = c.provenanceRepo ? `SLSA ${c.provenanceRepo}` : 'firma registry';
      }
    } catch (e) { r = { action: 'unfixable', reason: `registry: ${e.message}` }; }
    const item = { ecosystem: 'npm', dir: g.dir, pkg: g.pkg, from: g.current, ghsa: g.ghsa, key: g.key, ...r };
    if (r.action === 'fix') {
      npmFixes.set(g.dir, [...(npmFixes.get(g.dir) ?? []), { pkg: g.pkg, version: g.current, to: r.version, ghsa: g.ghsa }]);
      fixed.push(item);
    }
    else (r.action === 'pending' ? pending : unfixable).push(item);
  }
  for (const [dir, fixes] of npmFixes) {
    const manifests = workspaceManifests(dir);
    for (const f of fixed.filter((x) => x.ecosystem === 'npm' && x.dir === dir)) {
      f.kind = planNpmFix({ pkg: f.pkg, version: f.from }, f.version, manifests).kind;
    }
    if (!dry) applyNpmFixes(fixes, dir);
  }

  // pip
  const pipGroups = config.pip ? groups.filter((x) => x.ecosystem === 'pip') : [];
  if (pipGroups.length) {
    // Percorsi relativi dentro il repo: PYTHON_CMD può essere un wrapper che esegue Python in
    // un container (stessa versione dell'header pip-compile) con il repo montato.
    mkdirSync('.cache/autofix', { recursive: true });
    const dir = mkdtempSync('.cache/autofix/pip-');
    writeFileSync(join(dir, 'in.json'), JSON.stringify(pipGroups.map((g) => ({ pkg: g.pkg, current: g.current,
      vulnerable_ranges: pipRanges(g.vulnerableRanges), ghsa: g.ghsa, skip_versions: skipFor(excluded, g.pkg),
      force_version: forcePkg === g.pkg ? forceVer : undefined }))));
    const args = ['scripts/security/pip_fix.py', '--fixes', join(dir, 'in.json'), '--dir', config.pip?.dir, '--out', join(dir, 'out.json')];
    if (dry) args.push('--dry-run');
    execFileSync(process.env.PYTHON_CMD || 'python3', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    for (const r of readJson(join(dir, 'out.json'))) {
      const g = pipGroups.find((x) => x.pkg === r.pkg);
      const item = { ecosystem: 'pip', pkg: r.pkg, from: r.current, ghsa: r.ghsa, key: g.key, ...r };
      if (r.action === 'fix') fixed.push({ ...item, provenance: 'hash + PEP 740' });
      else (r.action === 'pending' ? pending : unfixable).push(item);
    }
  }

  // immagini base: un image:tag per app con CVE ancora presenti nella latest pubblicata
  if (!a.only || a.only.includes(':')) {
    const refs = new Map();
    for (const [app, f] of imageApps) {
      const dockerfile = config.dockerfiles[app];
      if (!dockerfile) throw new Error(`--trivy-image: ${app} non è in dockerfiles di autofix.config.json`);
      const ref = runtimeImage(readFileSync(dockerfile, 'utf8'));
      if (ref && (!a.only || a.only === ref)) refs.set(ref, [...(refs.get(ref) ?? []), ...f]);
    }
    for (const r of checkImages([...refs.keys()], { config, force: Boolean(a.force && refs.has(a.force)), dryRun: dry,
      skip: Object.fromEntries([...refs.keys()].map((ref) => [ref, skipFor(excluded, ref)])) })) {
      const ref = `${r.image}:${r.tag}`;
      const ghsa = [...new Set(refs.get(ref).map((f) => f.id))];
      const item = { ecosystem: 'image', pkg: ref, from: r.from, version: r.digest, ghsa, key: `image:${ref}`, ...r, kind: 'digest' };
      (r.action === 'fix' ? fixed : r.action === 'pending' ? pending : unfixable).push(item);
    }
  }

  // verifica locale (npm + pip): le immagini le verifica trivy-image in merge queue
  let verification = 'skipped', details;
  const localFixed = fixed.filter((f) => f.ecosystem !== 'image').map((f) => f.key);
  if (!dry && !a['no-verify'] && localFixed.length) {
    try {
      const after = scanNow(config);
      const v = verifyFixed({ before, after, fixedKeys: localFixed });
      verification = v.ok ? 'ok' : 'failed';
      details = { remaining: v.remaining, introduced: v.introduced };
    } catch (e) { verification = 'failed'; details = { error: e.message }; }
  }

  const summary = { fixed, pending, unfixable, verification, details, prBody: prBody({ fixed, pending, unfixable }) };
  if (a.out) writeFileSync(a.out, JSON.stringify(summary, null, 1));
  console.log(`autofix: ${fixed.length} corrette, ${pending.length} in attesa, ${unfixable.length} non correggibili, verifica ${verification}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
