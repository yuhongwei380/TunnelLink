import { useCallback, useEffect, useRef, useState } from 'react';
import type { Messages } from '../messages';
import type { ConnectOptions, VpnState, VpnStats } from '../types';

type ConnectionMessages = Pick<
  Messages,
  'statusFailed' | 'disconnectFailed' | 'invalidCredentials' | 'runtimeOnly' | 'connectFailed'
>;

export function useVpnConnection(t: ConnectionMessages, notify: (message: string) => void) {
  const [status, setStatus] = useState<VpnState>('DISCONNECTED');
  const [stats, setStats] = useState<VpnStats>({
    uptime: 0,
    bytesIn: 0,
    bytesOut: 0,
    metricsAvailable: false,
    assignedIp: null,
    gatewayAddress: null,
  });
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [credentials, setCredentials] = useState<ConnectOptions>({
    username: '',
    password: '',
    remember: false,
  });
  const { username, password, remember } = credentials;
  const actionPending = useRef(false);
  const connectionErrorOverride = useRef('');

  useEffect(() => {
    // Development-only previews: #close-prompt, #close-prompt-connected, #close-prompt-connecting.
    if (!import.meta.env.DEV || !window.location.hash.startsWith('#close-prompt')) return;
    if (window.location.hash.includes('connected')) setStatus('CONNECTED');
    else if (window.location.hash.includes('connecting')) setStatus('CONNECTING');
  }, []);

  useEffect(() => {
    let active = true;
    window.vpn
      ?.getSavedCredentials()
      .then((result) => {
        if (active && result.ok && result.credentials) {
          setCredentials(result.credentials);
        }
      })
      .catch(() => {
        /* Credentials can still be entered manually. */
      });

    return () => {
      active = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!window.vpn) return;
    try {
      const data = await window.vpn.status();
      setStatus(data.state);
      setStats({
        uptime: data.uptime,
        bytesIn: data.bytesIn,
        bytesOut: data.bytesOut,
        metricsAvailable: data.metricsAvailable === true,
        assignedIp: data.assignedIp ?? null,
        gatewayAddress: data.gatewayAddress ?? null,
      });
      setStatusError(data.lastError || connectionErrorOverride.current);
    } catch {
      setStatusError(t.statusFailed);
    }
  }, [t.statusFailed]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const toggle = async () => {
    if (actionPending.current) return;
    if (status === 'DISCONNECTED') {
      setAuthError('');
      setAuthOpen(true);
      return;
    }
    if (!window.vpn) return;
    actionPending.current = true;
    setBusy(true);
    try {
      const result = await window.vpn.disconnect();
      if (!result.ok) throw new Error(result.error || t.disconnectFailed);
      await refreshStatus();
    } catch (error) {
      notify(error instanceof Error ? error.message : t.disconnectFailed);
    } finally {
      setBusy(false);
      actionPending.current = false;
    }
  };

  const connect = async () => {
    if (actionPending.current) return;
    if (!username.trim() || !password) {
      setAuthError(t.invalidCredentials);
      return;
    }
    if (!window.vpn) {
      setAuthError(t.runtimeOnly);
      return;
    }
    actionPending.current = true;
    setBusy(true);
    setAuthError('');
    connectionErrorOverride.current = '';
    setStatusError('');
    try {
      const result = await window.vpn.connect({ username: username.trim(), password, remember });
      if (!result.ok) throw new Error(result.error || t.connectFailed);
      connectionErrorOverride.current = '';
      setAuthOpen(false);
      if (!remember) setCredentials((current) => ({ ...current, password: '' }));
      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : t.connectFailed;
      connectionErrorOverride.current = message;
      setStatus('DISCONNECTED');
      setStatusError(message);
      setAuthError(message);
    } finally {
      setBusy(false);
      actionPending.current = false;
    }
  };

  return {
    status,
    stats,
    statusError,
    busy,
    authOpen,
    setAuthOpen,
    authError,
    credentials,
    setCredentials,
    toggle,
    connect,
  };
}
