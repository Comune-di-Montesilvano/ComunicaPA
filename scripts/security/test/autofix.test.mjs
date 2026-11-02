import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextMode, groupFindings, verifyFixed, prBody, FAILED_AFTER_HOURS, skipFor, pipRanges, shouldSplit, splitExclusions, sameFixes, prFixMarkers } from '../autofix.mjs';
import { parsePnpmAudit } from '../findings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const now = new Date('2026-11-02T02:30:00Z');
const h = (n) => new Date(now - n * 3600e3);

test('nessuna PR aperta → single', () => assert.deepEqual(nextMode({ openPrs: [], now }), { mode: 'single', failed: [] }));

test('PR unica recente senza check falliti → update (sostituita se le correzioni cambiano)', () => {
  const pr = { number: 1, mode: 'single', pkg: ['a@1'], createdAt: h(1), failedChecks: false };
  assert.deepEqual(nextMode({ openPrs: [pr], now }), { mode: 'update', failed: [], replace: pr });
});

test('split in corso → wait', () => {
  assert.equal(nextMode({ openPrs: [{ number: 1, mode: 'split', pkg: ['a@1'], createdAt: h(1), failedChecks: false }], now }).mode, 'wait');
});

test('sameFixes: stesso insieme pkg@versione → nessuna sostituzione', () => {
  assert.equal(sameFixes(['a@1', 'b@2'], [{ pkg: 'b', version: '2' }, { pkg: 'a', version: '1' }]), true);
  assert.equal(sameFixes(['a@1'], [{ pkg: 'a', version: '1' }, { pkg: 'c', version: '3' }]), false);
});

test('shouldSplit: update si comporta come single', () => {
  assert.equal(shouldSplit({ mode: 'update', fixed: 2, verification: 'failed' }), true);
  assert.equal(shouldSplit({ mode: 'update', fixed: 2, verification: 'ok' }), false);
});

test(`single aperta da più di ${FAILED_AFTER_HOURS}h → split, PR fallita da chiudere`, () => {
  const pr = { number: 1, mode: 'single', createdAt: h(FAILED_AFTER_HOURS + 1), failedChecks: false };
  assert.deepEqual(nextMode({ openPrs: [pr], now }), { mode: 'split', failed: [pr] });
});

test('single con check falliti → split subito', () => {
  const pr = { number: 1, mode: 'single', createdAt: h(1), failedChecks: true };
  assert.equal(nextMode({ openPrs: [pr], now }).mode, 'split');
});

test('split fallita → single per il resto, la fallita va esclusa', () => {
  const bad = { number: 2, mode: 'split', pkg: 'node-forge@1.4.1', createdAt: h(1), failedChecks: true };
  assert.deepEqual(nextMode({ openPrs: [bad], now }), { mode: 'single', failed: [bad] });
});

test('split fallita + altra split in corso → wait (nessuna nuova PR), fallita comunque segnalata', () => {
  const bad = { number: 2, mode: 'split', pkg: 'a@1', createdAt: h(1), failedChecks: true };
  const ok = { number: 3, mode: 'split', pkg: 'b@1', createdAt: h(1), failedChecks: false };
  assert.deepEqual(nextMode({ openPrs: [bad, ok], now }), { mode: 'wait', failed: [bad] });
});

test('groupFindings: npm per pkg+versione installata, range e GHSA uniti', () => {
  const g = groupFindings(parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: [] }));
  const forge = g.find((x) => x.pkg === 'node-forge');
  assert.equal(forge.ecosystem, 'npm');
  assert.equal(forge.current, '1.4.0');
  assert.equal(forge.ghsa.length, 5);
  assert.deepEqual(forge.vulnerableRanges, ['<=1.4.0']);
  assert.equal(g.filter((x) => x.pkg === 'node-forge').length, 1);
});

test('groupFindings: trivy usa gli alias GHSA quando ci sono', () => {
  const g = groupFindings([{ tool: 'trivy', ecosystem: 'pip', pkg: 'x', version: '1.0', id: 'CVE-1', aliases: ['GHSA-q'], severity: 'HIGH', vulnerableRange: '<1.1', fixedRange: null, fixedVersions: ['1.1'], target: 'requirements.txt' }]);
  assert.deepEqual(g[0].ghsa, ['GHSA-q']);
});

test('verifyFixed: corretti spariti e nessun nuovo → ok', () => {
  const before = parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: [] });
  const after = before.filter((f) => f.pkg !== 'node-forge');
  assert.deepEqual(verifyFixed({ before, after, fixedKeys: ['npm:node-forge@1.4.0'] }), { ok: true, remaining: [], introduced: [] });
});

test('verifyFixed: corretto ancora presente → ko', () => {
  const before = parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: [] });
  const r = verifyFixed({ before, after: before, fixedKeys: ['npm:node-forge@1.4.0'] });
  assert.equal(r.ok, false);
  assert.equal(r.remaining.length, 5);
});

test('verifyFixed: nuova vulnerabilità introdotta → ko', () => {
  const before = [];
  const after = parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: [] }).slice(0, 1);
  const r = verifyFixed({ before, after, fixedKeys: [] });
  assert.equal(r.ok, false);
  assert.equal(r.introduced.length, 1);
});

test('prBody: tabella con da/a, tipo, GHSA, età e provenienza', () => {
  const body = prBody({ fixed: [{ ecosystem: 'npm', pkg: 'node-forge', from: '1.4.0', version: '1.4.1', kind: 'direct',
    ghsa: ['GHSA-7wch-p9px-956x'], ageHours: 94, provenance: 'firma registry' }], pending: [], unfixable: [] });
  assert.match(body, /\| node-forge \| 1\.4\.0 \| 1\.4\.1 \| direct \| GHSA-7wch-p9px-956x \| 94h \| firma registry \|/);
});

test('review: skipFor estrae le versioni escluse del pacchetto (scope npm e image:tag@digest)', () => {
  const ex = ['node-forge@1.4.1', '@scope/pkg@2.0.0', 'node:26-alpine@sha256:abc', 'node-forge-x@9'];
  assert.deepEqual(skipFor(ex, 'node-forge'), ['1.4.1']);
  assert.deepEqual(skipFor(ex, '@scope/pkg'), ['2.0.0']);
  assert.deepEqual(skipFor(ex, 'node:26-alpine'), ['sha256:abc']);
});

test('review: groupFindings raccoglie patched_versions in fixedRanges', () => {
  const g = groupFindings(parsePnpmAudit(load('pnpm-audit-main.json'), { ignoreGhsas: [] }));
  assert.deepEqual(g.find((x) => x.pkg === 'follow-redirects').fixedRanges, ['>=1.16.2']);
});

test('review: pipRanges divide gli OR in specifier separati', () => {
  assert.deepEqual(pipRanges(['<4.2.17 || >=4.3.0 <5.0.10', '<1']), ['<4.2.17', '>=4.3.0 <5.0.10', '<1']);
});

test('review: verifica fallita in single → split (mai esclusione in blocco)', () => {
  assert.equal(shouldSplit({ mode: 'single', fixed: 2, verification: 'failed' }), true);
  assert.equal(shouldSplit({ mode: 'single', fixed: 2, verification: 'ok' }), false);
  assert.equal(shouldSplit({ mode: 'split', fixed: 1, verification: 'ok' }), true);
  assert.equal(shouldSplit({ mode: 'split', fixed: 0, verification: 'ok' }), false);
  assert.equal(shouldSplit({ mode: 'wait', fixed: 3, verification: 'failed' }), false);
});

test('review: esclusi solo i pacchetti la cui verifica singola fallisce', () => {
  const lines = 'node-forge 1.4.1 ok\nfollow-redirects 1.16.2 failed\nnode:26-alpine sha256:abc ok\n';
  assert.deepEqual(splitExclusions(lines), ['follow-redirects@1.16.2']);
  assert.deepEqual(splitExclusions(''), []);
});

test('prFixMarkers: pkg@versione dai marker del body PR (bug reale: prendeva "autofix-fix")', () => {
  const body = 'tabella\n\n<!-- autofix-fix follow-redirects@1.16.2 -->\n<!-- autofix-fix @scope/x@1.0.0 -->\n<!-- autofix-fix node:26-alpine@sha256:c6ad -->';
  assert.deepEqual(prFixMarkers(body), ['follow-redirects@1.16.2', '@scope/x@1.0.0', 'node:26-alpine@sha256:c6ad']);
  assert.deepEqual(prFixMarkers(''), []);
  assert.deepEqual(prFixMarkers(null), []);
});
