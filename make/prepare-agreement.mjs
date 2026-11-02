import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './openvpn3-release.mjs';
import { selectAgreement } from '../ui/src/agreement.mjs';

// NSIS RichEdit reliably displays Chinese through RTF Unicode escapes,
// independent of the installing user's Windows ANSI code page.
export async function prepareAgreement(root = projectRoot, locale = 'CN') {
  const text = selectAgreement(
    await fs.readFile(path.join(root, 'resources/legal/USER-AGREEMENT.txt'), 'utf8'),
    locale,
  );
  let body = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const char = text[i];
    if (char === '\r') continue;
    if (char === '\n') body += '\\par\n';
    else if ('\\{}'.includes(char)) body += '\\' + char;
    else if (code > 127) body += `\\u${code > 32767 ? code - 65536 : code}?`;
    else body += char;
  }
  const output = path.join(root, '.cache/legal/USER-AGREEMENT.rtf');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\uc1\\f0\\fs20\n' + body + '\n}\n';
  if (
    (await fs.readFile(output, 'ascii').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })) !== rtf
  )
    await fs.writeFile(output, rtf, 'ascii');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const branding = JSON.parse(
    await fs.readFile(path.join(projectRoot, 'resources/settings/app-branding.json'), 'utf8'),
  );
  await prepareAgreement(projectRoot, branding.defaultLocale || 'CN');
}
