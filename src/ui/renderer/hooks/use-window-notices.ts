import { useEffect, useState, useSyncExternalStore } from "react";
import type { AveApi } from "../types.js";
import { createNotificationHistory } from "../notification-history.js";
import { useStatusBarNotifications } from "./status-bar/use-status-bar-notifications.js";
import { useStatusBarInstall } from "./status-bar/use-status-bar-install.js";

export function useWindowNotices(api: AveApi) {
  const [history] = useState(createNotificationHistory);
  const records = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const latestNotice = history.getLatest();
  useEffect(() => {
    if (latestNotice?.announcementId !== undefined) history.acknowledgeAnnouncements(latestNotice.announcementId);
  }, [history, latestNotice]);
  useStatusBarNotifications({ api, receiveToast: history.receive });
  useStatusBarInstall({ api, pushToast: history.push, upsertToast: history.upsert });
  return { history, records, latestNotice, latestPolite: history.getLatestPolite(), latestError: history.getLatestError(), pushToast: history.push, upsertToast: history.upsert };
}
