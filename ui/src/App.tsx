import { ProfileManager } from './components/ProfileManager';
import type { ProfileList } from './types';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ChevronRight, Info, LayoutDashboard, Terminal, X } from 'lucide-react';
import { AboutDialog, AGREEMENT_REVISION } from './components/AboutDialog';
import { AppLogo } from './components/AppLogo';
import { AuthDialog } from './components/AuthDialog';
import { ConnectionErrorDialog } from './components/ConnectionErrorDialog';
import { ConnectionOverview } from './components/ConnectionOverview';
import { ExitDialog } from './components/ExitDialog';
import { InstallDialog } from './components/InstallDialog';
import { LogsDialog } from './components/LogsDialog';
import { UninstallDialog } from './components/UninstallDialog';
import { useVpnConnection } from './hooks/useVpnConnection';
import { getMessages } from './messages';
import { mergeUiCopy, type Locale, type UiCopy } from './ui-copy';
import release from '../../resources/settings/openvpn3-release.json';
import defaultUiCopy from '../../resources/settings/ui-copy.json';
import branding from '../../resources/settings/app-branding.json';

const configuredLocale: Locale =
  String(branding.defaultLocale || 'CN')
    .trim()
    .toUpperCase() === 'EN'
    ? 'en'
    : 'zh';

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem('vpn-ui-locale');
    return saved === 'zh' || saved === 'en' ? saved : configuredLocale;
  });
  const [uiCopy, setUiCopy] = useState<UiCopy>(() => defaultUiCopy);

  const t = getMessages(locale, uiCopy);
  const [logsOpen, setLogsOpen] = useState(false);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [agreementRequired, setAgreementRequired] = useState(false);
  const [installPromptOpen, setInstallPromptOpen] = useState(false);
  const [installRequired, setInstallRequired] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [canUninstall, setCanUninstall] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [uninstallError, setUninstallError] = useState('');
  const uninstallPending = useRef(false);
  const [meta, setMeta] = useState({ name: '', version: '' });
  const [profiles, setProfiles] = useState<ProfileList | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const selectedProfile = profiles?.profiles.find((p) => p.id === profiles.selectedProfileId);
  useEffect(() => {
    window.vpn
      ?.listProfiles()
      .then(setProfiles)
      .catch((e) => setToast(String(e)));
  }, []);
  const profileAction = async (
    action: 'import' | 'select' | 'rename' | 'delete',
    id = '',
    name = '',
  ) => {
    if (!window.vpn || profileBusy) return;
    setProfileBusy(true);
    try {
      const result =
        action === 'import'
          ? await window.vpn.importProfile()
          : action === 'select'
            ? await window.vpn.selectProfile(id)
            : action === 'rename'
              ? await window.vpn.renameProfile(id, name)
              : await window.vpn.deleteProfile(id);
      setProfiles(result);
    } catch (error) {
      setToast(String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  const {
    status,
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
  } = useVpnConnection(t, setToast, selectedProfile);
  const clientVersion = meta.version || release.version;
  const isDesktop = Boolean(window.vpn);
  const appTitle = t.appTitle;

  useEffect(() => {
    localStorage.setItem('vpn-ui-locale', locale);
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  useEffect(() => {
    if (import.meta.env.DEV && window.location.hash.startsWith('#close-prompt')) {
      setExitPromptOpen(true);
    }
  }, []);

  useEffect(() => {
    window.vpn
      ?.getUiCopy()
      .then((copy) => setUiCopy(mergeUiCopy(defaultUiCopy, copy)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('app-close-requested', () => {
      if (uninstallPending.current) return;
      setLogsOpen(false);
      closeAuth();
      setAboutOpen(false);
      setInstallPromptOpen(false);
      setExitPromptOpen(true);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDesktop]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    const desktop = window.vpn;
    if (!desktop) return;
    Promise.allSettled([desktop.getAppMeta(), desktop.getInstallationState()]).then(
      ([metaResult, installationResult]) => {
        if (!active) return;
        const data = metaResult.status === 'fulfilled' ? metaResult.value : null;
        const installation =
          installationResult.status === 'fulfilled' ? installationResult.value : null;
        if (data) setMeta(data);
        const platform = installation?.platform ?? data?.platform;
        const needsInstall = installation?.needsInstall === true;
        const needsAgreement =
          platform === 'macos' &&
          localStorage.getItem('vpn-agreement-revision') !== AGREEMENT_REVISION;
        setInstallRequired(needsInstall);
        setCanUninstall(
          installation?.canUninstall === true ||
            (platform === 'macos' && installation?.needsInstall === false),
        );
        setAgreementRequired(needsAgreement);
        if (needsInstall) setInstallPromptOpen(true);
        else if (needsAgreement) setAboutOpen(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const handleToggle = () => {
    if (installRequired) {
      setInstallPromptOpen(true);
      return;
    }
    if (agreementRequired) {
      setAboutOpen(true);
      return;
    }
    void toggle();
  };

  const closeInstallPrompt = () => {
    if (installBusy) return;
    setInstallPromptOpen(false);
    if (agreementRequired) setAboutOpen(true);
  };

  const installToApplications = async () => {
    if (!window.vpn) return;
    setInstallBusy(true);
    try {
      await window.vpn.installToApplications();
    } catch {
      setInstallBusy(false);
      setToast(t.installFailed);
    }
  };

  const exitApp = async () => {
    try {
      await window.vpn?.exit();
    } catch {
      setToast(t.exitFailed);
    }
  };

  const uninstallApp = async () => {
    if (!window.vpn || uninstallPending.current) return;
    uninstallPending.current = true;
    setUninstallBusy(true);
    setUninstallError('');
    try {
      await window.vpn.uninstall();
    } catch (error) {
      uninstallPending.current = false;
      setUninstallBusy(false);
      setUninstallError(`${t.uninstallFailed}\n${String(error)}`);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-brand">
          <AppLogo />
          <h1>{appTitle}</h1>
        </div>
        <button
          className="language-button"
          onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}
          title={locale === 'zh' ? 'Switch to English' : '切换为中文'}
        >
          <span className="language-glyph" aria-hidden="true">
            <span className="glyph-chars">
              <span className="glyph-wen">文</span>
              <span className="glyph-a">A</span>
            </span>
            <svg className="glyph-swap" width="20" height="7" viewBox="0 0 20 7" fill="none">
              <path
                d="M2 3.5h16M4.8 0.9 2 3.5l2.8 2.6M15.2 0.9 18 3.5l-2.8 2.6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <nav className="primary-nav" aria-label={t.workspaceNav}>
            <button
              className="active"
              onClick={() => setLogsOpen(false)}
              aria-current="page"
              title={t.connection}
            >
              <LayoutDashboard size={19} />
              <span>{t.connection}</span>
              <ChevronRight className="nav-chevron" size={15} />
            </button>
            <button
              onClick={() => setLogsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={logsOpen}
              title={t.diagnostics}
            >
              <Terminal size={19} />
              <span>{t.diagnostics}</span>
              {Boolean(statusError) && <span className="error-dot" />}
            </button>
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-utility">
              <button className="about-button" onClick={() => setAboutOpen(true)} title={t.about}>
                <Info size={17} />
                <span>{t.about}</span>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </aside>

        <div className="workspace">
          <main className="main-scroll" id="main-content">
            <ProfileManager
              data={profiles}
              locale={locale}
              locked={status !== 'DISCONNECTED' || busy || authOpen || uninstallBusy}
              pending={profileBusy}
              onAction={profileAction}
            />
            <ConnectionOverview
              status={status}
              stats={stats}
              statusError={statusError}
              busy={busy || profileBusy || !selectedProfile || Boolean(selectedProfile.error)}
              profile={selectedProfile}
              action={action}
              t={selectedProfile ? { ...t, connect: locale === 'zh' ? '连接' : 'Connect' } : t}
              onToggle={handleToggle}
              onSwitchUser={() => {
                if (installRequired) setInstallPromptOpen(true);
                else if (agreementRequired) setAboutOpen(true);
                else switchUser();
              }}
            />
          </main>
          {!isDesktop && (
            <div className="preview-notice">
              <Info size={13} />
              {t.desktopOnly}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="toast" role="status">
          <Info size={18} />
          <span>{toast}</span>
          <button aria-label={t.close} onClick={() => setToast('')}>
            <X size={17} />
          </button>
        </div>
      )}

      <LogsDialog open={logsOpen} t={t} onClose={() => setLogsOpen(false)} onNotify={setToast} />
      <ConnectionErrorDialog
        open={connectionErrorOpen && !uninstallOpen}
        statusError={statusError}
        t={t}
        onClose={dismissConnectionError}
        onOpenLogs={() => {
          dismissConnectionError();
          setLogsOpen(true);
        }}
      />
      <ExitDialog
        open={exitPromptOpen}
        appTitle={appTitle}
        status={status}
        t={t}
        onClose={() => setExitPromptOpen(false)}
        onExit={exitApp}
      />
      <AuthDialog
        open={authOpen && !uninstallOpen}
        credentials={credentials}
        busy={busy}
        busyLabel={action === 'disconnecting' ? t.disconnecting : t.connecting}
        authError={authError}
        switchingUser={switchingUser}
        willDisconnect={switchingUser && status === 'CONNECTED'}
        t={t}
        onChange={setCredentials}
        onConnect={connect}
        onClose={closeAuth}
      />
      <InstallDialog
        open={installPromptOpen}
        appTitle={appTitle}
        busy={installBusy}
        t={t}
        onClose={closeInstallPrompt}
        onInstall={() => void installToApplications()}
      />
      <AboutDialog
        open={aboutOpen}
        agreementRequired={agreementRequired}
        appTitle={appTitle}
        clientVersion={clientVersion}
        canUninstall={canUninstall}
        onUninstall={() => {
          setAboutOpen(false);
          setUninstallError('');
          setUninstallOpen(true);
        }}
        t={t}
        onClose={() => setAboutOpen(false)}
        onAcceptAgreement={() => {
          localStorage.setItem('vpn-agreement-revision', AGREEMENT_REVISION);
          setAgreementRequired(false);
          setAboutOpen(false);
        }}
      />
      <UninstallDialog
        open={uninstallOpen}
        busy={uninstallBusy}
        error={uninstallError}
        t={t}
        onClose={() => {
          if (uninstallPending.current) return;
          setUninstallOpen(false);
          setAboutOpen(true);
        }}
        onConfirm={() => void uninstallApp()}
      />
    </div>
  );
}
