import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFromLines, replaceDigest, decideDigest, sourceRepo, runtimeImage, provenanceOf, publishedAt } from '../base-image.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'); // copie fisse: l'autofix modifica i file reali
const backend = readFileSync(join(fixtures, 'Dockerfile.backend'), 'utf8');
const pdf = readFileSync(join(fixtures, 'Dockerfile.pdf-extractor'), 'utf8');
const OLD = 'sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797';
const NEW = `sha256:${'a'.repeat(64)}`;

test('parseFromLines: due FROM node:26-alpine nel backend (multi-stage)', () => {
  const f = parseFromLines(backend);
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.image === 'node' && x.tag === '26-alpine' && x.digest === OLD));
});

test('parseFromLines: python:3.14-slim nel pdf-extractor', () => {
  const [f] = parseFromLines(pdf);
  assert.equal(f.image, 'python');
  assert.equal(f.tag, '3.14-slim');
});

test('parseFromLines: FROM senza digest ignorata, registry con porta ok', () => {
  const f = parseFromLines('FROM alpine:3\nFROM reg.example:5000/ns/img:1.0@sha256:' + 'b'.repeat(64) + ' AS x\n');
  assert.deepEqual(f.map((x) => `${x.image}:${x.tag}`), ['reg.example:5000/ns/img:1.0']);
});

test('replaceDigest sostituisce tutti i FROM dello stesso image:tag e nient altro', () => {
  const out = replaceDigest(backend, 'node', '26-alpine', NEW);
  assert.equal(out.split(NEW).length - 1, 2);
  assert.ok(!out.includes(OLD));
  assert.equal(out.replaceAll(NEW, OLD), backend);
  assert.equal(replaceDigest(backend, 'python', '3.14-slim', NEW), backend);
});

test('runtimeImage: ultimo stage (node nel backend, nginx nei frontend)', () => {
  assert.equal(runtimeImage(backend), 'node:26-alpine');
  assert.equal(runtimeImage(readFileSync(join(fixtures, 'Dockerfile.frontend-admin'), 'utf8')), 'nginxinc/nginx-unprivileged:1.31-alpine');
  assert.equal(runtimeImage('FROM scratch\n'), null);
});

test('sourceRepo: uri git con commit e path → repository', () => {
  assert.equal(sourceRepo('https://github.com/nodejs/docker-node.git#34e1b00:26/alpine3.24'), 'https://github.com/nodejs/docker-node');
  assert.equal(sourceRepo(null), null);
});

const now = new Date('2026-11-02T04:00:00Z');
const cur = { digest: OLD, created: new Date('2026-10-01T00:00:00Z'), repo: 'https://github.com/nodejs/docker-node' };

test('decideDigest: digest uguale → unfixable "nessun digest più recente"', () => {
  assert.deepEqual(decideDigest({ current: cur, latest: cur, now }), { action: 'unfixable', reason: 'nessun digest più recente' });
});

test('decideDigest: nuovo, vecchio abbastanza, stessa sorgente → fix', () => {
  const latest = { digest: NEW, created: new Date('2026-10-28T20:55:24Z'), repo: cur.repo };
  assert.deepEqual(decideDigest({ current: cur, latest, now }), { action: 'fix', digest: NEW });
});

test('decideDigest: < 48h → pending con eta', () => {
  const created = new Date(now - 5 * 3600e3);
  const r = decideDigest({ current: cur, latest: { digest: NEW, created, repo: cur.repo }, now });
  assert.equal(r.action, 'pending');
  assert.equal(r.eta.getTime(), created.getTime() + 48 * 3600e3);
});

test('decideDigest: force salta età, non provenienza', () => {
  const created = new Date(now - 5 * 3600e3);
  assert.equal(decideDigest({ current: cur, latest: { digest: NEW, created, repo: cur.repo }, now, force: true }).action, 'fix');
  assert.deepEqual(decideDigest({ current: cur, latest: { digest: NEW, created, repo: null }, now, force: true }),
    { action: 'unfixable', reason: 'provenienza assente o diversa' });
});

test('decideDigest: sorgente diversa → unfixable', () => {
  const latest = { digest: NEW, created: new Date('2026-10-20T00:00:00Z'), repo: 'https://github.com/evil/docker-node' };
  assert.equal(decideDigest({ current: cur, latest, now }).reason, 'provenienza assente o diversa');
});

test('decideDigest: corrente senza provenance → basta il digest nuovo', () => {
  const latest = { digest: NEW, created: new Date('2026-10-20T00:00:00Z'), repo: null };
  assert.equal(decideDigest({ current: { ...cur, repo: null }, latest, now }).action, 'fix');
});

test('decideDigest: data sconosciuta → unfixable', () => {
  const latest = { digest: NEW, created: null, repo: cur.repo };
  assert.equal(decideDigest({ current: cur, latest, now }).reason, 'data di pubblicazione sconosciuta');
});

test('review: digest escluso (fallito prima) → unfixable', () => {
  const latest = { digest: NEW, created: new Date('2026-10-20T00:00:00Z'), repo: cur.repo };
  assert.deepEqual(decideDigest({ current: cur, latest, now, skipDigests: [NEW] }),
    { action: 'unfixable', reason: `digest ${NEW} escluso: fallito in un giro precedente` });
});

test('review: provenienza del digest in uso illeggibile → unfixable, mai controllo saltato', () => {
  const latest = { digest: NEW, created: new Date('2026-10-20T00:00:00Z'), repo: null };
  assert.equal(decideDigest({ current: { ...cur, repo: provenanceOf(() => { throw new Error('429'); }, 'node:26-alpine@x') }, latest, now }).reason,
    'provenienza assente o diversa');
});

test('review: provenanceOf: output null (immagine senza attestazioni) → null; errore → unverifiable', () => {
  assert.equal(provenanceOf(() => null, 'r'), null);
  assert.equal(provenanceOf(() => ({ 'linux/amd64': { SLSA: { invocation: { configSource: { uri: 'https://github.com/a/b.git#x' } } } } }), 'r'), 'https://github.com/a/b');
  assert.equal(provenanceOf(() => { throw new Error('boom'); }, 'r'), 'unverifiable:r');
});

test('review: età = max(created, push Docker Hub) se il digest del tag coincide', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  const hub = { digest: NEW, tag_last_pushed: '2026-11-01T23:40:36Z' };
  assert.deepEqual(publishedAt(created, hub, NEW), new Date('2026-11-01T23:40:36Z'));
  assert.deepEqual(publishedAt(created, { ...hub, digest: 'sha256:altro' }, NEW), created);
  assert.deepEqual(publishedAt(created, null, NEW), created);
  assert.deepEqual(publishedAt(null, hub, NEW), new Date('2026-11-01T23:40:36Z'));
});
