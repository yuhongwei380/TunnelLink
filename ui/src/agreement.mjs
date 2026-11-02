// The installer and first-run dialog share the published agreement translation.
export function selectAgreement(text, locale) {
  if (String(locale).trim().toUpperCase() !== 'EN') return text;

  const english = text.split(/\r?\nEnglish\r?\n\r?\n/)[1];
  const revision = text.match(/^协议版本 \/ Agreement revision: (.+)$/m)?.[1].trim();
  if (!english || !revision)
    throw new Error('The user agreement is missing its English text or revision.');

  return `User Agreement and Project Notice\nAgreement revision: ${revision}\n\n${english.trim()}\n`;
}
