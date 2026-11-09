import { createContext, useContext, useEffect, useRef } from "react";
import type { NoticeInput, NoticeRecord, NotificationHistory } from "../notification-history.js";

export const NotificationHistoryContext = createContext<NotificationHistory | null>(null);

/** Register only a visible banner occurrence; callback refreshes must not resurrect cleared history. */
export function useBannerNotice(id: string, notice: NoticeInput | null) {
  const history = useContext(NotificationHistoryContext);
  const latest = useRef(notice);
  latest.current = notice;
  const registered = useRef<string | null>(null);
  const suspended = useRef<{ history: NotificationHistory; id: string; records: readonly NoticeRecord[] } | null>(null);
  useEffect(() => {
    latest.current = notice;
    if (!history || !notice) { registered.current = null; suspended.current = null; history?.hideBanner(id); return; }
    const signature = JSON.stringify([id, notice.message, notice.severity]);
    const actions = (notice.actions ?? []).map((action, index) => ({
      key: action.key,
      label: action.label,
      disabled: action.disabled,
      run: () => { const current = latest.current?.actions?.[index]; if (registered.current === signature && current && (current.key ?? current.label) === (action.key ?? action.label) && !current.disabled) current.run(); },
    }));
    if (registered.current !== signature) {
      history.upsertBanner(id, { ...notice, actions });
      registered.current = signature;
    } else {
      if (suspended.current?.history === history && suspended.current.id === id) history.restoreBanner(id, suspended.current.records);
      history.updateActions(id, actions);
    }
    suspended.current = null;
  }, [history, id, notice]);
  useEffect(() => () => {
    latest.current = null;
    const records = history?.getSnapshot();
    suspended.current = history && records?.some((item) => item.id === id) ? { history, id, records } : null;
    history?.hideBanner(id);
  }, [history, id]);
  return history !== null && notice !== null;
}
