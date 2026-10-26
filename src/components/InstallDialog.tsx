import { ArrowRight, Check, FolderOpen, Info, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';

type Props = {
  open: boolean;
  appTitle: string;
  busy: boolean;
  t: Messages;
  onClose: () => void;
  onInstall: () => void;
};

export function InstallDialog({ open, appTitle, busy, t, onClose, onInstall }: Props) {
  const dialogRef = useDialog(open);

  return (
    <dialog
      ref={dialogRef}
      className="install-dialog"
      aria-labelledby="install-dialog-title"
      aria-describedby="install-dialog-desc"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <div className="install-dialog-heading">
        <div className="install-icon" aria-hidden="true">
          <FolderOpen size={24} />
        </div>
        <div>
          <span className="eyebrow">{appTitle}</span>
          <h2 id="install-dialog-title">{t.installTitle}</h2>
        </div>
        {!busy && (
          <button className="dialog-close" onClick={onClose} aria-label={t.close}>
            <X size={20} />
          </button>
        )}
      </div>
      <p className="install-dialog-desc" id="install-dialog-desc">
        {t.installDesc}
      </p>
      <div className="install-location" aria-label={t.installNow}>
        <div className="install-location-item">
          <FolderOpen size={18} />
          <span>{appTitle}</span>
        </div>
        <ArrowRight size={17} aria-hidden="true" />
        <div className="install-location-item install-location-target">
          <FolderOpen size={18} />
          <span>Applications</span>
        </div>
      </div>
      <div className="install-dialog-note">
        <Info size={16} />
        <span>{t.installNote}</span>
      </div>
      <div className="install-dialog-actions">
        <button className="secondary-button" onClick={onClose} disabled={busy}>
          {t.installLater}
        </button>
        <button className="submit-button" onClick={onInstall} disabled={busy}>
          <Check size={17} />
          {busy ? t.installing : t.installNow}
        </button>
      </div>
    </dialog>
  );
}
