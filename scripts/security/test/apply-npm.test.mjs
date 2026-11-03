import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planNpmFix, applyOverride, directCommand } from '../apply-npm.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'); // copie fisse: l'autofix modifica i file reali
const realWorkspaceYaml = readFileSync(join(fixtures, 'pnpm-workspace.yaml'), 'utf8');
const manifests = [
  { path: 'package.json', json: { name: 'comunicapa', devDependencies: { typescript: '^6.0.3' } } },
  { path: 'apps/backend/package.json', json: { name: 'backend', dependencies: { 'node-forge': '^1.3.1', soap: '^1.14.0' }, devDependencies: { 'fast-check': '~4.10.2' } } },
  { path: 'apps/frontend-admin/package.json', json: { name: 'frontend-admin', dependencies: { exact: '2.0.0' } } },
];
const f = (pkg, version) => ({ pkg, version, ecosystem: 'npm' });

test('node-forge diretta in apps/backend → direct ^1.4.1', () => {
  assert.deepEqual(planNpmFix(f('node-forge', '1.4.0'), '1.4.1', manifests), {
    kind: 'direct', path: 'apps/backend/package.json', workspace: 'backend', depField: 'dependencies',
    pkg: 'node-forge', from: '^1.3.1', to: '1.4.1' });
});

test('follow-redirects transitiva → override follow-redirects@1.16.1: 1.16.2', () => {
  assert.deepEqual(planNpmFix(f('follow-redirects', '1.16.1'), '1.16.2', manifests),
    { kind: 'override', pkg: 'follow-redirects', selector: 'follow-redirects@1.16.1', to: '1.16.2' });
});

test('directCommand: ^ di default, ~ e esatto preservati, -D per devDependencies', () => {
  const d = planNpmFix(f('node-forge', '1.4.0'), '1.4.1', manifests);
  assert.deepEqual(directCommand(d), ['--filter', 'backend', 'add', 'node-forge@1.4.1', '--lockfile-only', '--ignore-scripts', '--config.minimum-release-age=2880']);
  const t = planNpmFix(f('fast-check', '4.10.2'), '4.10.3', manifests);
  assert.deepEqual(directCommand(t), ['--filter', 'backend', 'add', 'fast-check@4.10.3', '--lockfile-only', '--ignore-scripts', '--config.minimum-release-age=2880', '-D', '--save-prefix=~']);
  const e = planNpmFix(f('exact', '2.0.0'), '2.0.1', manifests);
  assert.deepEqual(directCommand(e), ['--filter', 'frontend-admin', 'add', 'exact@2.0.1', '--lockfile-only', '--ignore-scripts', '--config.minimum-release-age=2880', '--save-exact']);
});

test('dipendenza della root → filtro "." (workspace root)', () => {
  const r = planNpmFix(f('typescript', '6.0.3'), '6.0.4', manifests);
  assert.deepEqual(directCommand(r).slice(0, 2), ['-w', 'add']);
});

test('applyOverride aggiunge dopo multer@2.4.0 con commento GHSA e data', () => {
  const fix = { kind: 'override', pkg: 'follow-redirects', selector: 'follow-redirects@1.16.1', to: '1.16.2' };
  const out = applyOverride(realWorkspaceYaml, fix, { ghsa: ['GHSA-mrwp-f3q8-3g9p'], date: '2026-10-31' });
  assert.match(out, /'multer@2\.4\.0': 2\.5\.0\n {2}# GHSA-mrwp-f3q8-3g9p \(2026-10-31, security-autofix\)[^\n]*\n {2}'follow-redirects@1\.16\.1': 1\.16\.2\n/);
  assert.ok(out.includes('auditConfig:\n  ignoreGhsas:'));
  assert.equal(out.replace(/ {2}# GHSA-mrwp[^\n]*\n {2}'follow-redirects@1\.16\.1': 1\.16\.2\n/, ''), realWorkspaceYaml);
});

test('applyOverride idempotente su selettore esistente (aggiorna il valore)', () => {
  const fix = { kind: 'override', pkg: 'multer', selector: 'multer@2.4.0', to: '2.5.1' };
  const out = applyOverride(realWorkspaceYaml, fix, { ghsa: ['GHSA-x'], date: '2026-10-31' });
  assert.match(out, /'multer@2\.4\.0': 2\.5\.1\n/);
  assert.equal(out.split('multer@2.4.0').length - 1, realWorkspaceYaml.split('multer@2.4.0').length - 1);
});

test('applyOverride crea il blocco se assente', () => {
  const fix = { kind: 'override', pkg: 'a', selector: 'a@1.0.0', to: '1.0.1' };
  const out = applyOverride('packages:\n  - apps/*\n', fix, { ghsa: ['GHSA-y'], date: '2026-10-31' });
  assert.match(out, /^packages:\n {2}- apps\/\*\noverrides:\n {2}# GHSA-y \(2026-10-31, security-autofix\)[^\n]*\n {2}'a@1\.0\.0': 1\.0\.1\n$/);
});

test('pacchetto in due versioni: un override per la sola versione vulnerabile', () => {
  const a = planNpmFix(f('dup', '1.0.0'), '1.0.2', manifests);
  assert.equal(a.selector, 'dup@1.0.0');
});

test('CRLF preservato', () => {
  const crlf = realWorkspaceYaml.replace(/\r?\n/g, '\r\n');
  const fix = { kind: 'override', pkg: 'a', selector: 'a@1.0.0', to: '1.0.1' };
  const out = applyOverride(crlf, fix, { ghsa: ['GHSA-y'], date: '2026-10-31' });
  assert.ok(!/[^\r]\n/.test(out));
});

test('review: dichiarata ^4 ma copia vulnerabile 3.x transitiva → override, mai downgrade della diretta', () => {
  const m = [{ path: 'apps/backend/package.json', json: { name: 'backend', dependencies: { lodash: '^4.17.0' } } }];
  assert.deepEqual(planNpmFix(f('lodash', '3.10.0'), '3.10.2', m),
    { kind: 'override', pkg: 'lodash', selector: 'lodash@3.10.0', to: '3.10.2' });
});

test('review: dev che copre la versione ma prod no → sceglie il manifest che la copre', () => {
  const m = [
    { path: 'apps/a/package.json', json: { name: 'a', dependencies: { x: '^2.0.0' } } },
    { path: 'apps/b/package.json', json: { name: 'b', devDependencies: { x: '^1.0.0' } } },
  ];
  assert.equal(planNpmFix(f('x', '1.2.0'), '1.2.1', m).path, 'apps/b/package.json');
});

test('review: specifier workspace:/npm: → override', () => {
  const m = [{ path: 'apps/a/package.json', json: { name: 'a', dependencies: { x: 'workspace:*' } } }];
  assert.equal(planNpmFix(f('x', '1.0.0'), '1.0.1', m).kind, 'override');
});
