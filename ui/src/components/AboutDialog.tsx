import { useState } from 'react';
import { Check, FileText, Info, X } from 'lucide-react';
import { AppLogo } from './AppLogo';
import { useDialog } from '../hooks/useDialog';
import type { Messages } from '../messages';
import release from '../../../config/openvpn3-release.json';
import agreement from '../../../resources/legal/USER-AGREEMENT.txt?raw';
import notices from '../../../LICENSES/THIRD-PARTY-NOTICES.txt?raw';

export const AGREEMENT_REVISION = '2026-10-25';

type Props = {
  open: boolean;
  agreementRequired: boolean;
  appTitle: string;
  clientVersion: string;
  t: Messages;
  onClose: () => void;
  onAcceptAgreement: () => void;
};

export function AboutDialog({
  open,
  agreementRequired,
  appTitle,
  clientVersion,
  t,
  onClose,
  onAcceptAgreement,
}: Props) {
  const [legalPage, setLegalPage] = useState<'agreement' | 'notices'>('agreement');
  const aboutRef = useDialog(open);

  return (
    <dialog
      ref={aboutRef}
      className="about-dialog"
      aria-labelledby="about-title"
      onCancel={(event) => {
        if (agreementRequired) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <div className="about-header">
        <AppLogo />
        <div>
          <span className="eyebrow">{appTitle}</span>
          <h2 id="about-title">{t.about}</h2>
        </div>
        {!agreementRequired && (
          <button className="dialog-close" onClick={onClose} aria-label={t.close}>
            <X size={20} />
          </button>
        )}
      </div>
      <p className="about-subtitle">{t.legalSubtitle}</p>
      <div className="derivative-note">
        <Info size={17} />
        <p>{t.derivative}</p>
      </div>
      <dl className="version-details">
        <div>
          <dt>{t.clientVersion}</dt>
          <dd>{clientVersion}</dd>
        </div>
        <div>
          <dt>{t.coreVersion}</dt>
          <dd>{release.version}</dd>
        </div>
        <div>
          <dt>{t.upstream}</dt>
          <dd>{release.ref}</dd>
        </div>
      </dl>
      <div className="legal-tabs">
        <button aria-pressed={legalPage === 'agreement'} onClick={() => setLegalPage('agreement')}>
          <FileText size={16} />
          {t.agreement}
        </button>
        <button aria-pressed={legalPage === 'notices'} onClick={() => setLegalPage('notices')}>
          <Info size={16} />
          {t.notices}
        </button>
      </div>
      <pre
        className="legal-text"
        tabIndex={0}
        aria-label={legalPage === 'agreement' ? t.agreement : t.notices}
      >
        {legalPage === 'agreement' ? agreement : notices}
      </pre>
      {agreementRequired && (
        <div className="agreement-accept">
          <p className="input-hint">{t.firstRunAgreement}</p>
          <button className="submit-button" onClick={onAcceptAgreement}>
            <Check size={17} />
            {t.acceptAgreement}
          </button>
        </div>
      )}
    </dialog>
  );
}
