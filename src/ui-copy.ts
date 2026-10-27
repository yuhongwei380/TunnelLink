export type LocaleCopy = {
  appTitle: string;
  copyright: string;
  overview: {
    eyebrow: string;
    title: string;
    description: string;
  };
  connection: {
    label: string;
    connectButton: string;
    disconnectButton: string;
    cancelButton: string;
    disconnectedTitle: string;
    disconnectedDescription: string;
    connectingTitle: string;
    connectingDescription: string;
    connectedTitle: string;
    connectedDescription: string;
    authenticationHint: string;
  };
};

export type UiCopy = {
  zh: LocaleCopy;
  en: LocaleCopy;
};

export type Locale = keyof UiCopy;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeStrings<T extends Record<string, string>>(defaults: T, value: unknown): T {
  const input = record(value);
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const replacement = input[String(key)];
    if (typeof replacement === 'string') merged[key] = replacement as T[keyof T];
  }
  return merged;
}

export function mergeUiCopy(defaults: UiCopy, value: unknown): UiCopy {
  const root = record(value);
  const mergeLocale = (locale: keyof UiCopy): LocaleCopy => {
    const input = record(root[locale]);
    const copy = defaults[locale];
    const labels = mergeStrings({ appTitle: copy.appTitle, copyright: copy.copyright }, input);
    return {
      ...labels,
      overview: mergeStrings(copy.overview, input.overview),
      connection: mergeStrings(copy.connection, input.connection),
    };
  };
  return { zh: mergeLocale('zh'), en: mergeLocale('en') };
}
