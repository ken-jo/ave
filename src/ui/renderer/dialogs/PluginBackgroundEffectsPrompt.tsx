import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import {
  PluginBackgroundEffectsDialog,
  type PluginBackgroundEffectsReview,
  PluginBackgroundEffectsUpgradeDialog,
  type PluginBackgroundEffectsUpgradeRow,
} from "./PluginBackgroundEffectsDialog.js";

const REVIEW_EVENT = "ave:plugin-background-effects:review";
const ANSWERED_EVENT = "ave:plugin-background-effects:answered";

/** Opens the card for a running plugin, even one dismissed earlier in this session. */
export function requestPluginBackgroundEffectsReview(pluginId: string): void {
  window.dispatchEvent(new CustomEvent(REVIEW_EVENT, { detail: pluginId }));
}

/** Calls back when a plugin's card closes, so a Review row can re-read whether it is still pending. */
export function onPluginBackgroundEffectsAnswered(listener: (pluginId: string) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(ANSWERED_EVENT, handle);
  return () => window.removeEventListener(ANSWERED_EVENT, handle);
}

/**
 * The one owner of the background effects card. It asks when a plugin starts running with a declared scope that is not
 * approved (install, update, enable), one card at a time. A dismissed review is not asked again this session until the
 * plugin is enabled or reinstalled, or its Review row asks. Boot starts installed plugins with no such event, so the first
 * interactive launch first shows one card listing every unapproved plugin, and holds the per-plugin cards until it closes.
 */
export function PluginBackgroundEffectsPrompt() {
  const { t } = useTranslation();
  const [review, setReview] = useState<PluginBackgroundEffectsReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Plugin id -> whether the Review row asked; a request for a plugin already queued only widens to explicit.
  const queue = useRef(new Map<string, boolean>());
  const dismissed = useRef(new Map<string, string>());
  const current = useRef<{ pluginId: string; review: PluginBackgroundEffectsReview | null } | null>(null);
  const deciding = useRef(false);
  const [upgrade, setUpgrade] = useState<readonly PluginBackgroundEffectsUpgradeRow[] | null>(null);
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const holding = useRef(false);
  const upgradeRows = useRef<readonly PluginBackgroundEffectsUpgradeRow[] | null>(null);
  const allowedRows = useRef(new Set<string>());

  const pump = useCallback(async (): Promise<void> => {
    if (current.current || holding.current) return;
    const next = queue.current.entries().next();
    if (next.done) return;
    const [pluginId, explicit] = next.value;
    queue.current.delete(pluginId);
    current.current = { pluginId, review: null };
    try {
      const result = await getApi().getPluginBackgroundEffects(pluginId);
      if (result.ok && result.reviewSha256 && !result.approved && (explicit || dismissed.current.get(pluginId) !== result.reviewSha256)) {
        const shown = { pluginId, name: result.name, reviewSha256: result.reviewSha256, effects: result.effects };
        current.current = { pluginId, review: shown };
        // The open card answers a queued Review request; an automatic one still re-reads afterwards.
        if (queue.current.get(pluginId)) queue.current.set(pluginId, false);
        setReview(shown);
        return;
      }
    } catch {
      // The host denies unapproved background effects, so a failed read only skips the card.
    }
    current.current = null;
    void pump();
  }, []);

  const enqueue = useCallback((pluginId: string, explicit: boolean) => {
    if (explicit && current.current?.review?.pluginId === pluginId) return;
    queue.current.set(pluginId, explicit || queue.current.get(pluginId) === true);
    void pump();
  }, [pump]);

  const close = useCallback((pluginId: string) => {
    current.current = null;
    setReview(null);
    setError(null);
    window.dispatchEvent(new CustomEvent(ANSWERED_EVENT, { detail: pluginId }));
    void pump();
  }, [pump]);

  const decide = useCallback(async (allowed: boolean) => {
    const shown = current.current?.review;
    if (!shown || deciding.current) return;
    if (!allowed) {
      dismissed.current.set(shown.pluginId, shown.reviewSha256);
      close(shown.pluginId);
      return;
    }
    deciding.current = true;
    try {
      const approval = await getApi().approvePluginBackgroundEffects({ pluginId: shown.pluginId, reviewSha256: shown.reviewSha256 });
      if (!approval.ok && approval.error === "background-effects-review-stale") queue.current.set(shown.pluginId, true);
      if (approval.ok || approval.error === "background-effects-review-stale" || approval.error === "background-effects-unavailable"
        || approval.error === "no-such-plugin") {
        close(shown.pluginId);
        return;
      }
      setError(t("pluginConfigTab.backgroundEffectsError"));
    } catch (caught) {
      setError((caught instanceof Error && caught.message) || t("pluginConfigTab.backgroundEffectsError"));
    } finally {
      deciding.current = false;
    }
  }, [close, t]);

  // Later leaves every review it listed to its Review row; the host then shows no first-launch card again.
  const finishUpgrade = useCallback(() => {
    const rows = upgradeRows.current ?? [];
    upgradeRows.current = null;
    for (const row of rows) {
      if (row.reviewSha256 !== null && !allowedRows.current.has(row.pluginId)) dismissed.current.set(row.pluginId, row.reviewSha256);
    }
    holding.current = false;
    setUpgrade(null);
    setUpgradeError(null);
    try {
      void Promise.resolve(getApi().finishPluginBackgroundEffectsUpgrade()).catch(() => undefined);
    } catch {
      // Unanswered, the next launch shows the card again.
    }
    for (const row of rows) window.dispatchEvent(new CustomEvent(ANSWERED_EVENT, { detail: row.pluginId }));
    void pump();
  }, [pump]);

  const allowUpgrade = useCallback(async (row: PluginBackgroundEffectsUpgradeRow) => {
    if (deciding.current || row.reviewSha256 === null) return;
    deciding.current = true;
    try {
      const approval = await getApi().approvePluginBackgroundEffects({ pluginId: row.pluginId, reviewSha256: row.reviewSha256 });
      if (approval.ok) {
        allowedRows.current.add(row.pluginId);
        setAllowed(new Set(allowedRows.current));
        window.dispatchEvent(new CustomEvent(ANSWERED_EVENT, { detail: row.pluginId }));
      } else if (approval.error === "background-effects-review-stale" || approval.error === "background-effects-unavailable"
        || approval.error === "no-such-plugin") {
        // A review that changed since boot gets its own card once this one closes.
        if (approval.error === "background-effects-review-stale") queue.current.set(row.pluginId, true);
        upgradeRows.current = upgradeRows.current?.filter((candidate) => candidate.pluginId !== row.pluginId) ?? null;
        setUpgrade(upgradeRows.current);
      } else {
        setUpgradeError(t("pluginConfigTab.backgroundEffectsError"));
        return;
      }
      setUpgradeError(null);
      if (upgradeRows.current?.every((candidate) => allowedRows.current.has(candidate.pluginId))) finishUpgrade();
    } catch (caught) {
      setUpgradeError((caught instanceof Error && caught.message) || t("pluginConfigTab.backgroundEffectsError"));
    } finally {
      deciding.current = false;
    }
  }, [finishUpgrade, t]);

  useEffect(() => {
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      return;
    }
    if (typeof api.getPluginBackgroundEffectsUpgrade !== "function") return;
    let cancelled = false;
    // Taken before any runtime event can queue a per-plugin card.
    holding.current = true;
    const release = () => {
      holding.current = false;
      void pump();
    };
    Promise.resolve().then(() => api.getPluginBackgroundEffectsUpgrade()).then((result) => {
      if (cancelled) return;
      if (result?.ok && result.reviews.length > 0) {
        upgradeRows.current = result.reviews;
        setUpgrade(result.reviews);
        return;
      }
      if (result?.ok) void Promise.resolve().then(() => api.finishPluginBackgroundEffectsUpgrade()).catch(() => undefined);
      release();
    }, () => {
      if (!cancelled) release();
    });
    return () => { cancelled = true; };
  }, [pump]);

  useEffect(() => {
    const onReview = (event: Event) => enqueue((event as CustomEvent<string>).detail, true);
    window.addEventListener(REVIEW_EVENT, onReview);
    const unsubs = [() => window.removeEventListener(REVIEW_EVENT, onReview)];
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      return () => { for (const unsubscribe of unsubs) unsubscribe(); };
    }
    // Every install, update, restart and enable publishes the running generation before this event, with its subject bound.
    if (typeof api.onPluginRuntimeUpdated === "function") {
      unsubs.push(api.onPluginRuntimeUpdated(({ pluginId }) => enqueue(pluginId, false)));
    }
    if (typeof api.onPluginEnabledChanged === "function") {
      unsubs.push(api.onPluginEnabledChanged(({ pluginId, enabled }) => {
        if (!enabled) return;
        dismissed.current.delete(pluginId);
        enqueue(pluginId, false);
      }));
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(api.onPluginUninstallResult(({ slug, success }) => {
        if (success) dismissed.current.delete(slug);
      }));
    }
    return () => { for (const unsubscribe of unsubs) unsubscribe(); };
  }, [enqueue]);

  return (
    <>
      <PluginBackgroundEffectsUpgradeDialog
        rows={upgrade}
        allowed={allowed}
        error={upgradeError}
        onAllow={(row) => void allowUpgrade(row)}
        onLater={finishUpgrade}
      />
      <PluginBackgroundEffectsDialog review={review} error={error} onDecide={(answer) => void decide(answer)} />
    </>
  );
}
