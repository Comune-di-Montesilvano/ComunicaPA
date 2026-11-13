import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseConfig, allowedMatcher, findingKey } from '../config.mjs';
import { buildFileChanges } from '../gh-commit.mjs';
import { groupFindings, verifyFixed, pnpmInputs } from '../autofix.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Repo con tre progetti pnpm separati e senza pip (forma di UtenzePA).
const multi = parseConfig({
  pnpmDirs: ['backend', 'frontend'],
  dockerfiles: { backend: 'backend/Dockerfile', frontend: 'frontend/Dockerfile' },
  allowedFiles: ['*/package.json', '*/pnpm-lock.yaml', '*/pnpm-workspace.yaml', '*/Dockerfile'],
  pip: null,
});

test('config del repo: valida e con pip', () => {
  const c = loadConfig(join(here, '..', 'autofix.config.json'));
  assert.deepEqual(c.pnpmDirs, ['.']);
  assert.equal(c.pip.dir, 'services/pdf-extractor');
  assert.equal(c.dockerfiles['pdf-extractor'], 'services/pdf-extractor/Dockerfile');
});

test('parseConfig: rifiuta config senza pnpmDirs o con chiavi sconosciute', () => {
  assert.throws(() => parseConfig({ dockerfiles: {}, allowedFiles: [], pip: null }), /pnpmDirs/);
  assert.throws(() => parseConfig({ pnpmDirs: ['.'], dockerfiles: {}, allowedFiles: [], pip: null, extra: 1 }), /extra/);
});

test('allowedMatcher: * = un solo segmento, nient\'altro', () => {
  const ok = allowedMatcher(multi.allowedFiles);
  assert.equal(ok('backend/package.json'), true);
  assert.equal(ok('frontend/pnpm-lock.yaml'), true);
  assert.equal(ok('package.json'), false);
  assert.equal(ok('backend/src/package.json'), false);
  assert.equal(ok('.github/workflows/x.yml'), false);
  assert.equal(ok('backendXpackage.json'), false);
});

test('gh-commit: file fuori allowedFiles della config → rifiutato', () => {
  const read = () => Buffer.from('x');
  const ok = buildFileChanges(' M backend/pnpm-lock.yaml\0', read, multi.allowedFiles);
  assert.equal(ok.additions[0].path, 'backend/pnpm-lock.yaml');
  assert.throws(() => buildFileChanges(' M pnpm-lock.yaml\0 M scripts/security/diff-gate.mjs\0', read, multi.allowedFiles),
    /pnpm-lock\.yaml, scripts\/security\/diff-gate\.mjs/);
});

test('findingKey: directory nel key solo fuori dalla radice', () => {
  assert.equal(findingKey({ ecosystem: 'npm', pkg: 'zod', version: '3.25.76' }), 'npm:zod@3.25.76');
  assert.equal(findingKey({ ecosystem: 'npm', dir: '.', pkg: 'zod', version: '3.25.76' }), 'npm:zod@3.25.76');
  assert.equal(findingKey({ ecosystem: 'npm', dir: 'backend', pkg: 'zod', version: '3.25.76' }), 'npm:backend/zod@3.25.76');
});

const f = (dir, id) => ({ tool: 'pnpm-audit', ecosystem: 'npm', dir, pkg: 'zod', version: '3.25.76', id, aliases: [],
  severity: 'HIGH', vulnerableRange: '<4.6.6', fixedRange: '>=4.6.6', fixedVersions: [], target: `${dir}/pnpm-lock.yaml` });

test('groupFindings: stesso pacchetto in due directory = due gruppi con la loro directory', () => {
  const g = groupFindings([f('backend', 'GHSA-a'), f('frontend', 'GHSA-a')]);
  assert.deepEqual(g.map((x) => [x.key, x.dir]), [['npm:backend/zod@3.25.76', 'backend'], ['npm:frontend/zod@3.25.76', 'frontend']]);
});

test('verifyFixed: corretto in backend non nasconde lo stesso finding rimasto in frontend', () => {
  const before = [f('backend', 'GHSA-a'), f('frontend', 'GHSA-a')];
  const r = verifyFixed({ before, after: [f('frontend', 'GHSA-a')], fixedKeys: ['npm:backend/zod@3.25.76'] });
  assert.equal(r.ok, true);
  const r2 = verifyFixed({ before, after: [f('backend', 'GHSA-a')], fixedKeys: ['npm:backend/zod@3.25.76'] });
  assert.equal(r2.ok, false);
});

test('pnpmInputs: `--pnpm file` = radice, `--pnpm dir=file` = directory; directory non in config → errore', () => {
  assert.deepEqual(pnpmInputs(['a.json'], parseConfig({ pnpmDirs: ['.'], dockerfiles: {}, allowedFiles: [], pip: null })), [['.', 'a.json']]);
  assert.deepEqual(pnpmInputs(['backend=b.json', 'frontend=f.json'], multi), [['backend', 'b.json'], ['frontend', 'f.json']]);
  assert.throws(() => pnpmInputs(['e2e=e.json'], multi), /e2e/);
});
