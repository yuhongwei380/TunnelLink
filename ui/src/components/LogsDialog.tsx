import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import { filterLogs, formatLogs, isErrorLog, type LogEntry, type LogFilter } from '../logs';
import type { Messages } from '../messages';

type Props = {
  open: boolean;
  t: Messages;
  onClose: () => void;
  onNotify: (message: string) => void;
};

export function LogsDialog({ open, t, onClose, onNotify }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsError, setLogsError] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [exportRange, setExportRange] = useState<5 | 30 | 60>(5);
  const [exporting, setExporting] = useState(false);
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const logsPending = useRef(false);
  const pausedRef = useRef(false);
  const requestVersion = useRef(0);
  const logsDialogRef = useDialog(open);
  const consoleRef = useRef<HTMLElement>(null);
  const exportControlRef = useRef<HTMLDivElement>(null);
  const rangeButtonRef = useRef<HTMLButtonElement>(null);
  const followLatest = useRef(true);
  const isDesktop = Boolean(window.vpn);
  const errorCount = logs.filter(isErrorLog).length;

  const loadLogs = useCallback(
    async (automatic = false) => {
      if (!window.vpn || logsPending.current || (automatic && pausedRef.current)) return;
      const version = requestVersion.current;
      logsPending.current = true;
      setLogsLoading(true);
      try {
        const result = await window.vpn.getLogs();
        // Pausing also freezes the result of an automatic request already in flight.
        if (version !== requestVersion.current) return;
        if (!result.ok) throw new Error();
        const entries = [...result.logs];
        if (result.lastError) entries.push({ ts: '', source: 'status', line: result.lastError });
        setLogs(entries);
        setLogsError('');
      } catch {
        if (version === requestVersion.current) setLogsError(t.loadLogsFailed);
      } finally {
        setLogsLoading(false);
        logsPending.current = false;
      }
    },
    [t.loadLogsFailed],
  );

  useEffect(() => {
    if (open) followLatest.current = true;
    else {
      requestVersion.current += 1;
      pausedRef.current = false;
      setPaused(false);
      setRangeMenuOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!rangeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!exportControlRef.current?.contains(event.target as Node)) setRangeMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setRangeMenuOpen(false);
      rangeButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [rangeMenuOpen]);

  useEffect(() => {
    if (!open || paused) return;
    void loadLogs(true);
    const timer = window.setInterval(() => void loadLogs(true), 1000);
    return () => window.clearInterval(timer);
  }, [open, paused, loadLogs]);

  const togglePaused = () => {
    pausedRef.current = !pausedRef.current;
    requestVersion.current += 1;
    setPaused(pausedRef.current);
  };

  const clearLogs = async () => {
    if (!window.vpn) return;
    try {
      const result = await window.vpn.clearLogs();
      if (!result.ok) throw new Error();
      await loadLogs();
    } catch {
      onNotify(t.clearFailed);
    }
  };
  const filteredLogs = filterLogs(logs, query, logFilter);
  useLayoutEffect(() => {
    const console = consoleRef.current;
    if (open && console && followLatest.current) console.scrollTop = console.scrollHeight;
  }, [open, logs, query, logFilter]);
  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(formatLogs(filteredLogs));
      onNotify(t.copied);
    } catch {
      onNotify(t.copyFailed);
    }
  };
  const exportLogs = async () => {
    if (!window.vpn || exporting) return;
    setExporting(true);
    try {
      const result = await window.vpn.exportLogs(exportRange);
      onNotify(`${t.exportedLogs} ${result.path}`);
    } catch {
      onNotify(t.exportLogsFailed);
    } finally {
      setExporting(false);
    }
  };
  const exportRanges = [
    { value: 5 as const, label: t.last5Minutes },
    { value: 30 as const, label: t.last30Minutes },
    { value: 60 as const, label: t.last1Hour },
  ];
  const selectedRangeLabel = exportRanges.find(({ value }) => value === exportRange)?.label;

  return (
    <dialog
      ref={logsDialogRef}
      className="logs-dialog"
      aria-labelledby="logs-dialog-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="logs-dialog-heading">
        <div>
          <h2 id="logs-dialog-title">
            {t.logsTitle} <span className="count-badge">{logs.length}</span>
          </h2>
          <p>{t.logsDesc}</p>
        </div>
        <div className="logs-heading-actions">
          <span className={`live-label ${paused ? 'is-paused' : ''}`} role="status">
            {isDesktop ? (
              <>
                <i aria-hidden="true" />
                {paused ? t.refreshPaused : t.live}
              </>
            ) : (
              t.preview
            )}
          </span>
          <button className="dialog-close" onClick={onClose} aria-label={t.close}>
            <X size={20} />
          </button>
        </div>
      </div>
      <section className="logs-panel" aria-label={t.logsTitle}>
        <div className="logs-controls">
          <div className="log-filters" aria-label={t.logStream}>
            <button aria-pressed={logFilter === 'all'} onClick={() => setLogFilter('all')}>
              {t.allEvents}
            </button>
            <button aria-pressed={logFilter === 'errors'} onClick={() => setLogFilter('errors')}>
              <AlertCircle size={14} />
              {t.errorsOnly}
              {errorCount > 0 && <span>{errorCount}</span>}
            </button>
          </div>
          <div className="log-search-field">
            <Search size={17} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.search}
              aria-label={t.search}
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label={t.clearSearch}>
                <X size={15} />
              </button>
            )}
          </div>
          <div className="logs-toolbar">
            <button
              className="logs-pause-button"
              onClick={togglePaused}
              disabled={!isDesktop}
              aria-pressed={paused}
              title={paused ? t.resumeRefresh : t.pauseRefresh}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              <span>{paused ? t.resumeRefresh : t.pauseRefresh}</span>
            </button>
            <div className="logs-export-control" ref={exportControlRef}>
              <button
                ref={rangeButtonRef}
                className="logs-range-button"
                onClick={() => setRangeMenuOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={rangeMenuOpen}
                aria-label={`${t.exportRange}: ${selectedRangeLabel}`}
                title={t.exportRange}
                disabled={!isDesktop || exporting}
              >
                <span>{selectedRangeLabel}</span>
                <ChevronDown size={14} className={rangeMenuOpen ? 'is-open' : ''} />
              </button>
              {rangeMenuOpen && (
                <div className="logs-range-menu" role="menu" aria-label={t.exportRange}>
                  <span className="logs-range-menu-label">{t.exportRange}</span>
                  {exportRanges.map(({ value, label }) => (
                    <button
                      key={value}
                      role="menuitemradio"
                      aria-checked={exportRange === value}
                      onClick={() => {
                        setExportRange(value);
                        setRangeMenuOpen(false);
                        rangeButtonRef.current?.focus();
                      }}
                    >
                      <span>{label}</span>
                      {exportRange === value && <Check size={15} />}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="logs-export-button"
                onClick={() => void exportLogs()}
                disabled={!isDesktop || !logs.length || exporting}
                title={t.exportLogs}
                aria-label={t.exportLogs}
              >
                <Download size={16} className={exporting ? 'export-pulse' : ''} />
                <span>{exporting ? t.exportingLogs : t.exportLogs}</span>
              </button>
            </div>
            <button
              onClick={() => void loadLogs()}
              disabled={!isDesktop || logsLoading}
              title={t.refresh}
              aria-label={t.refresh}
            >
              <RefreshCw size={16} className={logsLoading ? 'spin' : ''} />
            </button>
            <button
              onClick={copyLogs}
              disabled={!filteredLogs.length}
              title={t.copy}
              aria-label={t.copy}
            >
              <Copy size={16} />
            </button>
            <button
              className="clear-button"
              onClick={clearLogs}
              disabled={!isDesktop || !logs.length}
              title={t.clear}
              aria-label={t.clear}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        {logsError && (
          <div className="logs-error" role="alert">
            <AlertCircle size={16} />
            {logsError}
          </div>
        )}
        <div className="log-column-labels" aria-hidden="true">
          <span>{t.timestamp}</span>
          <span>{t.source}</span>
          <span>{t.message}</span>
        </div>
        <section
          ref={consoleRef}
          className="log-console"
          aria-label={t.logStream}
          onScroll={(event) => {
            const target = event.currentTarget;
            followLatest.current =
              target.scrollHeight - target.scrollTop - target.clientHeight < 24;
          }}
        >
          {!filteredLogs.length ? (
            <div className="logs-empty">
              <span className="empty-illustration">
                <Terminal size={30} strokeWidth={1.4} />
              </span>
              <h3>{query ? t.noResults : logFilter === 'errors' ? t.noErrors : t.noLogs}</h3>
              <p>
                {!isDesktop
                  ? t.logsUnavailable
                  : query
                    ? t.noMatchesDesc
                    : logFilter === 'errors'
                      ? t.noErrorsDesc
                      : t.noLogsDesc}
              </p>
              {(query || logFilter !== 'all') && (
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery('');
                    setLogFilter('all');
                  }}
                >
                  {t.resetFilters}
                  <ArrowRight size={14} />
                </button>
              )}
            </div>
          ) : (
            filteredLogs.map((entry, index) => (
              <div
                className={`log-entry ${isErrorLog(entry) ? 'log-error' : ''}`}
                key={`${entry.ts}-${index}`}
              >
                <time dateTime={entry.ts || undefined} title={entry.ts}>
                  {entry.ts ? entry.ts.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '—'}
                </time>
                <span className="log-source">{entry.source}</span>
                <p>
                  {isErrorLog(entry) && <AlertCircle size={13} aria-label={t.errorsOnly} />}
                  {entry.line}
                </p>
              </div>
            ))
          )}
        </section>
        <div className="logs-footnote">
          <span>{`${filteredLogs.length} ${t.events}`}</span>
          <span>
            <LockKeyhole size={12} />
            {t.logPrivacy}
          </span>
        </div>
      </section>
    </dialog>
  );
}
