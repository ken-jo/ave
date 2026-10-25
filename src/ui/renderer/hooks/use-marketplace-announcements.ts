import { useCallback, useEffect, useRef, useState } from "react";
import { isIpcErrorResult, type AveApi } from "../types.js";
import {
  normalizeDismissedAnnouncementIds,
  type MarketplaceAnnouncement,
} from "../../../shared/marketplace-announcements.js";

export type { MarketplaceAnnouncement } from "../../../shared/marketplace-announcements.js";

/** Dismiss locally immediately, then merge persisted ids because settings updates replace the whole array. */
export function useMarketplaceAnnouncements(api: AveApi) {
  const [announcements, setAnnouncements] = useState<MarketplaceAnnouncement[]>(
    [],
  );
  const dismissedIdsRef = useRef(new Set<number>());
  const dismissWriteRef = useRef(Promise.resolve());

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onMarketplaceAnnouncements((incoming) => {
      if (!alive) return;
      setAnnouncements(
        incoming.filter((announcement) =>
          !dismissedIdsRef.current.has(announcement.id),
        ),
      );
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const dismiss = useCallback(
    async (id: number) => {
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
      dismissedIdsRef.current.add(id);
      const nextWrite = dismissWriteRef.current.catch(() => {}).then(async () => {
        const settings = await api.getSettings();
        const existingDismissedIds = normalizeDismissedAnnouncementIds(
          settings.marketplace?.dismissedAnnouncementIds,
        );
        const nextDismissedIds = normalizeDismissedAnnouncementIds([
          ...existingDismissedIds,
          ...dismissedIdsRef.current,
        ]);
        if (
          nextDismissedIds.length === existingDismissedIds.length &&
          nextDismissedIds.every((dismissedId, index) =>
            dismissedId === existingDismissedIds[index],
          )
        ) {
          return;
        }
        const updateResult = await api.updateSettings({
          marketplace: { dismissedAnnouncementIds: nextDismissedIds },
        });
        if (isIpcErrorResult(updateResult)) {
          throw new Error(updateResult.message ?? updateResult.error);
        }
      });
      dismissWriteRef.current = nextWrite.catch(() => {});
      await nextWrite;
    },
    [api],
  );

  return { announcements, dismiss };
}
