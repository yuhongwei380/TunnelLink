import { useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';

type Props = {
  open: boolean;
  statusError: string;
  t: Messages;
  onClose: () => void;
  onOpenLogs: () => void;
};

/** Modal alert for connection failures, replacing the old inline banner. */
export function ConnectionErrorDialog({ open, statusError, t, onClose, onOpenLogs }: Props) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog(open, dismissRef);

  return (
    <dialog
      ref={dialogRef}
      className="exit-dialog connection-error-dialog"
      role="alertdialog"
      aria-labelledby="connection-error-title"
      aria-describedby="connection-error-desc"
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id="connection-error-title">
        <AlertCircle size={22} aria-hidden="true" />
        <span>{t.connectionError}</span>
      </h2>
      <p className="exit-dialog-desc" id="connection-error-desc">
        {statusError}
      </p>
      <div className="exit-dialog-actions">
        <button ref={dismissRef} type="button" className="keep-open-button" onClick={onClose}>
          {t.errorDismiss}
        </button>
        <button type="button" className="error-primary-button" onClick={onOpenLogs}>
          {t.viewLogs}
        </button>
      </div>
    </dialog>
  );
}
