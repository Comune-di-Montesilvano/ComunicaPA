import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseVersion } from '../choose-version.mjs';

const REPO = 'https://github.com/example/pkg';
const c = (version, publishedAt, { provenanceRepo = null, registrySigned = true } = {}) =>
  ({ version, publishedAt: publishedAt ? new Date(publishedAt) : null, provenanceRepo, registrySigned });
const now = new Date('2026-10-31T02:30:00Z');

test('node-forge: sceglie 1.4.1, non 1.4.2', () => {
  assert.deepEqual(chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'],
    candidates: [c('1.4.2', '2026-10-27T14:09:15Z'), c('1.4.1', '2026-10-27T04:44:07Z')],
    previous: [c('1.4.0', '2026-03-24T21:44:34Z')], now }), { action: 'fix', version: '1.4.1' });
});

test('versioni ancora vulnerabili o <= current escluse', () => {
  const r = chooseVersion({ current: '1.16.1', vulnerableRanges: ['>=1.16.0 <=1.16.1', '<1.16.2'],
    candidates: [c('1.16.0', '2026-04-13T00:00:00Z'), c('1.16.2', '2026-10-25T21:32:25Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '1.16.2' });
});

test('< 48h → pending con eta = publishedAt + 48h', () => {
  const pub = new Date(now.getTime() - 10 * 3600e3);
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', pub)], previous: [], now });
  assert.equal(r.action, 'pending');
  assert.equal(r.version, '1.0.1');
  assert.equal(r.eta.toISOString(), new Date(pub.getTime() + 48 * 3600e3).toISOString());
});

test('minima giovane ma successiva vecchia abbastanza → sceglie la successiva', () => {
  // ordine reale non monotono: una backport 1.0.2 pubblicata dopo 1.0.3
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'],
    candidates: [c('1.0.1', new Date(now - 5 * 3600e3)), c('1.0.3', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '1.0.3' });
});

test('forceVersion salta età, non provenienza', () => {
  const young = new Date(now - 3600e3);
  assert.deepEqual(chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', young)],
    previous: [], now, forceVersion: '1.0.1' }), { action: 'fix', version: '1.0.1' });
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', young)],
    previous: [c('1.0.0', '2026-01-01T00:00:00Z', { provenanceRepo: REPO })], now, forceVersion: '1.0.1' });
  assert.deepEqual(r, { action: 'unfixable', reason: 'provenienza assente o diversa' });
});

test('forceVersion non correttiva → unfixable', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.0', '2026-01-01T00:00:00Z')],
    previous: [], now, forceVersion: '1.0.0' });
  assert.equal(r.action, 'unfixable');
});

test('precedente con provenance, candidata senza → unfixable "provenienza assente o diversa"', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', '2026-10-01T00:00:00Z')],
    previous: [c('0.9.0', '2026-01-01T00:00:00Z', { provenanceRepo: REPO })], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'provenienza assente o diversa' });
});

test('provenance repo diverso → unfixable', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'],
    candidates: [c('1.0.1', '2026-10-01T00:00:00Z', { provenanceRepo: 'https://github.com/attacker/pkg' })],
    previous: [c('1.0.0', '2026-01-01T00:00:00Z', { provenanceRepo: REPO })], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'provenienza assente o diversa' });
});

test('provenance repo uguale a meno di git+/.git/maiuscole → fix', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'],
    candidates: [c('1.0.1', '2026-10-01T00:00:00Z', { provenanceRepo: 'git+https://github.com/Example/pkg.git' })],
    previous: [c('1.0.0', '2026-01-01T00:00:00Z', { provenanceRepo: REPO })], now });
  assert.deepEqual(r, { action: 'fix', version: '1.0.1' });
});

test('mai avuta provenance → basta registrySigned', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', '2026-10-01T00:00:00Z')],
    previous: [c('1.0.0', '2026-01-01T00:00:00Z')], now });
  assert.deepEqual(r, { action: 'fix', version: '1.0.1' });
});

test('registrySigned false → unfixable', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'],
    candidates: [c('1.0.1', '2026-10-01T00:00:00Z', { registrySigned: false })], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'provenienza assente o diversa' });
});

test('preferisce stessa major: 1.9.3 prima di 2.0.0', () => {
  const r = chooseVersion({ current: '1.9.0', vulnerableRanges: ['<1.9.3'],
    candidates: [c('2.0.0', '2026-09-01T00:00:00Z'), c('1.9.3', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '1.9.3' });
});

test('nessuna correzione nella stessa major → major successiva', () => {
  const r = chooseVersion({ current: '1.9.0', vulnerableRanges: ['<2.0.0'],
    candidates: [c('2.0.0', '2026-09-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '2.0.0' });
});

test('publishedAt null → unfixable "data di pubblicazione sconosciuta"', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], candidates: [c('1.0.1', null)], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'data di pubblicazione sconosciuta' });
});

test('nessuna versione corretta → unfixable', () => {
  const r = chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'], candidates: [c('1.3.0', '2026-01-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'nessuna versione corretta' });
});

test('prerelease mai candidata', () => {
  const r = chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'],
    candidates: [c('1.4.1-rc.1', '2026-01-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'nessuna versione corretta' });
});

test('review: advisory "*" → nessuna versione corretta', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['*'], candidates: [c('1.0.1', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'nessuna versione corretta' });
});

test('review: candidata fuori da patched_versions → scartata', () => {
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], fixedRanges: ['<0.0.0'],
    candidates: [c('1.0.1', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'nessuna versione corretta' });
  const ok = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.1'], fixedRanges: ['>=1.0.2'],
    candidates: [c('1.0.1', '2026-10-01T00:00:00Z'), c('1.0.2', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(ok, { action: 'fix', version: '1.0.2' });
});

test('review: versione esclusa (fallita prima) → si passa alla successiva', () => {
  const r = chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'], skipVersions: ['1.4.1'],
    candidates: [c('1.4.1', '2026-10-01T00:00:00Z'), c('1.4.2', '2026-10-02T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '1.4.2' });
  const none = chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'], skipVersions: ['1.4.1'],
    candidates: [c('1.4.1', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(none, { action: 'unfixable', reason: 'nessuna versione corretta (escluse: 1.4.1)' });
});

test('review: force riprova una versione esclusa', () => {
  const r = chooseVersion({ current: '1.4.0', vulnerableRanges: ['<=1.4.0'], skipVersions: ['1.4.1'], forceVersion: '1.4.1',
    candidates: [c('1.4.1', '2026-10-01T00:00:00Z')], previous: [], now });
  assert.deepEqual(r, { action: 'fix', version: '1.4.1' });
});

test('minor: provenance comparsa tra current e la scelta vincola anche le successive', () => {
  // 1.0.1 vulnerabile ma attestata, 1.0.2 corretta senza attestazione → downgrade di fiducia.
  const r = chooseVersion({ current: '1.0.0', vulnerableRanges: ['<1.0.2'],
    candidates: [c('1.0.1', '2026-09-01T00:00:00Z', { provenanceRepo: REPO }), c('1.0.2', '2026-10-01T00:00:00Z')],
    previous: [c('1.0.0', '2026-01-01T00:00:00Z')], now });
  assert.deepEqual(r, { action: 'unfixable', reason: 'provenienza assente o diversa' });
});
