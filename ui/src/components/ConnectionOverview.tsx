import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRightLeft,
  Clock3,
  Check,
  LoaderCircle,
  LockKeyhole,
  Power,
  Server,
} from 'lucide-react';
import { formatBytes, formatTime } from '../format';
import type { Messages } from '../messages';
import type { VpnAction, VpnState, VpnStats, VpnProfile } from '../types';
import release from '../../../resources/settings/openvpn3-release.json';

type Props = {
  profile?: VpnProfile;
  status: VpnState;
  stats: VpnStats;
  statusError: string;
  busy: boolean;
  disabled: boolean;
  action: VpnAction;
  t: Messages;
  onToggle: () => void;
  onSwitchUser: () => void;
};

export function ConnectionOverview({
  profile,
  status,
  stats,
  statusError,
  busy,
  disabled,
  action,
  t,
  onToggle,
  onSwitchUser,
}: Props) {
  const connected = status === 'CONNECTED';
  const connecting = status === 'CONNECTING';
  const stopping = action === 'cancelling' || action === 'disconnecting';
  const connectionFailed = Boolean(statusError) && !connected && !connecting;
  const statusLabel = stopping
    ? action === 'cancelling'
      ? t.cancelling
      : t.disconnecting
    : connected
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
        data-phase={
          stopping
            ? action
            : connecting
              ? 'connecting'
              : connected
                ? 'connected'
                : connectionFailed
                  ? 'failed'
                  : 'idle'
        }
        aria-label={t.status}
      >
        <div className="connection-copy">
          <div className="connection-heading">
            <h3>{profile?.displayName || t.overview}</h3>
            <span
              className={`status-badge ${connectionFailed ? 'status-error' : ''}`}
              role="status"
            >
              <i aria-hidden="true" />
              <span key={statusLabel} className="connection-label">
                {statusLabel}
              </span>
            </span>
          </div>
          <p className="connection-state-copy">
            {connected ? t.connectedDesc : connecting ? t.connectingDesc : t.offlineDesc}
          </p>
          <div className="connection-account-row">
            <button
              type="button"
              className="switch-user-button"
              onClick={onSwitchUser}
              disabled={disabled || busy || connecting || stopping || !profile?.requiresAuth}
              aria-haspopup="dialog"
            >
              <ArrowRightLeft size={15} strokeWidth={1.7} aria-hidden="true" />
              <span>{t.switchUser}</span>
            </button>
          </div>
          <div className="connection-action-row">
            <button
              className={`connection-action ${connected || connecting ? 'secondary-action' : ''}`}
              onClick={onToggle}
              disabled={disabled || busy}
              aria-busy={busy || connecting}
            >
              <span key={`${status}-${action}`} className="connection-button-content">
                {busy || connecting || stopping ? (
                  <LoaderCircle size={18} className="spin" />
                ) : connected ? (
                  <Check size={18} />
                ) : (
                  <Power size={18} />
                )}
                {stopping
                  ? statusLabel
                  : connected
                    ? t.disconnect
                    : connecting
                      ? t.cancel
                      : t.connect}
              </span>
            </button>
          </div>
          <div className="connection-progress" aria-hidden="true">
            <span />
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
              <h3>{profile?.displayName || t.gatewayName}</h3>
              <p>{profile ? profile.description : t.gatewayDesc}</p>
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
      </section>
      <footer className="workspace-footer">
        <span className="workspace-copyright">{t.copyright}</span>
      </footer>
    </div>
  );
}
