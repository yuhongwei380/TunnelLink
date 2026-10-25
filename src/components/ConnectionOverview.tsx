import {
  AlertCircle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Clock3,
  FileText,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Power,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { ConnectionVisual } from './ConnectionVisual';
import { formatBytes, formatTime } from '../format';
import type { Messages } from '../messages';
import type { VpnState, VpnStats } from '../types';
import release from '../../config/openvpn3-release.json';

type Props = {
  status: VpnState;
  stats: VpnStats;
  statusError: string;
  busy: boolean;
  clientVersion: string;
  t: Messages;
  onToggle: () => void;
  onOpenLogs: () => void;
};

export function ConnectionOverview({
  status,
  stats,
  statusError,
  busy,
  clientVersion,
  t,
  onToggle,
  onOpenLogs,
}: Props) {
  const connected = status === 'CONNECTED';
  const connecting = status === 'CONNECTING';
  const connectionFailed = Boolean(statusError) && !connected && !connecting;
  const statusLabel = connected
    ? t.connected
    : connecting
      ? t.connecting
      : connectionFailed
        ? t.connectionFailed
        : t.offline;

  return (
    <div
      className={`page-content connection-page ${connectionFailed ? 'has-connection-error' : ''}`}
    >
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t.overviewEyebrow}</span>
          <h2>{t.overview}</h2>
          <p>{t.overviewDesc}</p>
        </div>
        <span className="page-heading-icon" aria-hidden="true">
          <Globe2 size={28} strokeWidth={1.2} />
        </span>
      </div>
      <section
        className={`connection-card ${connected ? 'is-connected' : connecting ? 'is-connecting' : connectionFailed ? 'has-error' : ''}`}
        aria-label={t.status}
      >
        <div className="connection-copy">
          <div className="card-topline">
            <span className="hero-eyebrow">{t.privateNetwork}</span>
            <span
              className={`status-badge ${connectionFailed ? 'status-error' : ''}`}
              role="status"
            >
              <i />
              {statusLabel}
            </span>
          </div>
          <h3 key={status}>
            {connected ? t.protectedTitle : connecting ? t.connectingTitle : t.ready}
          </h3>
          <p>{connected ? t.connectedDesc : connecting ? t.connectingDesc : t.offlineDesc}</p>
          <button
            className={`connection-action ${connected || connecting ? 'secondary-action' : ''}`}
            onClick={onToggle}
            disabled={busy}
            aria-busy={busy || connecting}
          >
            {busy || connecting ? <LoaderCircle size={18} className="spin" /> : <Power size={18} />}
            {connected ? t.disconnect : connecting ? t.cancel : busy ? t.connecting : t.connect}
          </button>
          <span className="connection-hint">
            <LockKeyhole size={12} />
            {connected ? t.tunnelActive : connecting ? t.tunnelConnecting : t.authNote}
          </span>
        </div>
        <ConnectionVisual
          state={status}
          deviceLabel={t.device}
          networkLabel={t.network}
          tunnelLabel={connected ? t.tunnelActive : connecting ? t.tunnelConnecting : t.tunnelIdle}
        />
      </section>

      {statusError && (
        <div className="connection-error" role="alert">
          <AlertCircle size={19} />
          <div>
            <strong>{t.connectionError}</strong>
            <p>{statusError}</p>
          </div>
          <button onClick={onOpenLogs}>
            {t.viewLogs}
            <ArrowRight size={15} />
          </button>
        </div>
      )}

      <section className="session-section" aria-label={t.session}>
        <div className="section-caption">
          <h3>{t.session}</h3>
          <span>
            {connected
              ? stats.metricsAvailable
                ? t.sessionDesc
                : t.metricsUnavailable
              : connecting
                ? t.connecting
                : t.waiting}
          </span>
        </div>
        <div className="metrics-grid">
          <div className="metric-card">
            <div className="metric-label">
              <span>{t.duration}</span>
              <span className="metric-icon">
                <Clock3 size={17} />
              </span>
            </div>
            <strong className="time-value">{formatTime(stats.uptime)}</strong>
            <small>{t.durationHint}</small>
          </div>
          <div className="metric-card">
            <div className="metric-label">
              <span>{t.download}</span>
              <span className="metric-icon teal">
                <ArrowDownLeft size={18} />
              </span>
            </div>
            <strong>
              {stats.metricsAvailable ? (
                formatBytes(stats.bytesIn)
              ) : (
                <span className="metric-placeholder">{t.noData}</span>
              )}
            </strong>
            <small>
              {stats.metricsAvailable
                ? t.transferHint
                : connected
                  ? t.metricsUnavailable
                  : t.waiting}
            </small>
          </div>
          <div className="metric-card">
            <div className="metric-label">
              <span>{t.upload}</span>
              <span className="metric-icon blue">
                <ArrowUpRight size={18} />
              </span>
            </div>
            <strong>
              {stats.metricsAvailable ? (
                formatBytes(stats.bytesOut)
              ) : (
                <span className="metric-placeholder">{t.noData}</span>
              )}
            </strong>
            <small>
              {stats.metricsAvailable
                ? t.transferHint
                : connected
                  ? t.metricsUnavailable
                  : t.waiting}
            </small>
          </div>
        </div>
      </section>

      <div className="details-grid">
        <section className="gateway-card" aria-label={t.gateway}>
          <div className="panel-heading">
            <span className="eyebrow">{t.profile}</span>
            <span className="managed-badge">
              <LockKeyhole size={11} />
              {t.managed}
            </span>
          </div>
          <div className="gateway-identity">
            <span className="gateway-icon">
              <Server size={23} strokeWidth={1.6} />
            </span>
            <div>
              <h3>{t.gatewayName}</h3>
              <p>{t.gatewayDesc}</p>
            </div>
          </div>
          <div className="gateway-detail">
            <span>{t.protocol}</span>
            <strong>
              OpenVPN 3 <span>/ {release.version}</span>
            </strong>
          </div>
        </section>
        <section className="support-card">
          <span className="support-icon">
            <FileText size={21} strokeWidth={1.6} />
          </span>
          <h3>{t.supportTitle}</h3>
          <p>{t.supportDesc}</p>
          <button className="support-log-button" onClick={onOpenLogs}>
            {t.viewLogs}
            <ArrowUpRight size={16} />
          </button>
        </section>
      </div>
      <footer className="workspace-footer">
        <span>
          <ShieldCheck size={13} />
          {t.powered}
        </span>
        <span>
          {t.localClient} <b>·</b> v{clientVersion}
        </span>
      </footer>
    </div>
  );
}
