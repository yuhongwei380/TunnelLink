import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTempDirectory, projectRoot } from '../lib/paths.mjs';
import { selectAgreement } from '../../ui/src/agreement.mjs';

test('branding selects a single installer language and agreement independently of the OS', async (t) => {
  const root = await createTempDirectory('openvpn-branding-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of [
    'package.json',
    'package-lock.json',
    'make/sync-branding.mjs',
    'make/prepare-agreement.mjs',
    'make/openvpn3-release.mjs',
    'resources/settings/openvpn3-release.json',
    'resources/legal/USER-AGREEMENT.txt',
    'ui/src/agreement.mjs',
    'ui/src-tauri/Cargo.toml',
    'ui/src-tauri/tauri.conf.json',
    'ui/src-tauri/tauri.windows.conf.json',
  ]) {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(projectRoot, file), destination);
  }
  const brandingFile = path.join(root, 'resources/settings/app-branding.json');
  const windowsFile = path.join(root, 'ui/src-tauri/tauri.windows.conf.json');
  const originalWindows = JSON.parse(await fs.readFile(windowsFile, 'utf8'));
  originalWindows.bundle.windows.nsis.languages = ['SimpChinese', 'English'];
  originalWindows.bundle.windows.nsis.displayLanguageSelector = true;
  await fs.writeFile(windowsFile, JSON.stringify(originalWindows));

  // Also switch back in the same source tree: cached generated files must update.
  for (const [defaultLocale, language] of [
    [' en ', 'English'],
    ['CN', 'SimpChinese'],
  ]) {
    await fs.writeFile(
      brandingFile,
      JSON.stringify({
        appId: 'com.example.branding-test',
        productName: 'Branding Test',
        defaultLocale,
      }),
    );
    execFileSync(process.execPath, [path.join(root, 'make/sync-branding.mjs')], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
    });
    const windows = JSON.parse(await fs.readFile(windowsFile, 'utf8'));
    assert.deepEqual(windows.bundle.windows.nsis, {
      ...originalWindows.bundle.windows.nsis,
      languages: [language],
      displayLanguageSelector: false,
    });
    const tauri = JSON.parse(
      await fs.readFile(path.join(root, 'ui/src-tauri/tauri.conf.json'), 'utf8'),
    );
    assert.equal(tauri.productName, 'Branding Test');
    const rtf = await fs.readFile(path.join(root, '.cache/legal/USER-AGREEMENT.rtf'), 'ascii');
    assert.match(rtf, /Agreement revision: 2026-10-25/);
    assert.match(rtf, /1\. Project identity/);
    if (language === 'English') {
      assert.doesNotMatch(rtf, /\\u-?\d+\?/);
      assert.match(rtf, /User Agreement and Project Notice\\par/);
    } else {
      assert.match(rtf, /\\u29992\?/); // 用
    }
  }
});

test('the English agreement uses the complete published translation and revision', async () => {
  const text = await fs.readFile(
    path.join(projectRoot, 'resources/legal/USER-AGREEMENT.txt'),
    'utf8',
  );
  const english = selectAgreement(text, 'en');
  assert.equal(
    english.split('\n\n').slice(1).join('\n\n').trim(),
    text.split(/\r?\nEnglish\r?\n\r?\n/)[1].trim(),
  );
  assert.match(english, /^User Agreement and Project Notice\nAgreement revision: 2026-10-25\n/);
  assert.doesNotMatch(english, /\p{Script=Han}/u);
  assert.equal(selectAgreement(text, 'zh'), text);
  assert.throws(
    () => selectAgreement('Incomplete agreement', 'EN'),
    /missing its English text or revision/,
  );
});
