import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { setRuntimePreflightOverride } from "../../../engine/auto-compact.js";
import { freshAllVendorBlocks } from "../../../shared/llm-vendor-defaults.js";
import { llmModelListCacheKey, type LlmModelListCache } from "../../../shared/llm-model-list.js";
import { registerDevHandlers } from "../dev.js";

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler) } }));
vi.mock("../../../boot/dev-flags.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../boot/dev-flags.js")>(),
  getIsPackaged: () => false,
}));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: () => true, auditUnauthorized: vi.fn(), UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" } }));

beforeEach(() => {
  state.handlers.clear();
  setRuntimePreflightOverride(null);
  vi.stubEnv("AVE_DEV_PREFLIGHT_OVERRIDE", "");
});
afterEach(() => { vi.unstubAllEnvs(); setRuntimePreflightOverride(null); });

it.each(["catalog", "endpoint-report", "small-endpoint-report"] as const)("includes the active route's prompt cap with %s capacity in developer status", (source) => {
  const vendors = freshAllVendorBlocks();
  vendors.openai.model = "gpt-5.2";
  const modelListCache: LlmModelListCache = source !== "catalog" ? {
    [llmModelListCacheKey("openai", vendors.openai.baseUrl)]: {
      vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-5.2"],
      modelEntries: [{ id: "gpt-5.2", contextLength: source === "endpoint-report" ? 500_000 : 64_000 }], fetchedAt: "2026-01-01T00:00:00Z",
    },
  } : {};
  const llm = { provider: "openai", vendors, modelListCache };
  registerDevHandlers({
    settingsService: { get: (key: string) => key === "llm" ? llm : { installedProviderPresets: [] } },
  } as never);
  expect(state.handlers.get(CHANNELS.dev.getPreflightStatus)!({})).toMatchObject({
    ok: true, provider: "openai", model: "gpt-5.2", effective: source === "small-endpoint-report" ? 29_600 : 217_600,
  });
});
