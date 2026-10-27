import { useSandboxCapability } from "./use-sandbox-capability.js";
import { useEffect, useState } from "react";
import type { SandboxCapabilityInfo } from "../../../shared/sandbox-capability-info.js";
import type { AveApi } from "../types.js";
import { shortVendorLabel } from "./status-bar/vendor-label.js";
import { t } from "../../../i18n/runtime.js";
import {
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
} from "../../../shared/subscription-runtime.js";
import { normalizeExecutionMode, type ExecutionModeDisplay } from "../../../shared/permission-mode.js";
import { apiModelBillingRoute, modelBillingApiAddress, type ModelBillingRoute } from "../utils/model-billing.js";
import type { ActiveChatModel } from "../../../shared/active-chat-model.js";

/** Resolve composer model and permission status from settings and permission subscriptions; missing-model alerts belong to the sidebar.
 * Depend only on stable API references and store primitives so repeated resolutions cannot create render loops. */
export interface InputStatusRow {
  /** "OpenAI · gpt-5.4" style label (vendor · model), or vendor alone. */
  vendorModel: string;
  /** Main's answer to which model chat is on; null until the first settings snapshot lands. `kind:
   * "none"` means there is no model to name, and the row offers provider setup instead of a label. */
  activeChatModel: ActiveChatModel | null;
  billingRoute?: ModelBillingRoute;
  /** Permission policy mode for per-mode text color + label. */
  permissionMode: ExecutionModeDisplay;
  /** Pending deferred-approval count (appended to the permission cell). */
  pendingApprovals: number;
  /** Host-issued shell execution status, independent of the desired setting. */
  sandboxCapability?: SandboxCapabilityInfo | null;
  sandboxStatusQueryFailed?: boolean;
  refreshSandboxStatus?: () => void;
}

export function useInputStatusRow(api: AveApi): InputStatusRow {
  const [vendorModel, setVendorModel] = useState("");
  const [activeChatModel, setActiveChatModel] = useState<ActiveChatModel | null>(null);
  const [billingRoute, setBillingRoute] = useState<ModelBillingRoute>();
  const [permissionMode, setPermissionMode] = useState<ExecutionModeDisplay>("unknown");
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const { capability: sandboxCapability, statusQueryFailed: sandboxStatusQueryFailed, refresh: refreshSandboxStatus } =
    useSandboxCapability(api.permission, api.onSettingsUpdated);

  // Vendor + model; mirrors use-status-bar-vendor.
  useEffect(() => {
    if (typeof api.getSettings !== "function") return;
    let cancelled = false;
    let billingEpoch = 0;

    const apply = (settings: Awaited<ReturnType<AveApi["getSettings"]>>) => {
      if (cancelled) return;
      const epoch = ++billingEpoch;
      const active = settings.activeChatModel;
      setBillingRoute(active.kind === "subscription" ? { kind: "subscription", provider: active.provider } : undefined);
      if (active.kind === "api") {
        const address = modelBillingApiAddress(settings, active.vendor, active.marketplaceProviderPresetId);
        if (address.requiresApiKey) setBillingRoute(apiModelBillingRoute(active.vendor, true, false));
        if (typeof api.hasApiKey === "function") {
          void api.hasApiKey(address.credentialId).then((keyConfigured) => {
            if (!cancelled && epoch === billingEpoch) {
              setBillingRoute(apiModelBillingRoute(active.vendor, address.requiresApiKey, keyConfigured));
            }
          }).catch(() => { /* An optional route without a verified key makes no billing claim. */ });
        }
      }
      setActiveChatModel((current) =>
        JSON.stringify(current) === JSON.stringify(settings.activeChatModel) ? current : settings.activeChatModel);
      // No connected provider: the vendor block still carries its default id, but nothing was chosen and nothing could answer, so nothing is named.
      if (settings.activeChatModel.kind === "none" && settings.activeChatModel.reason === "no-connected-provider") {
        setVendorModel("");
        return;
      }
      const activeRuntime = settings.llm?.activeChatRuntime;
      if (activeRuntime?.kind === "subscription" && isSubscriptionRuntimeId(activeRuntime.provider)) {
        const model = typeof activeRuntime.model === "string" ? activeRuntime.model.trim() : "";
        const descriptor = subscriptionRuntimeDescriptor(activeRuntime.provider);
        // A CLI with no chosen model runs its own default; say so rather than name a model Ave did not pick.
        const unchosen = descriptor.offersCliDefaultModel ? `${descriptor.planName} · ${t("llmTab.cliDefaultModel")}` : descriptor.planName;
        setVendorModel(model.length > 0 ? `${descriptor.planName} · ${model}` : unchosen);
        return;
      }
      const provider = settings.llm?.provider ?? "";
      const model = settings.llm?.vendors?.[provider]?.model ?? "";
      const vendorLabel = shortVendorLabel(provider);
      setVendorModel(model.length > 0 ? `${vendorLabel} · ${model}` : vendorLabel);
    };

    void api.getSettings().then(apply).catch(() => {
      // Awareness-only; leave the prior value on transient read failure.
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

  // Permission mode + pending approvals; mirrors use-status-bar-permission.
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

  return { vendorModel, activeChatModel, billingRoute, permissionMode, pendingApprovals, sandboxCapability, sandboxStatusQueryFailed, refreshSandboxStatus };
}
