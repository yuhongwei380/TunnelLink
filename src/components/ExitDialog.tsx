import { useRef } from 'react';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';
import type { VpnState } from '../types';

type Props = {
  open: boolean;
  appTitle: string;
  status: VpnState;
  t: Messages;
  onClose: () => void;
  onExit: () => Promise<void>;
};

export function ExitDialog({ open, appTitle, status, t, onClose, onExit }: Props) {
  const exitCancelRef = useRef<HTMLButtonElement>(null);
  const exitDialogRef = useDialog(open, exitCancelRef);
  const connected = status === 'CONNECTED';
  const connecting = status === 'CONNECTING';

  return (
    <dialog
      ref={exitDialogRef}
      className="exit-dialog"
      role="alertdialog"
      aria-labelledby="exit-dialog-title"
      aria-describedby="exit-dialog-desc"
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id="exit-dialog-title">{t.closePromptTitle.replace('{app}', appTitle)}</h2>
      <p className="exit-dialog-desc" id="exit-dialog-desc">
        {connected
          ? t.closePromptDescConnected
          : connecting
            ? t.closePromptDescConnecting
            : t.closePromptDescIdle}
      </p>
      <div className="exit-dialog-actions">
        <button ref={exitCancelRef} className="keep-open-button" onClick={onClose}>
          {t.cancelClose}
        </button>
        <button className="exit-button" onClick={() => void onExit()}>
          {t.exitApp}
        </button>
      </div>
    </dialog>
  );
}
