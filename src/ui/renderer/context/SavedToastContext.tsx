import { createContext, useCallback, useContext } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { NoticeLiveRegion, NoticeToast } from "../components/StatusBar.js";
import { useStatusNotices, type ToastItem } from "../hooks/use-status-bar.js";

const SavedToastContext = createContext<(() => void) | null>(null);

export const SavedToastProvider = SavedToastContext.Provider;

export function useNotifySaved(): () => void {
  const cb = useContext(SavedToastContext);
  // Without a provider saving toasts is a no-op; warn in development so mis-mounted settings do not fail silently.
  if (cb == null) {
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[saved-toast] useNotifySaved() called outside <SavedToastProvider>. " +
          "Wrap the consumer in <SavedToastProvider value={notifySaved}> so " +
          "save events surface the dialog-wide toast.",
      );
    }
    return () => {};
  }
  return cb;
}

/** How long "Saved" stays: a confirmation of what the person just did, read at a glance. */
export const SAVED_NOTICE_TTL_MS = 2400;

/**
 * The settings save confirmation: its own notice queue, so it obeys the shared notice rules (one at a time, held behind a
 * modal, auto-dismissing) while staying where the eye lands after Save — the top of the settings route, not the window's
 * strip at the foot of the canvas. Repeated saves replace the one "Saved" notice rather than queueing copies of it.
 */
export function useSavedNotice() {
  const { t } = useTranslation();
  const notices = useStatusNotices({ defaultToastTtlMs: SAVED_NOTICE_TTL_MS });
  const { upsertToast, removeToast } = notices;
  const notifySaved = useCallback(() => {
    upsertToast("settings-saved", { severity: "success", message: t("savedToast.saved"), kind: "settings-saved" });
  }, [t, upsertToast]);
  const dismiss = useCallback((toast: ToastItem) => removeToast(toast.id), [removeToast]);
  return { notifySaved, visibleToast: notices.visibleToast, dismiss };
}

export function SavedToastFloating({ toast, onDismiss }: { toast: ToastItem | null; onDismiss: (toast: ToastItem) => void }) {
  return (
    <>
      <NoticeLiveRegion toast={toast} />
      {toast !== null ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4" data-testid="settings-saved-toast">
          <NoticeToast key={toast.id} toast={toast} onDismiss={onDismiss} wrap className="pointer-events-auto shadow-lg" />
        </div>
      ) : null}
    </>
  );
}
