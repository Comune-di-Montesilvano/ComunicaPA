import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIssue, parseIssueState, ISSUE_TITLES } from '../issues.mjs';

test('titoli fissi', () => {
  assert.deepEqual(ISSUE_TITLES, {
    pending: 'Autofix sicurezza: correzioni in attesa',
    unfixable: 'Autofix sicurezza: vulnerabilità non correggibili',
    failed: 'Autofix sicurezza: correzione fallita',
  });
});

test('pending: pacchetto, versione, data prevista e istruzione force', () => {
  const { title, body } = renderIssue('pending', [{ ecosystem: 'npm', pkg: 'node-forge', from: '1.4.0', version: '1.4.1',
    eta: '2026-10-29T04:44:07.718Z', ghsa: ['GHSA-7wch-p9px-956x'] }]);
  assert.equal(title, ISSUE_TITLES.pending);
  assert.match(body, /node-forge/);
  assert.match(body, /1\.4\.0 → 1\.4\.1/);
  assert.match(body, /2026-10-29/);
  assert.match(body, /gh workflow run security-autofix\.yml -f force=node-forge@1\.4\.1/);
});

test('unfixable: motivo e GHSA', () => {
  const { body } = renderIssue('unfixable', [{ ecosystem: 'pip', pkg: 'x', from: '1.0', reason: 'nessuna versione corretta', ghsa: ['GHSA-a'] }]);
  assert.match(body, /nessuna versione corretta/);
  assert.match(body, /GHSA-a/);
});

test('failed: round-trip dello stato esclusioni', () => {
  const state = { excluded: ['node-forge@1.4.1', 'follow-redirects@1.16.2'] };
  const { body } = renderIssue('failed', [{ pkg: 'node-forge', version: '1.4.1', pr: 'https://github.com/o/r/pull/9' }], state);
  assert.match(body, /pull\/9/);
  assert.deepEqual(parseIssueState(body), { ...state, failed: [{ pkg: 'node-forge', version: '1.4.1', pr: 'https://github.com/o/r/pull/9' }] });
});

test('parseIssueState: body senza stato o malformato → excluded []', () => {
  assert.deepEqual(parseIssueState(''), { excluded: [], failed: [] });
  assert.deepEqual(parseIssueState(null), { excluded: [], failed: [] });
  assert.deepEqual(parseIssueState('<!-- autofix-state {rotto -->'), { excluded: [], failed: [] });
});

test('minor: force per immagini usa image:tag (senza digest)', () => {
  const { body } = renderIssue('pending', [{ ecosystem: 'image', pkg: 'node:26-alpine', from: 'sha256:a', version: 'sha256:b', eta: '2026-11-03T00:00:00Z', ghsa: [] }]);
  assert.ok(body.includes('`gh workflow run security-autofix.yml -f force=node:26-alpine`'));
  assert.ok(!body.includes('force=node:26-alpine@'));
});

test('minor: issue fallita mostra lo storico dallo stato, non solo il giro corrente', () => {
  const prev = renderIssue('failed', [{ pkg: 'a', version: '1.0.1', pr: '#10' }], { excluded: ['a@1.0.1'] });
  const state = parseIssueState(prev.body);
  assert.deepEqual(state.failed, [{ pkg: 'a', version: '1.0.1', pr: '#10' }]);
  state.excluded.push('b@2.0.1');
  const next = renderIssue('failed', [{ pkg: 'b', version: '2.0.1', pr: '#11' }], state);
  assert.match(next.body, /\| a \| 1\.0\.1 \| #10 \|/);
  assert.match(next.body, /\| b \| 2\.0\.1 \| #11 \|/);
});

test('minor: righe dello storico tolte dallo stato escluso spariscono dalla tabella', () => {
  const next = renderIssue('failed', [], { excluded: ['b@2'], failed: [{ pkg: 'a', version: '1', pr: '#1' }, { pkg: 'b', version: '2', pr: '#2' }] });
  assert.doesNotMatch(next.body, /\| a \| 1 \|/);
  assert.match(next.body, /\| b \| 2 \| #2 \|/);
});
