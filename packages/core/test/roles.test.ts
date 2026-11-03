import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActive, isRetracted, roleOf } from '../src/roles.ts';
import type { Fact } from '../src/types.ts';

test('roles: a row without a role falls back to its old type name', () => {
  assert.equal(roleOf({ typeName: '规则' }), 'rule');
  assert.equal(roleOf({ typeName: '画像' }), 'profile');
  assert.equal(roleOf({ typeName: '结论' }), 'judgment');
  assert.equal(roleOf({ typeName: '承诺' }), 'promise');
  assert.equal(roleOf({ typeName: '教训' }), 'lesson');
  assert.equal(roleOf({ typeName: '裁员' }), 'observation', '自由描述默认观察');
  assert.equal(roleOf({}), 'observation');
});

test('roles: an explicit role wins over the legacy label', () => {
  assert.equal(roleOf({ role: 'rule', typeName: '画像' }), 'rule');
});

test('roles: old and new status vocabularies both read correctly', () => {
  const row = (status: string) => ({ status: status as Fact['status'] });
  for (const status of ['active', 'none', 'kept', 'open']) {
    assert.equal(isActive(row(status)), true, status);
  }
  for (const status of ['superseded', 'retracted', 'broken']) {
    assert.equal(isActive(row(status)), false, status);
    assert.equal(isRetracted(row(status)), true, status);
  }
});
