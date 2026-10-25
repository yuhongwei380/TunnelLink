import test from 'node:test';
import assert from 'node:assert/strict';
import defaultUiCopy from '../../../config/ui-copy.json';
import { mergeUiCopy } from '../../../src/ui-copy.ts';

test('partial custom copy falls back by field and preserves the other locale', () => {
  const original = structuredClone(defaultUiCopy);
  const copy = mergeUiCopy(defaultUiCopy, {
    zh: { overview: { title: '公司网络' }, connection: { connectedTitle: '连接成功' } },
  });

  assert.equal(copy.zh.overview.title, '公司网络');
  assert.equal(copy.zh.overview.description, defaultUiCopy.zh.overview.description);
  assert.equal(copy.zh.connection.connectedTitle, '连接成功');
  assert.deepEqual(copy.en, defaultUiCopy.en);
  assert.deepEqual(defaultUiCopy, original);
});

test('invalid copy shapes and non-string overrides retain defaults', () => {
  for (const value of [undefined, null, false, 42, 'text', [], { zh: [] }]) {
    assert.deepEqual(mergeUiCopy(defaultUiCopy, value), defaultUiCopy);
  }

  const copy = mergeUiCopy(defaultUiCopy, {
    zh: { overview: { title: null, description: 123, extra: 'ignored' } },
    en: { connection: false },
  });
  assert.deepEqual(copy, defaultUiCopy);
});

test('an empty string is an intentional copy override', () => {
  const copy = mergeUiCopy(defaultUiCopy, { en: { overview: { description: '' } } });
  assert.equal(copy.en.overview.description, '');
});
