import test from 'node:test';
import assert from 'node:assert/strict';
import { getInitialLocale, saveLocalePreference } from '../../../ui/src/locale.ts';

function memoryStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set('vpn-ui-locale', initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('first launch follows the packaged language without saving an automatic preference', () => {
  const storage = memoryStorage();
  assert.equal(getInitialLocale('EN', storage), 'en');
  assert.equal(getInitialLocale('CN', storage), 'zh');
  assert.equal(getInitialLocale(' en ', storage), 'en');
  assert.equal(storage.values.size, 0);
});

test('legacy automatically saved Chinese cannot override an English package', () => {
  for (const legacy of ['zh', 'en']) {
    const storage = memoryStorage(legacy);
    assert.equal(getInitialLocale('EN', storage), 'en');
    assert.equal(getInitialLocale('CN', storage), 'zh');
    assert.equal(storage.getItem('vpn-ui-locale'), legacy);
  }
});

test('only an explicit user choice overrides branding and survives subsequent launches', () => {
  const storage = memoryStorage('zh');
  assert.equal(getInitialLocale('EN', storage), 'en');
  saveLocalePreference('zh', storage);
  const saved = storage.getItem('vpn-ui-locale');
  assert.deepEqual(JSON.parse(saved!), { locale: 'zh', source: 'user' });
  assert.equal(getInitialLocale('EN', storage), 'zh');
  assert.equal(getInitialLocale('EN', storage), 'zh');
  assert.equal(storage.getItem('vpn-ui-locale'), saved);
  saveLocalePreference('en', storage);
  assert.equal(getInitialLocale('CN', storage), 'en');
});

test('malformed and automatic preference records fall back to the packaged language', () => {
  for (const saved of [
    '',
    '{',
    'null',
    '[]',
    '42',
    '"zh"',
    '{"locale":"zh"}',
    '{"locale":"zh","source":"default"}',
    '{"locale":"CN","source":"user"}',
  ]) {
    assert.equal(getInitialLocale('EN', memoryStorage(saved)), 'en', saved);
    assert.equal(getInitialLocale('CN', memoryStorage(saved)), 'zh', saved);
  }
});

test('unavailable browser storage does not prevent startup or language switching', () => {
  const storage = {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
  };
  assert.equal(getInitialLocale('EN', storage), 'en');
  assert.doesNotThrow(() => saveLocalePreference('zh', storage));
});
