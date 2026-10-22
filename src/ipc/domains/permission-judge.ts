import { ipcMain } from "electron";
import { createLogger } from "../../lib/logger.js";
import { createSerialQueue } from "../../lib/with-file-lock.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { canUseLlmVendorWithoutApiKey, getLlmVendorSettings, llmRouteModel, LLM_VENDORS } from "../../shared/llm-vendor-defaults.js";
import type { PermissionJudgeReadResult, PermissionJudgeSnapshot, PermissionJudgeWriteResult } from "../../shared/permission-judge-settings.js";
import { JudgeSettingsError } from "../../permissions/judge/judge-settings.js";
import { judgeModelCatalogFrom } from "../../permissions/judge/judge-model-catalog.js";
import { readJudgeSettings, setJudgeSettingsPersist, type JudgeSettingsWriteReceipt } from "../../permissions/permission-settings-store.js";
import { hostSecretKeyForVendor } from "../../plugins/secret-access/secret-gate.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { AppSettings } from "../../data/settings-store.js";
import { broadcastToAppWindows } from "../window-fanout.js";

const log = createLogger("permission-judge");

function snapshot(deps: IpcDeps): PermissionJudgeSnapshot {
  const llm = deps.settingsService.get("llm");
  const presets = deps.settingsService.get("marketplace")?.installedProviderPresets ?? [];
  const catalog = judgeModelCatalogFrom({ ...llm, installedProviderPresets: presets });
  const modelOptions: PermissionJudgeSnapshot["modelOptions"] = [];
  for (const vendor of LLM_VENDORS) {
    const block = llm?.vendors?.[vendor] ?? {};
    const activePreset = vendor === "openai-compatible" && llm?.provider === vendor
      ? presets.find((preset) => preset.providerId === llm.marketplaceProviderPresetId) : undefined;
    const keyless = activePreset ? !activePreset.requiresApiKey : canUseLlmVendorWithoutApiKey(vendor, block);
    const projectConfigured = vendor === "vertex-ai" && Boolean(llm?.vendors?.[vendor]?.vertexProject?.trim());
    if (!keyless && !projectConfigured &&
        !deps.settingsService.getSecret(hostSecretKeyForVendor(vendor, {
          llmProvider: llm?.provider ?? "",
          marketplaceProviderPresetId: llm?.marketplaceProviderPresetId,
        }))) continue;
    for (const model of catalog.optionsFor(vendor)) modelOptions.push({ vendor, model });
  }
  const { settings: normalized, issues, modelRejected, rejectedModel, chainRejected } = readJudgeSettings(undefined, catalog);
  // A stored but unavailable model stays visible as the selection, never as "follow chat".
  const settings = rejectedModel ? { ...normalized, model: rejectedModel } : normalized;
  const selected = settings.model;
  return {
    settings, issues, modelOptions,
    storedChainRejected: chainRejected === true,
    chatModel: activeChatModelLabel(llm),
    reviewerModelUnavailable: modelRejected === true || (selected !== null &&
      !modelOptions.some((option) => option.vendor === selected.vendor && option.model === selected.model)),
  };
}

/** The route an unset reviewer model follows: the active chat model. */
function activeChatModelLabel(llm: AppSettings["llm"] | undefined): string | null {
  const runtime = llm?.activeChatRuntime;
  if (runtime?.kind === "subscription") return `${runtime.provider}/${runtime.model ?? "default"}`;
  if (!llm?.provider) return null;
  const presetId = llm.provider === "openai-compatible" ? llm.marketplaceProviderPresetId : undefined;
  const model = llmRouteModel(getLlmVendorSettings(llm.vendors, llm.provider), presetId);
  return model ? `${llm.provider}/${model}` : null;
}

/** Only the host settings surface can read or change judge automation. */
export function registerPermissionJudgeHandlers(deps: IpcDeps): void {
  const saveJudgeSettings = createSerialQueue();
  ipcMain.handle(PERMISSIONS.judgeGet, (event): PermissionJudgeReadResult => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, PERMISSIONS.judgeGet, event);
      return { ...UNAUTHORIZED_FRAME, ok: false };
    }
    return { ok: true, ...snapshot(deps) };
  });
  ipcMain.handle(PERMISSIONS.judgeSet, async (event, payload: unknown): Promise<PermissionJudgeWriteResult> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, PERMISSIONS.judgeSet, event);
      return { ...UNAUTHORIZED_FRAME, ok: false };
    }
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    return saveJudgeSettings(async (): Promise<PermissionJudgeWriteResult> => {
      const rewireReviewerAgent = deps.rewireReviewerAgent;
      if (!rewireReviewerAgent) {
        log.error("Judge settings runtime wiring is unavailable");
        return { ok: false, error: "judge-rewire-failed" };
      }
      const settings = (payload as { settings?: unknown }).settings;
      const catalog = judgeModelCatalogFrom({
        ...deps.settingsService.get("llm"),
        installedProviderPresets: deps.settingsService.get("marketplace")?.installedProviderPresets ?? [],
      });
      let receipt: JudgeSettingsWriteReceipt;
      try {
        receipt = await setJudgeSettingsPersist(settings, undefined, catalog);
      } catch (error) {
        if (error instanceof JudgeSettingsError) return { ok: false, error: "invalid-judge-settings" };
        log.error("Judge settings save failed: %s", (error as Error).message);
        return { ok: false, error: "judge-save-failed" };
      }
      try {
        rewireReviewerAgent();
      } catch (error) {
        log.error("Judge settings runtime refresh failed: %s", (error as Error).message);
        try {
          await receipt.rollback();
          rewireReviewerAgent();
        } catch (rollbackError) {
          log.error("Judge settings runtime rollback failed: %s", (rollbackError as Error).message);
          return { ok: false, error: "judge-rollback-failed" };
        }
        return { ok: false, error: "judge-rewire-failed" };
      }
      broadcastToAppWindows(deps, PERMISSIONS.configChanged, {});
      return { ok: true, ...snapshot(deps) };
    });
  });
}
