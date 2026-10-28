export type LogEntry = { ts: string; source: string; line: string };

export type LogFilter = 'all' | 'errors';

// OpenVPN event names include underscores (AUTH_FAILED), so word boundaries
// alone miss authentication failures. Keep normal startup/status lines neutral.
export function isErrorLog(entry: LogEntry): boolean {
  return (
    entry.source === 'status' ||
    /(?:^|[^a-z])(?:error|fatal|fail(?:ed|ure)?)(?:[^a-z]|$)/i.test(entry.line)
  );
}

export function filterLogs(entries: LogEntry[], query: string, filter: LogFilter): LogEntry[] {
  const search = query.toLowerCase();
  return entries.filter(
    (entry) =>
      (filter === 'all' || isErrorLog(entry)) &&
      `${entry.ts} ${entry.source} ${entry.line}`.toLowerCase().includes(search),
  );
}

export function formatLogs(entries: LogEntry[]): string {
  return entries
    .map((entry) => `${entry.ts ? `[${entry.ts}] ` : ''}[${entry.source}] ${entry.line}`)
    .join('\n');
}
