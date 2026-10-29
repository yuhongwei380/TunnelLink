import test from 'node:test';
import assert from 'node:assert/strict';
import defaultUiCopy from '../../../resources/settings/ui-copy.json';
import { mergeUiCopy } from '../../../ui/src/ui-copy.ts';

test('partial custom copy falls back by field and preserves the other locale', () => {
  const original = structuredClone(defaultUiCopy);
  const copy = mergeUiCopy(defaultUiCopy, {
    zh: { overview: { title: '公司网络' }, connection: { connectedTitle: '连接成功' } },
  });

  assert.equal(copy.zh.overview.title, '公司网络');
  assert.equal(copy.zh.appTitle, defaultUiCopy.zh.appTitle);
  assert.equal(copy.zh.copyright, defaultUiCopy.zh.copyright);
  assert.equal(copy.zh.overview.description, defaultUiCopy.zh.overview.description);
  assert.equal(copy.zh.connection.connectedTitle, '连接成功');
  assert.deepEqual(copy.en, defaultUiCopy.en);
  assert.deepEqual(defaultUiCopy, original);
});

test('invalid copy shapes and non-string overrides retain defaults', () => {
  // The file carries a "_comment" documentation key; mergeUiCopy keeps only
  // whitelisted fields, so compare against the whitelisted baseline.
  const baseline = mergeUiCopy(defaultUiCopy, {});
  for (const value of [undefined, null, false, 42, 'text', [], { zh: [] }]) {
    assert.deepEqual(mergeUiCopy(defaultUiCopy, value), baseline);
  }

  const copy = mergeUiCopy(defaultUiCopy, {
    zh: { overview: { title: null, description: 123, extra: 'ignored' } },
    en: { connection: false },
  });
  assert.deepEqual(copy, baseline);
});

test('an empty string is an intentional copy override', () => {
  const copy = mergeUiCopy(defaultUiCopy, { en: { overview: { description: '' } } });
  assert.equal(copy.en.overview.description, '');
});

test('branding and primary action labels are configurable', () => {
  const copy = mergeUiCopy(defaultUiCopy, {
    zh: {
      appTitle: '内部 VPN',
      copyright: '© 2026 内部网络团队',
      connection: { connectButton: '开始连接' },
    },
  });

  assert.equal(copy.zh.appTitle, '内部 VPN');
  assert.equal(copy.zh.copyright, '© 2026 内部网络团队');
  assert.equal(copy.zh.connection.connectButton, '开始连接');
  assert.equal(copy.zh.connection.disconnectButton, defaultUiCopy.zh.connection.disconnectButton);
});

test('former default branding follows the new defaults on existing installs', () => {
  const copy = mergeUiCopy(defaultUiCopy, {
    zh: { appTitle: 'OpenVPN 企业客户端', copyright: '© 2026 OpenVPN 企业客户端' },
    en: { appTitle: 'OpenVPN Client', copyright: '© 2026 OpenVPN Client' },
  });
  for (const locale of ['zh', 'en'] as const) {
    assert.equal(copy[locale].appTitle, 'Tunnel Link');
    assert.equal(copy[locale].copyright, defaultUiCopy[locale].copyright);
  }
  assert.equal(
    mergeUiCopy(defaultUiCopy, { zh: { appTitle: 'TunnelLink' } }).zh.appTitle,
    'Tunnel Link',
  );
});
