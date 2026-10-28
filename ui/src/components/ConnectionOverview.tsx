import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Power,
  Server,
} from 'lucide-react';
import { formatBytes, formatTime } from '../format';
import type { Messages } from '../messages';
import type { VpnState, VpnStats } from '../types';
import release from '../../../config/openvpn3-release.json';

type Props = {
  status: VpnState;
  stats: VpnStats;
  statusError: string;
  busy: boolean;
  t: Messages;
  onToggle: () => void;
  onOpenLogs: () => void;
};

export function ConnectionOverview({
  status,
  stats,
  statusError,
  busy,
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
    <div className="page-content connection-page">
      <section
        className={`connection-card ${connected ? 'is-connected' : connecting ? 'is-connecting' : connectionFailed ? 'has-error' : ''}`}
        aria-label={t.status}
      >
        <div className="connection-copy">
          <h3>{t.overview}</h3>
          <p className="connection-state-copy">
            {connected ? t.connectedDesc : connecting ? t.connectingDesc : t.offlineDesc}
          </p>
          <div className="connection-action-row">
            <span
              className={`status-badge ${connectionFailed ? 'status-error' : ''}`}
              role="status"
            >
              <i />
              {statusLabel}
            </span>
            <button
              className={`connection-action ${connected || connecting ? 'secondary-action' : ''}`}
              onClick={onToggle}
              disabled={busy}
              aria-busy={busy || connecting}
            >
              {busy || connecting ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <Power size={18} />
              )}
              {connected ? t.disconnect : connecting ? t.cancel : busy ? t.connecting : t.connect}
            </button>
          </div>
        </div>
      </section>

      <section className={`details-card ${connected ? 'is-connected' : ''}`} aria-label={t.gateway}>
        <div className="details-card-main">
          <div className="panel-heading">
            <span className="eyebrow">{t.gateway}</span>
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
          <div className="gateway-net">
            <div className="gateway-net-item">
              <span>{t.assignedIp}</span>
              <strong>{stats.assignedIp || '—'}</strong>
            </div>
            <div className="gateway-net-item">
              <span>{t.gatewayAddress}</span>
              <strong>{stats.gatewayAddress || '—'}</strong>
            </div>
          </div>
          <div className="gateway-detail">
            <span>{t.protocol}</span>
            <strong>
              OpenVPN 3 <span>/ {release.version}</span>
            </strong>
          </div>
        </div>
        <div className="details-card-session">
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
        </div>
        <div className="details-card-footer">
          <div className="details-card-log-copy">
            <FileText size={17} strokeWidth={1.7} />
            <span>
              <strong>{t.supportTitle}</strong>
              <small>{t.supportDesc}</small>
            </span>
          </div>
          <button className="support-log-button" onClick={onOpenLogs}>
            {t.viewLogs}
            <ArrowUpRight size={16} />
          </button>
        </div>
      </section>
      <footer className="workspace-footer">
        <span className="workspace-copyright">{t.copyright}</span>
      </footer>
    </div>
  );
}
