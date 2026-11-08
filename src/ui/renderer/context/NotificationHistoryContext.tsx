import { createContext, useContext, useEffect, useRef } from "react";
import type { NoticeInput, NotificationHistory } from "../notification-history.js";

export const NotificationHistoryContext = createContext<NotificationHistory | null>(null);

/** Register only a visible banner occurrence; callback refreshes must not resurrect cleared history. */
export function useBannerNotice(id: string, notice: NoticeInput | null) {
  const history = useContext(NotificationHistoryContext);
  const latest = useRef(notice);
  latest.current = notice;
  const registered = useRef<string | null>(null);
  useEffect(() => {
    latest.current = notice;
    if (!history || !notice) { registered.current = null; history?.updateActions(id, []); return; }
    const signature = JSON.stringify([id, notice.message, notice.severity]);
    const actions = (notice.actions ?? []).map((action, index) => ({
      key: action.key,
      label: action.label,
      disabled: action.disabled,
      run: () => { const current = latest.current?.actions?.[index]; if (registered.current === signature && current && (current.key ?? current.label) === (action.key ?? action.label) && !current.disabled) current.run(); },
    }));
    if (registered.current !== signature) {
      history.upsert(id, { ...notice, source: "banner", actions });
      registered.current = signature;
    } else history.updateActions(id, actions);
  }, [history, id, notice]);
  useEffect(() => () => { latest.current = null; history?.updateActions(id, []); }, [history, id]);
  return history !== null && notice !== null;
}
