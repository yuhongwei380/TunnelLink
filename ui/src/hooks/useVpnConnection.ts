import { useCallback, useEffect, useRef, useState } from 'react';
import type { Messages } from '../messages';
import type { ConnectOptions, VpnAction, VpnState, VpnStats, VpnProfile } from '../types';

type ConnectionMessages = Pick<
  Messages,
  'statusFailed' | 'disconnectFailed' | 'invalidCredentials' | 'runtimeOnly' | 'connectFailed'
>;

const isAuthenticationError = (message: string) =>
  /AUTH_FAILED|AUTH_REJECT|authentication.*fail|invalid.*(credential|password)|认证失败|身份验证失败/i.test(
    message,
  );

export function useVpnConnection(
  t: ConnectionMessages,
  notify: (message: string) => void,
  profile?: VpnProfile,
) {
  const [status, setStatus] = useState<VpnState>('DISCONNECTED');
  const [connectedUsername, setConnectedUsername] = useState('');
  const [stats, setStats] = useState<VpnStats>({
    uptime: 0,
    bytesIn: 0,
    bytesOut: 0,
    metricsAvailable: false,
    assignedIp: null,
    gatewayAddress: null,
  });
  const [statusError, setStatusError] = useState('');
  const [connectionErrorOpen, setConnectionErrorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<VpnAction>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [switchingUser, setSwitchingUser] = useState(false);
  const [authError, setAuthError] = useState('');
  const [credentials, setCredentials] = useState<ConnectOptions>({
    username: '',
    password: '',
    remember: false,
  });
  const actionPending = useRef(false);
  const operationVersion = useRef(0);
  const sessionCredentials = useRef<ConnectOptions | null>(null);
  const attemptedCredentials = useRef<ConnectOptions | null>(null);
  const credentialsLoaded = useRef<Promise<void> | null>(null);
  const interacted = useRef(false);
  const connectionErrorOverride = useRef('');
  const dismissedConnectionError = useRef('');

  useEffect(() => {
    // Development-only previews: #close-prompt, #close-prompt-connected, #close-prompt-connecting.
    if (!import.meta.env.DEV || !window.location.hash.startsWith('#close-prompt')) return;
    if (window.location.hash.includes('connected')) setStatus('CONNECTED');
    else if (window.location.hash.includes('connecting')) setStatus('CONNECTING');
  }, []);

  useEffect(() => {
    let active = true;
    operationVersion.current += 1;
    sessionCredentials.current = null;
    setConnectedUsername('');
    attemptedCredentials.current = null;
    interacted.current = false;
    setCredentials({ username: '', password: '', remember: false });
    setAuthOpen(false);
    setAuthError('');
    setStatusError('');
    connectionErrorOverride.current = '';
    setConnectionErrorOpen(false);
    credentialsLoaded.current =
      window.vpn
        ?.getSavedCredentials()
        .then((result) => {
          if (
            active &&
            !interacted.current &&
            result.ok &&
            result.credentials &&
            result.credentials.profileId === profile?.id
          ) {
            setCredentials(result.credentials);
            // The native store only saves credentials after a successful connection.
            sessionCredentials.current = result.credentials;
          }
        })
        .catch(() => {
          /* Credentials can still be entered manually. */
        }) ?? null;

    return () => {
      active = false;
    };
  }, [profile?.id, profile?.revision]);

  const refreshStatus = useCallback(async () => {
    if (!window.vpn || actionPending.current) return;
    const version = operationVersion.current;
    try {
      const data = await window.vpn.status();
      // A poll started before a click must not overwrite the new transition.
      if (version !== operationVersion.current || actionPending.current) return;
      setStatus(data.state);
      if (data.state === 'CONNECTED') {
        if (attemptedCredentials.current) {
          sessionCredentials.current = attemptedCredentials.current;
          setConnectedUsername(sessionCredentials.current.username);
          attemptedCredentials.current = null;
          if (!sessionCredentials.current.remember) {
            setCredentials((current) => ({ ...current, password: '' }));
          }
        }
        setAction(null);
      } else if (data.state === 'CONNECTING') {
        setAction('connecting');
      } else {
        setConnectedUsername('');
        setAction(null);
        if (attemptedCredentials.current || sessionCredentials.current) {
          attemptedCredentials.current = null;
          if (profile?.requiresAuth && isAuthenticationError(data.lastError || '')) {
            sessionCredentials.current = null;
            dismissedConnectionError.current = data.lastError || '';
            setAuthError(data.lastError || t.connectFailed);
            setAuthOpen(true);
          }
        }
      }
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
      if (version === operationVersion.current && !actionPending.current)
        setStatusError(t.statusFailed);
    }
  }, [t.statusFailed, t.connectFailed, profile?.id, profile?.requiresAuth]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (!statusError) {
      dismissedConnectionError.current = '';
      return;
    }
    if (
      authOpen ||
      busy ||
      status !== 'DISCONNECTED' ||
      statusError === dismissedConnectionError.current
    )
      return;
    // Brief status failures during startup/reconnect should not flash a modal.
    const timer = window.setTimeout(() => setConnectionErrorOpen(true), 250);
    return () => window.clearTimeout(timer);
  }, [statusError, authOpen, busy, status]);

  const dismissConnectionError = useCallback(() => {
    dismissedConnectionError.current = statusError;
    setConnectionErrorOpen(false);
  }, [statusError]);

  const startConnection = async (options: ConnectOptions, automatic = false) => {
    if (actionPending.current) return;
    if (!profile || profile.error) return;
    if (profile.requiresAuth && (!options.username.trim() || !options.password)) {
      setAuthError(t.invalidCredentials);
      setAuthOpen(true);
      return;
    }
    if (!window.vpn) {
      setAuthError(t.runtimeOnly);
      setAuthOpen(true);
      return;
    }
    actionPending.current = true;
    operationVersion.current += 1;
    if (!automatic) sessionCredentials.current = null;
    attemptedCredentials.current = {
      ...options,
      profileId: profile.id,
      username: options.username.trim(),
    };
    setBusy(true);
    setAction('connecting');
    setStatus('CONNECTING');
    setAuthOpen(false);
    setConnectionErrorOpen(false);
    setAuthError('');
    connectionErrorOverride.current = '';
    dismissedConnectionError.current = '';
    setStatusError('');
    try {
      const result = await window.vpn.connect(attemptedCredentials.current);
      if (!result.ok) throw new Error(result.error || t.connectFailed);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.connectFailed;
      const needsLogin = Boolean(
        profile.requiresAuth && (!automatic || isAuthenticationError(message)),
      );
      attemptedCredentials.current = null;
      if (isAuthenticationError(message)) sessionCredentials.current = null;
      connectionErrorOverride.current = message;
      dismissedConnectionError.current = needsLogin ? message : '';
      setAction(null);
      setStatus('DISCONNECTED');
      setStatusError(message);
      if (needsLogin) {
        setCredentials(options);
        setAuthError(message);
        setAuthOpen(true);
      }
    } finally {
      setBusy(false);
      actionPending.current = false;
    }
    await refreshStatus();
  };

  const stopConnection = async () => {
    if (actionPending.current || !window.vpn) return false;
    actionPending.current = true;
    operationVersion.current += 1;
    attemptedCredentials.current = null;
    setAction(status === 'CONNECTING' ? 'cancelling' : 'disconnecting');
    setBusy(true);
    let stopped = false;
    try {
      // Keep fast operations visible long enough for the progress indicator to register.
      const [result] = await Promise.all([
        window.vpn.disconnect(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 600)),
      ]);
      if (!result.ok) throw new Error(result.error || t.disconnectFailed);
      connectionErrorOverride.current = '';
      setStatusError('');
      setStatus('DISCONNECTED');
      stopped = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t.disconnectFailed;
      if (authOpen) setAuthError(message);
      else notify(message);
    } finally {
      setBusy(false);
      actionPending.current = false;
      setAction(null);
    }
    await refreshStatus();
    return stopped;
  };

  const toggle = async () => {
    if (actionPending.current) return;
    if (status === 'DISCONNECTED') {
      if (!profile || profile.error) return;
      if (!profile.requiresAuth) {
        await startConnection({ username: '', password: '', remember: false }, true);
        return;
      }
      const version = operationVersion.current;
      await credentialsLoaded.current;
      if (version !== operationVersion.current) return;
      if (actionPending.current) return;
      interacted.current = true;
      if (sessionCredentials.current) {
        await startConnection(sessionCredentials.current, true);
      } else {
        setSwitchingUser(false);
        setAuthError('');
        setAuthOpen(true);
      }
      return;
    }
    await stopConnection();
  };

  const switchUser = () => {
    if (actionPending.current || status === 'CONNECTING') return;
    interacted.current = true;
    setSwitchingUser(true);
    setCredentials({ username: '', password: '', remember: false });
    setAuthError('');
    setConnectionErrorOpen(false);
    setAuthOpen(true);
  };

  const closeAuth = () => {
    if (actionPending.current) return;
    setAuthOpen(false);
    setSwitchingUser(false);
  };

  const connect = async () => {
    if (actionPending.current) return;
    if (switchingUser && status !== 'DISCONNECTED') {
      // Validate before disrupting the existing user's connection.
      if (!credentials.username.trim() || !credentials.password) {
        setAuthError(t.invalidCredentials);
        return;
      }
      if (!(await stopConnection())) return;
    }
    setSwitchingUser(false);
    await startConnection(credentials);
  };

  return {
    status,
    connectedUsername,
    stats,
    statusError,
    connectionErrorOpen,
    dismissConnectionError,
    busy,
    action,
    authOpen,
    closeAuth,
    switchingUser,
    switchUser,
    authError,
    credentials,
    setCredentials,
    toggle,
    connect,
  };
}
