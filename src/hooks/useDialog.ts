import { useEffect, useRef, type RefObject } from 'react';

/** Keep a native dialog in sync with React state and focus its primary control. */
export function useDialog(open: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    }
    if (!open && dialog?.open) dialog.close();
  }, [open, initialFocus]);

  return dialogRef;
}
