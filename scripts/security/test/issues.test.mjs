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
  assert.deepEqual(parseIssueState(body), state);
});

test('parseIssueState: body senza stato o malformato → excluded []', () => {
  assert.deepEqual(parseIssueState(''), { excluded: [] });
  assert.deepEqual(parseIssueState(null), { excluded: [] });
  assert.deepEqual(parseIssueState('<!-- autofix-state {rotto -->'), { excluded: [] });
});
