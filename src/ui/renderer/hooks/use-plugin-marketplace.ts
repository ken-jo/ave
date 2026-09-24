import { useCallback, useState } from "react";
import type { AveApi, PluginCardSummary, PluginUiExtension } from "../types.js";

/**
 * Phase reported by `ave:plugins:install-progress` IPC events. Renderer
 * surfaces (plugin grid placeholder + settings tab skeleton) read this map to
 * render an in-flight indicator while the main process drives the install.
 */
export type InstallPhase = "installing" | "downloading" | "verifying" | "registering" | "restarting" | "preparing";
export type InstallProgressPayload =
  | { slug: string; phase: Exclude<InstallPhase, "downloading"> }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };
export type InstallInFlight = Record<string, InstallProgressPayload>;

/**
 * The installed plugins' sidebar views and manifest cards. Extracted from
 * App.tsx to keep the composition root focused on orchestration; installing
 * and removing packages is the marketplace tab's (design §15).
 */
export function usePluginMarketplace(api: AveApi) {
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  // Plugin manifest summaries — needed alongside the slot-bound view list so
  // surfaces (plugin grid, settings tab, etc.) can read manifest-level
  // metadata like `auth` without going through their own card fetch.
  const [pluginCards, setPluginCards] = useState<PluginCardSummary[]>([]);

  const refreshViews = useCallback(async () => {
    const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar");
    setPluginViews(v);
    return v;
  }, [api]);

  const refreshCards = useCallback(async () => {
    try {
      const cards = await api.listPluginCards();
      setPluginCards(cards);
      return cards;
    } catch {
      // Card load is best-effort — surfaces that depend on it (auth badge)
      // simply skip rendering until next refresh tick.
      return [];
    }
  }, [api]);

  return { pluginViews, pluginCards, refreshViews, refreshCards };
}
