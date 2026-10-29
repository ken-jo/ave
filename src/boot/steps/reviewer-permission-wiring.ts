/** Wire reviewer policy, permission broadcasts, and integrity reporting; retain rewireReviewerAgent for settings and authentication changes. */
import { sendToWindow } from "../../ipc/safe-send.js";
import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { createProvider, secretKeyFor } from "../../engine/llm/provider-factory.js";
import { selectProviderRuntimeFetch } from "../../engine/llm/marketplace-provider-fetch.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  llmRouteModel,
  canUseLlmVendorWithoutApiKey,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
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

export function wireReviewerAndPermissions(ctx: BootContext): void {
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
  const reviewerStreamProviderFor = (vendor: string, selectedModel?: string): LLMProvider | null => {
    const llmSettings = settingsService.get("llm");
    const activeChatRuntime = llmSettings.activeChatRuntime;
    if (selectedModel === undefined && activeChatRuntime?.kind === "subscription") {
      // Include authenticated transport in reviewer cache identity; stale subscription reads must not fall through to an API-key provider.
      if (vendor !== `subscription:${activeChatRuntime.provider}`) return null;
      return subscriptionProviderFactory(activeChatRuntime);
    }

    // An unresolved active provider selection cannot use another host credential.
    if (llmSettings.retiredProvider) return null;

    const llmVendor = isLLMVendor(vendor) ? vendor : null;
    if (!llmVendor) return null;
    const block = getLlmVendorSettings(llmSettings.vendors, llmVendor);
    const hasMarketplaceProviderPresetSelection =
      llmVendor === "openai-compatible" &&
      (selectedModel === undefined || llmSettings.provider === llmVendor) &&
      Boolean(llmSettings.marketplaceProviderPresetId);
    const marketplaceProviderPreset = hasMarketplaceProviderPresetSelection
      ? (settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
      : undefined;
    if (hasMarketplaceProviderPresetSelection && !marketplaceProviderPreset) {
      return null;
    }
    const apiKey = settingsService.getSecret(
      marketplaceProviderPreset
        ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
        : secretKeyFor(llmVendor),
    );
    const effectiveBaseUrl = marketplaceProviderPreset
      ? marketplaceProviderPreset.baseUrl
      : block.baseUrl;
    const isVertex = llmVendor === "vertex-ai";
    const canUseWithoutApiKey = marketplaceProviderPreset
      ? marketplaceProviderPreset.requiresApiKey === false && Boolean(effectiveBaseUrl?.trim())
      : canUseLlmVendorWithoutApiKey(llmVendor, block);
    if (!apiKey && !isVertex && !canUseWithoutApiKey) return null;
    if (
      isVertex &&
      !block.vertexProject &&
      !process.env.GOOGLE_CLOUD_PROJECT &&
      !process.env.GCLOUD_PROJECT
    ) {
      return null;
    }
    const providerFetch = selectProviderRuntimeFetch({
      vendor: llmVendor,
      baseUrl: effectiveBaseUrl,
      providerMetadata: marketplaceProviderPreset,
      llmFetch,
      networkFetch: singleHopNetworkFetch,
    });
    return createProvider({
      vendor: llmVendor,
      apiKey: apiKey ?? "",
      model: selectedModel ?? llmRouteModel(block, marketplaceProviderPreset?.providerId),
      ...(providerFetch ? { fetch: providerFetch } : {}),
      ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
      ...(llmVendor === "openai-compatible" && !marketplaceProviderPreset ? { wire: block.wire } : {}),
      ...(marketplaceProviderPreset ? { providerMetadata: marketplaceProviderPreset } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    });
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
    const llm = settingsService.get("llm");
    const block = getLlmVendorSettings(llm.vendors, model.vendor);
    const preset = model.vendor === "openai-compatible" && llm.provider === model.vendor && llm.marketplaceProviderPresetId
      ? (settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((entry) => entry.providerId === llm.marketplaceProviderPresetId)
      : undefined;
    return {
      provider: model.vendor,
      model: model.model,
      baseUrl: preset?.baseUrl ?? block.baseUrl ?? null,
      credentialScope: preset
        ? marketplaceProviderPresetSecretKey(preset.providerId)
        : secretKeyFor(model.vendor),
      ...(preset ? {
        marketplaceProviderPresetId: preset.providerId,
        providerCapabilities: preset.capabilities ?? null,
        providerTrust: preset.trust ?? null,
        requiresApiKey: preset.requiresApiKey,
      } : {}),
      ...(model.vendor === "vertex-ai" ? {
        vertexProject: block.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null,
        vertexLocation: block.vertexLocation || "us-central1",
      } : {}),
    };
  };
  const rewireReviewerAgent = (): void => {
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
        ? { label: formatJudgeModel(selectedReviewerModel), available: true }
        : undefined;
    const reviewerResult = wireReviewerAgent({
      permissionManager,
      networkFetch: singleHopNetworkFetch,
      readActiveLlm: selectedReviewerModel
        ? () => selectedReviewerIdentity(selectedReviewerModel)
        : readActiveReviewerLlm,
      streamProviderFor: selectedReviewerModel
        ? (vendor) => reviewerStreamProviderFor(vendor, selectedReviewerModel.model)
        : reviewerStreamProviderFor,
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
      providerForModel: (model) => reviewerStreamProviderFor(model.vendor, model.model),
      selectedModelCacheScope,
      networkFetch: singleHopNetworkFetch,
      audit: bootAuditLogger,
      resolveRootSessionId: ctx.resolveRootSessionId,
    });
    ctx.rationaleScopeReviewer = reviewerResult.rationaleScopeReviewer;
    ctx.approvalSentenceSelector = reviewerResult.approvalSentenceSelector;
    // Broadcast configuration changes after rewiring so open settings views stop showing stale degradation.
    broadcastPermissionConfigChangedFromHost(ctx.host.desktop?.getAppWindows() ?? []);
  };
  rewireReviewerAgent();

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
