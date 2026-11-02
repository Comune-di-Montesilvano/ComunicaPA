import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePnpmAudit, parseTrivy, diffFindings, readIgnoreGhsas } from '../findings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'); // copie fisse: l'autofix modifica i file reali
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const cli = join(here, '..', 'diff-gate.mjs');

const pnpmMain = () => parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: ['GHSA-86w9-cpqp-85rv'] });

test('pnpm: node-forge e follow-redirects da main', () => {
  const f = pnpmMain();
  assert.ok(f.some((x) => x.pkg === 'node-forge' && x.id === 'GHSA-7wch-p9px-956x' && x.version === '1.4.0'));
  assert.ok(f.some((x) => x.pkg === 'follow-redirects' && x.fixedRange === '>=1.16.2'));
  assert.ok(!f.some((x) => x.id === 'GHSA-86w9-cpqp-85rv'));
  assert.ok(f.every((x) => ['HIGH', 'CRITICAL'].includes(x.severity)));
  assert.equal(f.length, 6); // 5 node-forge + 1 follow-redirects (GHSA-86w9 gia esclusa da pnpm)
  assert.ok(f.every((x) => x.ecosystem === 'npm' && x.tool === 'pnpm'));
});

test('pnpm: ignoreGhsas esclude l advisory indicata', () => {
  const f = parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: ['GHSA-mrwp-f3q8-3g9p'] });
  assert.ok(!f.some((x) => x.pkg === 'follow-redirects'));
});

test('pnpm: advisory su piu versioni installate → un finding per versione', () => {
  const json = { advisories: { 1: { module_name: 'x', github_advisory_id: 'GHSA-xxxx-yyyy-zzzz', severity: 'high',
    vulnerable_versions: '<2.0.0', patched_versions: '>=2.0.0',
    findings: [{ version: '1.0.0', paths: ['a>x'] }, { version: '1.5.0', paths: ['b>x'] }] } } };
  const f = parsePnpmAudit(json, { ignoreGhsas: [] });
  assert.deepEqual(f.map((x) => x.version).sort(), ['1.0.0', '1.5.0']);
});

test('diff: base uguale → nessun nuovo', () => {
  const f = pnpmMain();
  assert.deepEqual(diffFindings(f, f), []);
});

test('diff: finding aggiunto → solo quello', () => {
  const base = pnpmMain().filter((x) => x.pkg !== 'follow-redirects');
  const nuovi = diffFindings(pnpmMain(), base);
  assert.equal(nuovi.length, 1);
  assert.equal(nuovi[0].pkg, 'follow-redirects');
});

test('diff: stesso problema GHSA in testa e CVE alias in base → non nuovo', () => {
  const head = [{ tool: 'trivy', ecosystem: 'npm', pkg: 'p', version: '1.0.0', id: 'GHSA-aaaa-bbbb-cccc', aliases: [], severity: 'HIGH', vulnerableRange: null, fixedRange: null, fixedVersions: ['1.0.1'], target: 'pnpm-lock.yaml' }];
  const base = [{ ...head[0], id: 'CVE-2099-1', aliases: ['GHSA-aaaa-bbbb-cccc'] }];
  assert.deepEqual(diffFindings(head, base), []);
});

test('diff: stessa advisory, versione installata diversa → non nuovo', () => {
  const base = pnpmMain();
  const head = base.map((x) => (x.pkg === 'node-forge' ? { ...x, version: '1.3.9' } : x));
  assert.deepEqual(diffFindings(head, base), []);
});

test('trivy fs: lockfile pnpm → npm, alias GHSA da VendorIDs', () => {
  const f = parseTrivy(load('trivy-fs-main.json'));
  assert.equal(f.length, 6);
  const fr = f.find((x) => x.pkg === 'follow-redirects');
  assert.equal(fr.ecosystem, 'npm');
  assert.equal(fr.id, 'CVE-2026-116689');
  assert.deepEqual(fr.aliases, ['GHSA-mrwp-f3q8-3g9p']);
  assert.deepEqual(fr.fixedVersions, ['1.16.2']);
  assert.equal(fr.vulnerableRange, '<1.16.2');
});

test('trivy image: ecosystem os / image-lang / pip, solo HIGH+', () => {
  const f = parseTrivy(load('trivy-image-sample.json'));
  assert.deepEqual(f.map((x) => `${x.ecosystem}:${x.pkg}`).sort(),
    ['image-lang:example-bundled', 'os:libexample', 'pip:examplepy']);
  const b = f.find((x) => x.pkg === 'example-bundled');
  assert.deepEqual(b.fixedVersions, ['2.0.5', '1.9.9']);
  assert.equal(b.vulnerableRange, '<1.9.9 || >=1.10.0 <2.0.5'); // 2.0.0-2.0.4 vulnerabili
});

test('readIgnoreGhsas legge GHSA-86w9-cpqp-85rv dal pnpm-workspace.yaml reale', () => {
  const ids = readIgnoreGhsas(readFileSync(join(fixtures, 'pnpm-workspace.yaml'), 'utf8'));
  assert.deepEqual(ids, ['GHSA-86w9-cpqp-85rv']);
});

test('readIgnoreGhsas: nessun blocco → []', () => {
  assert.deepEqual(readIgnoreGhsas('packages:\n  - apps/*\n'), []);
});

const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'dg-'));

test('cli: base mancante → exit 2', () => {
  const r = run('--format', 'pnpm', '--head', join(here, 'fixtures', 'pnpm-audit-main.json'), '--base', join(tmp(), 'assente.json'));
  assert.equal(r.status, 2);
});

test('cli: base non JSON → exit 2', () => {
  const d = tmp(); writeFileSync(join(d, 'b.json'), 'npm ERR! boom');
  const r = run('--format', 'pnpm', '--head', join(here, 'fixtures', 'pnpm-audit-main.json'), '--base', join(d, 'b.json'));
  assert.equal(r.status, 2);
});

test('cli: base JSON senza struttura attesa → exit 2', () => {
  const d = tmp(); writeFileSync(join(d, 'b.json'), '{"error":"registry down"}');
  const r = run('--format', 'pnpm', '--head', join(here, 'fixtures', 'pnpm-audit-main.json'), '--base', join(d, 'b.json'));
  assert.equal(r.status, 2);
});

test('cli: nuovo finding → exit 1 e pkg nello stdout', () => {
  const d = tmp();
  const base = load('pnpm-audit-main.json');
  for (const [k, v] of Object.entries(base.advisories)) if (v.module_name === 'follow-redirects') delete base.advisories[k];
  writeFileSync(join(d, 'b.json'), JSON.stringify(base));
  const r = run('--format', 'pnpm', '--head', join(here, 'fixtures', 'pnpm-audit-main.json'), '--base', join(d, 'b.json'),
    '--workspace', join(fixtures, 'pnpm-workspace.yaml'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /follow-redirects/);
  assert.doesNotMatch(r.stdout, /node-forge/);
});

test('cli: stessa base → exit 0', () => {
  const f = join(here, 'fixtures', 'pnpm-audit-main.json');
  assert.equal(run('--format', 'pnpm', '--head', f, '--base', f).status, 0);
});

test('cli: --base-empty → tutto nuovo', () => {
  const r = run('--format', 'trivy', '--head', join(here, 'fixtures', 'trivy-image-sample.json'), '--base-empty');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /examplepy/);
});

test('review: FixedVersion su più linee → range per linea, conservativo tra le linee', () => {
  const json = { SchemaVersion: 2, Results: [{ Target: 'requirements.txt', Class: 'lang-pkgs', Type: 'pip', Vulnerabilities: [
    { VulnerabilityID: 'CVE-2099-9', PkgName: 'p', InstalledVersion: '5.1.0', FixedVersion: '4.2.17, 5.0.10, 5.1.4', Severity: 'HIGH' }] }] };
  const [f] = parseTrivy(json);
  assert.equal(f.vulnerableRange, '<4.2.17 || >=4.3.0 <5.0.10 || >=5.1.0 <5.1.4');
});
