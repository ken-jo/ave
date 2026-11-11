/** Wire reviewer policy, permission broadcasts, and integrity reporting; retain rewireReviewerAgent for settings and authentication changes. */
import { sendToWindow } from "../../ipc/safe-send.js";
import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { createSystemSubagentProviderPlan } from "../../engine/system-subagent-route.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import type { SystemSubagentRouteIdentity } from "../../shared/system-subagent-model.js";
import {
  getLlmVendorSettings,
  llmRouteModel,
} from "../../shared/llm-vendor-defaults.js";
import { wireReviewerAgent } from "./reviewer-wiring.js";
import { readJudgeSettings, readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { formatJudgeModel, type JudgeModelRef } from "../../permissions/judge/judge-settings.js";
import { judgeModelCatalogFrom } from "../../permissions/judge/judge-model-catalog.js";
import { wireJudgeAgent } from "./judge-wiring.js";
import {
  bindManifestIntegrityAudit,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import { createRecentlyDeniedReplayResolver } from "../../permissions/reviewer/recently-denied-replay.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("ave");

export async function wireReviewerAndPermissions(ctx: BootContext): Promise<void> {
  const {
    toolRegistry,
    permissionManager,
    settingsService,
    llmFetch,
    singleHopNetworkFetch,
    getMainWindow,
    bootAuditLogger,
    subscriptionProviderFactory,
  } = ctx;

  const applyOwnerAwayAutoSkip = () => ctx.approvalGate.setOwnerAwayAutoSkipMinutes(
    settingsService.get("permissions")?.ownerAwayAutoSkipMinutes ?? 0,
  );
  applyOwnerAwayAutoSkip();
  settingsService.onChanged("permissions", applyOwnerAwayAutoSkip);

  // Apply visibility deny rules after the registry exists; permission services must already exist for plugin construction.
  toolRegistry.setDenyRules(permissionManager.getVisibilityDenyRules());

  // Bind the classifier, verdict cache, and denial history; streaming providers are adapted to one-shot review calls.
  // Secrets decrypt asynchronously while reviewer wiring is synchronous, so a plan names the credential to pre-read.
  const reviewerProviderPlan = (vendor: string, selectedModel?: string, route?: SystemSubagentRouteIdentity) => createSystemSubagentProviderPlan({
    settingsService, llmFetch, networkFetch: singleHopNetworkFetch, subscriptionProviderFactory,
  }, vendor, selectedModel, route);
  const readReviewerSecrets = async (
    targets: ReadonlyArray<{ vendor: string; model?: string; route?: SystemSubagentRouteIdentity }>,
  ): Promise<Map<string, string | null>> => {
    const secrets = new Map<string, string | null>();
    for (const { vendor, model, route } of targets) {
      const secretKey = reviewerProviderPlan(vendor, model, route)?.secretKey;
      if (secretKey !== undefined && !secrets.has(secretKey)) {
        secrets.set(secretKey, await settingsService.getSecret(secretKey));
      }
    }
    return secrets;
  };
  const reviewerStreamProviderFor = (
    secrets: ReadonlyMap<string, string | null>,
    vendor: string,
    selectedModel?: string,
    route?: SystemSubagentRouteIdentity,
  ): LLMProvider | null => {
    const plan = reviewerProviderPlan(vendor, selectedModel, route);
    if (!plan) return null;
    if (plan.secretKey === undefined) return plan.build(null);
    // A credential not pre-read means settings changed mid-rewire; stay unconfigured until the queued rewire runs.
    return secrets.has(plan.secretKey) ? plan.build(secrets.get(plan.secretKey) ?? null) : null;
  };
  const readActiveReviewerLlm = () => {
    const llm = settingsService.get("llm");
    const activeChatRuntime = llm.activeChatRuntime;
    if (activeChatRuntime?.kind === "subscription") {
      return {
        provider: `subscription:${activeChatRuntime.provider}` as `subscription:${typeof activeChatRuntime.provider}`,
        model: activeChatRuntime.model ?? "default",
      };
    }
    const provider = llm.provider;
    const block = getLlmVendorSettings(llm.vendors, provider);
    const activeMarketplaceProviderPreset =
      provider === "openai-compatible" && llm.marketplaceProviderPresetId
        ? (settingsService.get("marketplace").installedProviderPresets ?? [])
          .find((preset) => preset.providerId === llm.marketplaceProviderPresetId)
        : undefined;
    const providerBaseUrl = activeMarketplaceProviderPreset?.baseUrl ?? block.baseUrl;
    return {
      provider,
      ...(provider === "openai-compatible" && llm.marketplaceProviderPresetId
        ? { marketplaceProviderPresetId: llm.marketplaceProviderPresetId }
        : {}),
      model: llmRouteModel(block, activeMarketplaceProviderPreset?.providerId),
      ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    };
  };
  const selectedReviewerIdentity = (model: JudgeModelRef) => {
    const scope = selectedModelCacheScope(model);
    return {
      provider: model.vendor,
      model: model.model,
      ...(typeof scope.marketplaceProviderPresetId === "string"
        ? { marketplaceProviderPresetId: scope.marketplaceProviderPresetId } : {}),
      ...(typeof scope.baseUrl === "string" ? { baseUrl: scope.baseUrl } : {}),
      ...(typeof scope.vertexProject === "string" ? { vertexProject: scope.vertexProject } : {}),
      ...(typeof scope.vertexLocation === "string" ? { vertexLocation: scope.vertexLocation } : {}),
    };
  };
  const selectedModelCacheScope = (model: JudgeModelRef): Record<string, unknown> => {
    const route = model.route;
    const preset = route?.marketplaceProviderPresetId
      ? (settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((entry) => entry.providerId === route.marketplaceProviderPresetId)
      : undefined;
    return {
      provider: model.vendor,
      model: model.model,
      ...route,
      baseUrl: route?.baseUrl ?? null,
      credentialScope: route?.credentialScope ?? null,
      ...(preset ? {
        marketplaceProviderPresetId: preset.providerId,
        providerCapabilities: preset.capabilities ?? null,
        providerTrust: preset.trust ?? null,
        requiresApiKey: preset.requiresApiKey,
      } : {}),
      ...(model.vendor === "vertex-ai" ? {
        vertexProject: route?.vertexProject ?? null,
        vertexLocation: route?.vertexLocation ?? null,
      } : {}),
    };
  };
  const rewireReviewerAgentNow = async (): Promise<void> => {
    const reconfiguration = permissionManager.beginReviewerReconfiguration();
    // Reapply the read fence on every settings rewire; its generation invalidates verdicts from the prior policy.
    permissionManager.setBlockReadsOutsideWorkingDirectories(
      readPermissionSettings().permissions.blockReadsOutsideWorkingDirectories,
    );
    const judgeSettings = readJudgeSettings(
      undefined,
      judgeModelCatalogFrom({
        ...settingsService.get("llm"),
        installedProviderPresets: settingsService.get("marketplace").installedProviderPresets ?? [],
      }),
    );
    for (const issue of judgeSettings.issues) {
      log.warn({ issue }, "Permission judge configuration warning");
    }
    // An unset reviewer model follows chat; resolve again whenever settings change.
    const selectedReviewerModel = judgeSettings.settings.model;
    const reviewerModelSelection = judgeSettings.modelRejected === true
      ? { label: "configured in Settings", available: false }
      : selectedReviewerModel
        ? { label: formatJudgeModel(selectedReviewerModel), available: Boolean(reviewerProviderPlan(
          selectedReviewerModel.vendor, selectedReviewerModel.model, selectedReviewerModel.route,
        )) }
        : undefined;
    const secrets = await readReviewerSecrets([
      selectedReviewerModel
        ? selectedReviewerModel
        : { vendor: readActiveReviewerLlm().provider },
      ...judgeSettings.settings.chain.flatMap((stage) => stage.model
        ? [stage.model]
        : []),
    ]);
    const reviewerResult = wireReviewerAgent({
      permissionManager,
      networkFetch: singleHopNetworkFetch,
      readActiveLlm: selectedReviewerModel
        ? () => selectedReviewerIdentity(selectedReviewerModel)
        : readActiveReviewerLlm,
      streamProviderFor: selectedReviewerModel
        ? (vendor) => reviewerStreamProviderFor(secrets, vendor, selectedReviewerModel.model, selectedReviewerModel.route)
        : (vendor) => reviewerStreamProviderFor(secrets, vendor),
      ...(reviewerModelSelection ? { selectedModel: reviewerModelSelection } : {}),
      onRecentlyDeniedChanged: (summary) => {
        for (const window of ctx.host.desktop?.getAppWindows() ?? [getMainWindow()]) {
          sendToWindow(window, PERMISSIONS.recentlyDeniedChanged, summary, log);
        }
      },
    });
    reviewerResult.recentlyDenied.setReplayResolver(createRecentlyDeniedReplayResolver({
      memoryManager: ctx.memoryManager, toolRegistry,
      executeAll: (...args) => ctx.conversationLoop.toolExecutor.executeAll(...args),
    }));
    wireJudgeAgent({
      permissionManager,
      reviewer: reviewerResult,
      settings: judgeSettings.settings,
      ...(judgeSettings.chainRejected === true ? { chainRejected: true } : {}),
      ...(judgeSettings.unreadable === true ? { settingsUnreadable: true } : {}),
      providerForModel: (model) => reviewerStreamProviderFor(secrets, model.vendor, model.model, model.route),
      selectedModelCacheScope,
      networkFetch: singleHopNetworkFetch,
      audit: bootAuditLogger,
      resolveRootSessionId: ctx.resolveRootSessionId,
    });
    ctx.rationaleScopeReviewer = reviewerResult.rationaleScopeReviewer;
    ctx.approvalSentenceSelector = reviewerResult.approvalSentenceSelector;
    // Broadcast configuration changes after rewiring so open settings views stop showing stale degradation.
    broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []);
    permissionManager.completeReviewerReconfiguration(reconfiguration);
  };
  // Serialized: an overlapping rewire would replace the reconfiguration token the earlier one must complete with.
  let rewireQueue: Promise<void> = Promise.resolve();
  const rewireReviewerAgent = (): Promise<void> => {
    const run = rewireQueue.then(rewireReviewerAgentNow);
    rewireQueue = run.catch(() => undefined);
    return run;
  };
  await rewireReviewerAgent();

  // Install one stable memory-hit broadcaster that resolves the current main window.
  permissionManager.setBroadcastUserApprovalHit((payload) => {
    sendToWindow(getMainWindow(), PERMISSIONS.userApprovalHit, payload, log);
  });

  // Broadcast rule changes at the manager chokepoint so dialog, slash, and IPC mutations all reach every window.
  permissionManager.setBroadcastConfigChanged(() => {
    broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []);
  });

  // Audit integrity violations and notify through the live window getter so reloads do not strand events.
  bindManifestIntegrityAudit(bootAuditLogger);
  manifestIntegrityState.onViolation((pluginId, toolName, attempted) => {
    try {
      getMainWindow()?.webContents.send(PERMISSIONS.manifestViolation, {
        pluginId,
        toolName,
        attempted,
      });
    } catch (err) {
      log.warn(
        "manifest-violation IPC emit failed (non-fatal): %s",
        errorMessage(err),
      );
    }
  });

  ctx.rewireReviewerAgent = rewireReviewerAgent;
}
