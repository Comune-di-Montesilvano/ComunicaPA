import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRegistrySignature, registryPath } from '../npm-registry.mjs';

// Dati pubblici del registry npm (node-forge 1.4.2, chiave registry attuale).
const KEYS = [{ expires: null, keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
  key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==' }];
const DIST = {
  integrity: 'sha512-rRtAR5XLJ8gCKd9du4qrKAsgCG1ObGP4gLeNJMa4vYSeq4bmBMOJk5IHkrviBV0q7uoAJlVd8HEQYQSVUb4FGQ==',
  signatures: [{ keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    sig: 'MEQCIGShOwl1C3wRTsqyeqx0+ZlIZbN6Z3AhFcRCkaZd8gSDAiBokop6GL2GYbTIWJk1AJg24KryyQIi6saFakuYWklNYA==' }],
};
const pub = new Date('2026-10-27T14:09:15Z');

test('firma registry valida', () => assert.ok(verifyRegistrySignature('node-forge', '1.4.2', DIST, KEYS, pub)));
test('integrity manomessa → firma non valida', () => {
  assert.ok(!verifyRegistrySignature('node-forge', '1.4.2', { ...DIST, integrity: DIST.integrity.replace('rRt', 'rRu') }, KEYS, pub));
});
test('versione diversa → firma non valida', () => assert.ok(!verifyRegistrySignature('node-forge', '1.4.1', DIST, KEYS, pub)));
test('chiave sconosciuta o senza firme → false', () => {
  assert.ok(!verifyRegistrySignature('node-forge', '1.4.2', DIST, [], pub));
  assert.ok(!verifyRegistrySignature('node-forge', '1.4.2', { integrity: DIST.integrity }, KEYS, pub));
});
test('chiave scaduta prima della pubblicazione → false', () => {
  assert.ok(!verifyRegistrySignature('node-forge', '1.4.2', DIST, [{ ...KEYS[0], expires: '2025-01-29T00:00:00.000Z' }], pub));
});

test('registryPath: scope codificato, nomi non validi rifiutati (niente path traversal)', () => {
  assert.equal(registryPath('node-forge'), 'node-forge');
  assert.equal(registryPath('@scope/pkg'), '@scope%2fpkg');
  for (const bad of ['a/b/c', '../x', '@scope/../../x', 'a?b', '', '@scope/']) {
    assert.throws(() => registryPath(bad), /nome pacchetto npm non valido/, bad);
  }
});
