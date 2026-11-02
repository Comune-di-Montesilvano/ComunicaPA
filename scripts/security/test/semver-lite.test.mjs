import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, satisfies, isPrerelease, major } from '../semver-lite.mjs';

test('compare numerico, non lessicografico', () => {
  assert.equal(compare('1.10.0', '1.9.9'), 1);
  assert.equal(compare('1.4.0', '1.4.0'), 0);
  assert.equal(compare('1.4.0', '1.4.1'), -1);
});

test('satisfies: comparatori singoli', () => {
  assert.ok(satisfies('1.4.0', '<=1.4.0'));
  assert.ok(!satisfies('1.4.1', '<=1.4.0'));
  assert.ok(satisfies('1.16.2', '>=1.16.2'));
});

test('satisfies: AND con spazio', () => {
  assert.ok(satisfies('1.16.1', '>=1.16.0 <=1.16.1'));
  assert.ok(!satisfies('1.15.9', '>=1.16.0 <=1.16.1'));
});

test('satisfies: "1.5.0" in "<1.2.3 || >=1.5.0 <1.5.4"', () => {
  assert.ok(satisfies('1.5.0', '<1.2.3 || >=1.5.0 <1.5.4'));
  assert.ok(!satisfies('1.4.0', '<1.2.3 || >=1.5.0 <1.5.4'));
  assert.ok(satisfies('1.0.0', '<1.2.3 || >=1.5.0 <1.5.4'));
});

test('satisfies: comparatore con spazio dopo operatore e "= x"', () => {
  assert.ok(satisfies('2.0.0', '>= 2.0.0'));
  assert.ok(satisfies('2.0.0', '=2.0.0'));
  assert.ok(satisfies('2.0.0', '2.0.0'));
});

test('prerelease riconosciute', () => {
  assert.ok(isPrerelease('1.4.1-rc.1'));
  assert.ok(!isPrerelease('1.4.1'));
});

test('major', () => assert.equal(major('12.3.4'), 12));
