import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowRight,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Server,
  UserRound,
  X,
} from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';
import type { ConnectOptions } from '../types';

type Props = {
  open: boolean;
  credentials: ConnectOptions;
  busy: boolean;
  authError: string;
  t: Messages;
  onChange: (credentials: ConnectOptions) => void;
  onConnect: () => Promise<void>;
  onClose: () => void;
};

export function AuthDialog({
  open,
  credentials,
  busy,
  authError,
  t,
  onChange,
  onConnect,
  onClose,
}: Props) {
  const { username, password, remember } = credentials;
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialog(open, usernameRef);

  useEffect(() => {
    if (!open) {
      setShowPassword(false);
      setCapsLock(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = (event: KeyboardEvent | MouseEvent) =>
      setCapsLock(event.getModifierState('CapsLock'));
    const reset = () => {
      setCapsLock(false);
      setShowPassword(false);
    };
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('mousedown', update);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('mousedown', update);
      window.removeEventListener('blur', reset);
    };
  }, [open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onConnect();
  };

  return (
    <dialog
      ref={dialogRef}
      className="auth-dialog"
      aria-labelledby="auth-title"
      aria-describedby="auth-description"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="auth-dialog-header">
        <span className="auth-icon">
          <LockKeyhole size={24} strokeWidth={1.7} />
        </span>
        <button className="dialog-close" onClick={onClose} aria-label={t.close}>
          <X size={20} />
        </button>
      </div>
      <span className="eyebrow">{t.account}</span>
      <h2 id="auth-title">{t.login}</h2>
      <p id="auth-description">{t.loginDesc}</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="vpn-username">{t.username}</label>
        <div className="input-with-icon">
          <UserRound size={17} />
          <input
            ref={usernameRef}
            id="vpn-username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(event) => onChange({ ...credentials, username: event.target.value })}
            placeholder={t.usernamePlaceholder}
            required
            disabled={busy}
          />
        </div>
        <label htmlFor="vpn-password">{t.password}</label>
        <div className="password-field input-with-icon">
          <LockKeyhole size={17} />
          <input
            id="vpn-password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="password-hint password-warnings"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => onChange({ ...credentials, password: event.target.value })}
            placeholder={t.passwordPlaceholder}
            required
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            disabled={busy}
            aria-pressed={showPassword}
            aria-label={showPassword ? t.hidePassword : t.showPassword}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <p id="password-hint" className="input-hint">
          {t.passwordHint}
        </p>
        <div
          id="password-warnings"
          className="password-warnings"
          aria-live="polite"
          aria-atomic="true"
        >
          {capsLock && (
            <p>
              <ArrowUp size={14} />
              {t.capsLock}
            </p>
          )}
          {/^\s|\s$/.test(password) && (
            <p>
              <AlertCircle size={14} />
              {t.spaces}
            </p>
          )}
        </div>
        <label className="remember-label">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => onChange({ ...credentials, remember: event.target.checked })}
            aria-describedby="remember-hint"
            disabled={busy}
          />
          <span>{t.remember}</span>
        </label>
        <p id="remember-hint" className="input-hint remember-hint">
          {t.rememberHint}
        </p>
        {authError && (
          <div className="auth-error" role="alert">
            <AlertCircle size={17} />
            <p>{authError}</p>
          </div>
        )}
        <button type="submit" className="submit-button" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={17} />}
          {t.secureConnect}
          {!busy && <ArrowRight size={17} />}
        </button>
      </form>
      <div className="auth-gateway">
        <Server size={15} />
        <span>{t.gatewayName}</span>
        <span className="managed-badge">
          <Check size={11} />
          {t.managed}
        </span>
      </div>
      <p className="auth-security-note">{t.securityNote}</p>
    </dialog>
  );
}
