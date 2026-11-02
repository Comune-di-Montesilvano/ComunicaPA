import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileChanges } from '../gh-commit.mjs';

const read = (p) => Buffer.from(`contenuto di ${p}`);

test('modificati e aggiunti → additions base64, cancellati → deletions', () => {
  const status = ' M pnpm-lock.yaml\0 M apps/backend/package.json\0?? services/pdf-extractor/requirements.in\0 D apps/old/package.json\0';
  assert.deepEqual(buildFileChanges(status, read), {
    additions: [
      { path: 'pnpm-lock.yaml', contents: Buffer.from('contenuto di pnpm-lock.yaml').toString('base64') },
      { path: 'apps/backend/package.json', contents: Buffer.from('contenuto di apps/backend/package.json').toString('base64') },
      { path: 'services/pdf-extractor/requirements.in', contents: Buffer.from('contenuto di services/pdf-extractor/requirements.in').toString('base64') },
    ],
    deletions: [{ path: 'apps/old/package.json' }],
  });
});

test('rinomina (porcelain -z: R nuovo\\0vecchio) → addition + deletion', () => {
  const r = buildFileChanges('R  apps/b/Dockerfile\0apps/a/Dockerfile\0', read);
  assert.deepEqual(r.additions.map((x) => x.path), ['apps/b/Dockerfile']);
  assert.deepEqual(r.deletions, [{ path: 'apps/a/Dockerfile' }]);
});

test('file sotto .cache/ ignorati (scan e tool)', () => {
  const r = buildFileChanges('?? .cache/autofix/audit.json\0 M pnpm-lock.yaml\0', read);
  assert.deepEqual(r.additions.map((x) => x.path), ['pnpm-lock.yaml']);
});

test('nessuna modifica → liste vuote', () => assert.deepEqual(buildFileChanges('', read), { additions: [], deletions: [] }));

test('review: file fuori allowlist → errore (mai committati dal bot)', () => {
  assert.throws(() => buildFileChanges(' M scripts/security/diff-gate.mjs\0 M pnpm-lock.yaml\0', read), /fuori allowlist: scripts\/security\/diff-gate\.mjs/);
  assert.throws(() => buildFileChanges(' M .github/workflows/security.yml\0', read), /fuori allowlist/);
  assert.throws(() => buildFileChanges(' D apps/backend/src/main.ts\0', read), /fuori allowlist/);
});

test('review: allowlist copre lockfile, manifest, requirements, Dockerfile', () => {
  const ok = [' M pnpm-lock.yaml', ' M pnpm-workspace.yaml', ' M package.json', ' M apps/backend/package.json',
    ' M packages/shared-types/package.json', ' M services/pdf-extractor/requirements.in', ' M services/pdf-extractor/requirements.txt',
    ' M services/pdf-extractor/requirements-dev.txt', ' M apps/frontend-admin/Dockerfile', ' M services/pdf-extractor/Dockerfile.dev'];
  assert.equal(buildFileChanges(ok.join('\0') + '\0', read).additions.length, ok.length);
});
