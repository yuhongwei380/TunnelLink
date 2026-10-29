import { useEffect, useRef, type RefObject } from 'react';

/** Keep a native dialog in sync with React state and focus its primary control. */
export function useDialog(open: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Escape otherwise closes the native dialog before the exit animation runs.
    const cancel = (event: Event) => event.preventDefault();
    dialog.addEventListener('cancel', cancel);
    let timer: number | undefined;
    const finishClose = () => {
      window.clearTimeout(timer);
      // Older WKWebView builds can expose <dialog> but reject close() after a
      // failed showModal() call. Keep the state transition best-effort so an
      // installation prompt cannot take down the React tree.
      try {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      } catch {
        dialog.removeAttribute('open');
      }
      delete dialog.dataset.closing;
    };
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target === dialog && event.animationName === 'dialog-exit') finishClose();
    };
    delete dialog.dataset.closing;
    if (open && dialog && !dialog.open) {
      // WKWebView has had versions where showModal() throws while the page is
      // still becoming active (notably when the first-run install prompt is
      // opened during startup). Fall back to a non-modal open dialog instead
      // of allowing an effect exception to leave a blank WebView.
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else if (typeof dialog.show === 'function') dialog.show();
        else dialog.setAttribute('open', '');
      } catch {
        dialog.setAttribute('open', '');
      }
      initialFocus?.current?.focus();
    }
    if (!open && dialog.open) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finishClose();
      else {
        dialog.dataset.closing = 'true';
        dialog.addEventListener('animationend', onAnimationEnd);
        timer = window.setTimeout(finishClose, 220);
      }
    }
    return () => {
      window.clearTimeout(timer);
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('animationend', onAnimationEnd);
      delete dialog.dataset.closing;
    };
  }, [open, initialFocus]);

  return dialogRef;
}
