import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './openvpn3-release.mjs';

// NSIS RichEdit reliably displays Chinese through RTF Unicode escapes,
// independent of the installing user's Windows ANSI code page.
const text = await fs.readFile(
  path.join(projectRoot, 'resources/legal/USER-AGREEMENT.txt'),
  'utf8',
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
const output = path.join(projectRoot, '.cache/legal/USER-AGREEMENT.rtf');
await fs.mkdir(path.dirname(output), { recursive: true });
const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\uc1\\f0\\fs20\n' + body + '\n}\n';
if (
  (await fs.readFile(output, 'ascii').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })) !== rtf
)
  await fs.writeFile(output, rtf, 'ascii');
