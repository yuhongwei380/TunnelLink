import test from 'node:test';
import assert from 'node:assert/strict';
import defaultUiCopy from '../../../config/ui-copy.json';
import { getMessages, MESSAGES } from '../../../ui/src/messages.ts';
import { mergeUiCopy } from '../../../ui/src/ui-copy.ts';

test('both locales provide the same application messages', () => {
  assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort());
});

test('custom connection copy is applied without replacing application messages', () => {
  const copy = mergeUiCopy(defaultUiCopy, {
    en: { overview: { title: 'Team network' }, connection: { connectedTitle: 'Ready for work' } },
  });
  const messages = getMessages('en', copy);

  assert.equal(messages.overview, 'Team network');
  assert.equal(messages.protectedTitle, 'Ready for work');
  assert.equal(messages.connect, MESSAGES.en.connect);
  assert.equal(messages.appTitle, defaultUiCopy.en.appTitle);
  assert.equal(messages.copyright, defaultUiCopy.en.copyright);
  assert.equal(getMessages('zh', copy).overview, defaultUiCopy.zh.overview.title);
});
