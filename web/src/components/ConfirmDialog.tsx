// One confirm pattern for destructive actions (design audit #696, F16/F17). Deletes across Settings, Assets,
// Income, capital, ESS and the Filing NOA record were one tap with no confirm and no undo. None of those rows
// has an undo path (UndoToast undoes transaction batches only), so they ask first, naming the object.
//
// Imperative on purpose: `await confirmAction({...})` works from plain handlers and helpers like runDelete
// (no hook to thread through). <ConfirmHost /> is mounted once, inside the signed-in tree, for both shells.
// Built on the Radix Dialog the Explain sheet already uses, with ui.tsx's button language (brand is fixed).

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { BUTTON_BASE, BUTTON_TONE } from "./ui";

export interface ConfirmOptions {
  /** A question that names the object, e.g. "Delete the property 12 Smith St?" */
  title: string;
  /** What is lost. Defaults to "This can't be undone." */
  body?: ReactNode;
  /** The verb on the destructive button, e.g. "Delete property". */
  confirmLabel: string;
  cancelLabel?: string;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let showConfirm: ((p: Pending) => void) | null = null;

/** Ask before a destructive action. Resolves true only when the person picks the confirm button. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  // No host mounted (shouldn't happen in the app): fall back to the browser's confirm rather than deleting.
  if (!showConfirm) return Promise.resolve(window.confirm(opts.title));
  return new Promise((resolve) => showConfirm!({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    showConfirm = (next) =>
      setPending((cur) => {
        cur?.resolve(false); // a second request cancels the first; never leave a promise hanging
        return next;
      });
    return () => {
      showConfirm = null;
    };
  }, []);
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <Dialog.Root open={!!pending} onOpenChange={(open) => !open && close(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-ink/30" />
        <Dialog.Content
          role="alertdialog"
          className="fixed left-1/2 top-1/2 z-[81] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-card p-5 shadow-card"
        >
          <Dialog.Title className="text-base font-semibold text-ink">{pending?.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted">{pending?.body ?? "This can't be undone."}</Dialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" autoFocus className={`${BUTTON_BASE} ${BUTTON_TONE.ghost}`} onClick={() => close(false)}>
              {pending?.cancelLabel ?? "Cancel"}
            </button>
            <button type="button" className={`${BUTTON_BASE} border border-danger/40 bg-transparent text-danger hover:bg-danger/5`} onClick={() => close(true)}>
              {pending?.confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
