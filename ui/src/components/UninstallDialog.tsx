import { useRef } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';

type Props = {
  open: boolean;
  busy: boolean;
  error: string;
  t: Messages;
  onClose: () => void;
  onConfirm: () => void;
};

export function UninstallDialog({ open, busy, error, t, onClose, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog(open, cancelRef);
  return (
    <dialog
      ref={dialogRef}
      className="exit-dialog uninstall-dialog"
      role="alertdialog"
      aria-labelledby="uninstall-title"
      aria-describedby="uninstall-description"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <h2 id="uninstall-title">{t.uninstallTitle}</h2>
      <p id="uninstall-description" className="exit-dialog-desc">
        {t.uninstallDescription}
      </p>
      <ul className="uninstall-data-list">
        <li>{t.uninstallCredentials}</li>
        <li>{t.uninstallSettings}</li>
        <li>{t.uninstallApplication}</li>
      </ul>
      <p className="uninstall-note">{t.uninstallWarning}</p>
      {error && (
        <p className="uninstall-error" role="alert">
          {error}
        </p>
      )}
      <div className="exit-dialog-actions">
        <button ref={cancelRef} className="keep-open-button" onClick={onClose} disabled={busy}>
          {t.uninstallCancel}
        </button>
        <button className="uninstall-confirm-button" onClick={onConfirm} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
          {busy ? t.uninstalling : t.uninstallConfirm}
        </button>
      </div>
    </dialog>
  );
}
