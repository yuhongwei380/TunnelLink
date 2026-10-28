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
      dialog.close();
      delete dialog.dataset.closing;
    };
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target === dialog && event.animationName === 'dialog-exit') finishClose();
    };
    delete dialog.dataset.closing;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
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
