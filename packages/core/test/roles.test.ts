import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActive, isRetracted, roleOf } from '../src/roles.ts';
import type { FactStatus } from '../src/config/status.ts';

// Old spellings are passed on purpose: the decoder must not treat them as live any more, and
// TypeScript should not accept them as a current FactStatus without this cast.
const row = (status: string) => ({ status: status as FactStatus });

test('roles: a fact without a role is an observation', () => {
  assert.equal(roleOf({}), 'observation');
  assert.equal(roleOf({ role: 'rule' }), 'rule');
  assert.equal(roleOf({ role: 'profile' }), 'profile');
});

test('roles: only the four-state vocabulary is recognised', () => {
  assert.equal(isActive({ status: 'active' }), true);
  assert.equal(isRetracted({ status: 'retracted' }), true);
  for (const status of ['none', 'open', 'kept', 'broken', 'superseded']) {
    assert.equal(isActive(row(status)), false, `${status} is not a live state any more`);
    assert.equal(isRetracted(row(status)), false, `${status} is not a retired state any more`);
  }
});
