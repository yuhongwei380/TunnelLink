import type { Locale } from './ui-copy';

const localeKey = 'vpn-ui-locale';

export function getInitialLocale(
  defaultLocale: unknown,
  storage: Pick<Storage, 'getItem'>,
): Locale {
  const fallback =
    String(defaultLocale ?? 'CN')
      .trim()
      .toUpperCase() === 'EN'
      ? 'en'
      : 'zh';
  try {
    const preference: unknown = JSON.parse(storage.getItem(localeKey) ?? 'null');
    if (
      preference &&
      typeof preference === 'object' &&
      'source' in preference &&
      preference.source === 'user' &&
      'locale' in preference &&
      (preference.locale === 'zh' || preference.locale === 'en')
    )
      return preference.locale;
  } catch {
    // Unavailable storage or malformed data must not override the build default.
  }
  // Older versions saved even automatic defaults as plain strings. They cannot
  // identify a deliberate choice, so apply the configured language on migration.
  return fallback;
}

export function saveLocalePreference(locale: Locale, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(localeKey, JSON.stringify({ locale, source: 'user' }));
  } catch {
    // Language switching still works when persistent storage is unavailable.
  }
}
