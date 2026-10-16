import { useEffect, useState } from "react";
import type { AveApi } from "../types.js";
import { shortVendorLabel } from "./status-bar/vendor-label.js";
import { t } from "../../../i18n/runtime.js";
import {
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
} from "../../../shared/subscription-runtime.js";
import { normalizeExecutionMode, type ExecutionModeDisplay } from "../../../shared/permission-mode.js";
import type { ActiveChatModel } from "../../../shared/active-chat-model.js";

/**
 * In-bar status sub-row data.
 *
 * The persistent model / permission cells that used to live in the window
 * StatusBar now render as a compact single line at the bottom of the unified
 * InputActionBar (the window StatusBar is notifications-only). This hook
 * resolves those fields from the same IPC the old StatusBar producers used —
 * `getSettings()` (+ `onSettingsUpdated`) for vendor/model and
 * `window.ave.permission` (`getMode` + `onModeChanged`) for the policy mode —
 * but returns plain values instead of upserting StatusBar items.
 *
 * Whether a chat model is configured at all is not a row cell any more: the
 * shell derives it from its own settings store (`useSettings` in App) and the
 * sidebar's Settings entry carries the alert when it is missing.
 *
 * Render-loop guard (the #1312 lesson): the effects depend only on the stable
 * `api` reference, never on caller-built closures. The subscription callbacks
 * mutate local `useState` with primitive values, so an identical re-resolve
 * settles to the same state and React bails out — no upsert→new-array→re-render
 * cycle is possible here.
 */
export interface InputStatusRow {
  /** "OpenAI · gpt-5.4" style label (vendor · model), or vendor alone. */
  vendorModel: string;
  /**
   * Main's answer to which model chat is on; null until the first settings
   * snapshot lands. `kind: "none"` means there is no model to name, and the
   * row offers provider setup instead of a label.
   */
  activeChatModel: ActiveChatModel | null;
  /** Permission policy mode for per-mode text color + label. */
  permissionMode: ExecutionModeDisplay;
  /** Pending deferred-approval count (appended to the permission cell). */
  pendingApprovals: number;
}

export function useInputStatusRow(api: AveApi): InputStatusRow {
  const [vendorModel, setVendorModel] = useState("");
  const [activeChatModel, setActiveChatModel] = useState<ActiveChatModel | null>(null);
  const [permissionMode, setPermissionMode] = useState<ExecutionModeDisplay>("unknown");
  const [pendingApprovals, setPendingApprovals] = useState(0);

  // Vendor + model — mirrors use-status-bar-vendor.
  useEffect(() => {
    if (typeof api.getSettings !== "function") return;
    let cancelled = false;

    const apply = (settings: Awaited<ReturnType<AveApi["getSettings"]>>) => {
      if (cancelled) return;
      setActiveChatModel((current) =>
        JSON.stringify(current) === JSON.stringify(settings.activeChatModel) ? current : settings.activeChatModel);
      // No connected provider: the vendor block still carries its default id,
      // but nothing was chosen and nothing could answer, so nothing is named.
      if (settings.activeChatModel.kind === "none" && settings.activeChatModel.reason === "no-connected-provider") {
        setVendorModel("");
        return;
      }
      const activeRuntime = settings.llm?.activeChatRuntime;
      if (activeRuntime?.kind === "subscription" && isSubscriptionRuntimeId(activeRuntime.provider)) {
        const model = typeof activeRuntime.model === "string" ? activeRuntime.model.trim() : "";
        const descriptor = subscriptionRuntimeDescriptor(activeRuntime.provider);
        // A CLI with no chosen model runs its own default; say so rather than
        // name a model Ave did not pick.
        const unchosen = descriptor.offersCliDefaultModel ? `${descriptor.label} · ${t("llmTab.cliDefaultModel")}` : descriptor.label;
        setVendorModel(model.length > 0 ? `${descriptor.label} · ${model}` : unchosen);
        return;
      }
      const provider = settings.llm?.provider ?? "";
      const model = settings.llm?.vendors?.[provider]?.model ?? "";
      const vendorLabel = shortVendorLabel(provider);
      setVendorModel(model.length > 0 ? `${vendorLabel} · ${model}` : vendorLabel);
    };

    void api.getSettings().then(apply).catch(() => {
      // Awareness-only — leave the prior value on transient read failure.
    });

    const unsubs: Array<() => void> = [];
    if (typeof api.onSettingsUpdated === "function") {
      unsubs.push(api.onSettingsUpdated((next) => apply(next)));
    }
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api]);

  // Permission mode + pending approvals — mirrors use-status-bar-permission.
  useEffect(() => {
    const perm = api.permission;
    if (!perm) return;
    let cancelled = false;

    void (async () => {
      try {
        const r = await perm.getMode();
        if (!cancelled) setPermissionMode(normalizeExecutionMode(r.mode));
      } catch {
        if (!cancelled) setPermissionMode("unknown");
      }
    })();

    void (async () => {
      try {
        const result = await perm.deferredList?.();
        if (!cancelled && result?.ok) setPendingApprovals(result.pending?.length ?? 0);
      } catch {
        if (!cancelled) setPendingApprovals(0);
      }
    })();

    const unsubs: Array<() => void> = [];
    const offMode = perm.onModeChanged?.((next) => setPermissionMode(normalizeExecutionMode(next)));
    if (offMode) unsubs.push(offMode);
    const offPending = perm.onDeferredPending?.((summary) =>
      setPendingApprovals(Math.max(0, summary.pending)),
    );
    if (offPending) unsubs.push(offPending);

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api]);

  return { vendorModel, activeChatModel, permissionMode, pendingApprovals };
}
