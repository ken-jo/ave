import { useCallback, useEffect, useRef, useState } from "react";
import type { PackageUpdateView } from "../../../shared/git-marketplace.js";
import { isIpcErrorResult, type AveApi } from "../types.js";
import {
  createSkippedPluginUpdateMap,
  isSkippedPackageUpdate,
  packageUpdateSkipKey,
  putSkippedPluginUpdate,
  readSkippedPluginUpdates,
  type SkippedPluginUpdateMap,
} from "../../../shared/skipped-plugin-updates.js";

/** The installed packages with updates, as main last published them, minus the ones the user skipped. */
export function useMarketplaceUpdates(api: AveApi) {
  const [updates, setUpdates] = useState<PackageUpdateView[]>([]);
  const updatesRef = useRef<PackageUpdateView[]>([]);
  const skippedUpdatesRef = useRef<SkippedPluginUpdateMap>(createSkippedPluginUpdateMap());
  const skipWriteRef = useRef(Promise.resolve());

  const replaceUpdates = useCallback((next: PackageUpdateView[]) => {
    updatesRef.current = next;
    setUpdates(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        skippedUpdatesRef.current = readSkippedPluginUpdates(
          settings.marketplace?.skippedPluginUpdates,
        );
        replaceUpdates(filterSkippedUpdates(updatesRef.current, skippedUpdatesRef.current));
      })
      .catch(() => {
        /* Host already filters persisted skips; settings fetch is a renderer-side fast path. */
      });
    const unsubscribe = api.onMarketplaceUpdatesAvailable((incoming) => {
      if (alive) replaceUpdates(filterSkippedUpdates(incoming, skippedUpdatesRef.current));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api, replaceUpdates]);

  const skip = useCallback(async () => {
    const visibleUpdates = updatesRef.current;
    if (visibleUpdates.length === 0) return;

    const nextWrite = skipWriteRef.current.catch(() => {}).then(async () => {
      try {
        const settings = await api.getSettings();
        const existingSkipped = readSkippedPluginUpdates(
          settings.marketplace?.skippedPluginUpdates,
        );
        // `readSkippedPluginUpdates` is idempotent, so re-reading an already
        // normalized map is exactly the copy this needs — `existingSkipped`
        // must stay untouched for the no-change comparison below.
        const nextSkipped = readSkippedPluginUpdates(existingSkipped);
        for (const update of visibleUpdates) {
          putSkippedPluginUpdate(nextSkipped, packageUpdateSkipKey(update.key), update.to);
        }
        if (sameSkippedPluginUpdates(existingSkipped, nextSkipped)) {
          skippedUpdatesRef.current = nextSkipped;
          replaceUpdates(filterSkippedUpdates(updatesRef.current, nextSkipped));
          return;
        }
        const updateResult = await api.updateSettings({
          marketplace: { skippedPluginUpdates: nextSkipped },
        });
        if (isIpcErrorResult(updateResult)) {
          return;
        }
        skippedUpdatesRef.current = nextSkipped;
        replaceUpdates(filterSkippedUpdates(updatesRef.current, nextSkipped));
      } catch {
        /* Skip persistence failure should not reject or create a renderer-only skip SOT. */
      }
    });
    skipWriteRef.current = nextWrite;
    await nextWrite;
  }, [api, replaceUpdates]);

  return { updates, skip };
}

function filterSkippedUpdates(
  updates: PackageUpdateView[],
  skipped: SkippedPluginUpdateMap,
): PackageUpdateView[] {
  return updates.filter((update) => !isSkippedPackageUpdate(update, skipped));
}

function sameSkippedPluginUpdates(
  left: SkippedPluginUpdateMap,
  right: SkippedPluginUpdateMap,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
