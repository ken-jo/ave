import "../../../../../test/renderer/setup.js";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { installMockAveApi, type MockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { llmModelListCacheKey, type LlmModelListCache, type LlmModelListResult } from "../../../../shared/llm-model-list.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderModelDiscoveryPolicy,
} from "../../../../shared/marketplace-package-assets.js";
import type { SubscriptionProviderView } from "../SubscriptionProvidersSection.js";
import { subscriptionRuntimeDescriptor } from "../../../../shared/subscription-runtime.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { t } from "../../../../i18n/runtime.js";
import { freshAllVendorBlocks, llmImageInputKey } from "../../../../shared/llm-vendor-defaults.js";
import { resolveContextWindowForRoute } from "../../../../shared/context-budget.js";
import { supportsVision } from "../../../../engine/llm/vendor-capabilities.js";

const useSubscriptionProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../SubscriptionProvidersController.js", () => ({
  useSubscriptionProviders: useSubscriptionProvidersMock,
}));

const { LlmTab, forgetModelListLaunchRefreshes } = await import("../LlmTab.js");
type ProviderCredentialDraft =
  import("../LlmTab.js").ProviderCredentialDraft;
type ProviderCredentialSave =
  import("../LlmTab.js").ProviderCredentialSave;
type RetiredLlmProvider = import("../LlmTab.js").LlmTabProps["retiredLlmProvider"];

type MockApi = MockAveApi;

/** Stable identity: LlmTab's settings effect keys off this array. */
const NO_PRESETS: readonly MarketplaceInstalledProviderPreset[] = [];

/** The endpoint the custom provider is configured with. */
const CUSTOM_ENDPOINT = "http://localhost:30000/v1";

function preset(
  providerId: string,
  label: string,
  baseUrl: string,
  /** A preset that ships its own catalogue declares it; without a policy the
   *  models are the endpoint's word and there are none until it answers. */
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): MarketplaceInstalledProviderPreset {
  return {
    providerId,
    label,
    baseUrl,
    defaultModel: `${providerId}-default`,
    modelOptions: [`${providerId}-default`],
    apiKeyPlaceholder: "sk-...",
    requiresApiKey: true,
    ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
  };
}

function codexView(
  overrides: Partial<SubscriptionProviderView> = {},
): SubscriptionProviderView {
  return {
    descriptor: {
      id: "codex",
      label: "Codex",
      planName: "ChatGPT",
      cliName: "Codex CLI",
      executable: "discovered",
      description: "",
      loginMethods: ["browser", "device-code"],
      supportsLogout: true,
      installGuidance: subscriptionRuntimeDescriptor("codex").installGuidance!,
    },
    status: {
      runtime: "ready",
      connection: "signed-out",
      models: [],
    },
    busyAction: null,
    refreshPending: false,
    ...overrides,
  };
}

/** The Claude plan, as the settings controller describes it: the same shape as the ChatGPT plan's. */
function claudeCodeView(
  overrides: Partial<SubscriptionProviderView> = {},
): SubscriptionProviderView {
  const base = codexView();
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      id: "claude-code",
      label: "Claude Code",
      planName: "Claude",
      cliName: "Claude Code CLI",
      loginMethods: ["browser"],
      installGuidance: subscriptionRuntimeDescriptor("claude-code").installGuidance!,
    },
    ...overrides,
  };
}

function installSubscription(
  providers: readonly SubscriptionProviderView[],
  actions: Record<string, unknown> = {},
) {
  useSubscriptionProvidersMock.mockReturnValue({
    providers,
    activeRuntime: { kind: "api" as const },
    props: {
      providers,
      activeSelection: null,
      apiChatActive: true,
      apiChatBusy: false,
      chatSelectionBusy: false,
      apiChatError: null,
      actions,
    },
  });
}

const FETCH_FAILED: LlmModelListResult = {
  ok: false,
  error: "model-list-fetch-failed",
  message: "no",
};

function makeApi(overrides: MockApi = {}): MockApi {
  const api = installMockAveApi();
  api.listLlmModels = vi.fn().mockResolvedValue(FETCH_FAILED);
  api.hasApiKey = vi.fn().mockResolvedValue(false);
  for (const [name, impl] of Object.entries(overrides)) api[name] = impl;
  return api;
}

/** A credential store holding keys for exactly these providers. */
function storedKeysFor(...providerIds: string[]) {
  return vi.fn(async (providerId: string) => providerIds.includes(providerId));
}

interface Profile {
  vendors?: Record<string, unknown>;
  installedProviderIds?: string[];
  installedProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  modelListCache?: Record<string, unknown>;
}

/**
 * An api whose settings store answers a write with the profile under test.
 *
 * The shared mock keeps its own default profile, so a row persisting the
 * catalogue it just fetched would broadcast a settings object holding none of
 * this test's providers — and cards would vanish, or lose the endpoint they
 * are configured for, mid-test and for a reason no user ever meets.
 */
function profileApi(profile: Profile, rest: MockApi = {}) {
  let settings: { llm: Record<string, unknown>; marketplace: Record<string, unknown> } = {
    llm: {
      pinnedModels: [],
      vendors: profile.vendors ?? {},
      modelListCache: profile.modelListCache ?? {},
    },
    marketplace: {
      installedProviderIds: profile.installedProviderIds ?? [],
      installedProviderPresets: profile.installedProviderPresets ?? [],
    },
  };
  const listeners = new Set<(next: unknown) => void>();
  const publish = () => {
    for (const listener of listeners) listener(settings);
  };
  const api = makeApi({
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: { llm?: Record<string, unknown> }) => {
      const vendors = { ...settings.llm.vendors as Record<string, Record<string, unknown>> };
      for (const [vendor, incoming] of Object.entries(patch.llm?.vendors as Record<string, Record<string, unknown>> ?? {})) {
        const previous = vendors[vendor] ?? {};
        vendors[vendor] = { ...previous, ...incoming };
        if (incoming.imageInput) {
          vendors[vendor].imageInput = Object.fromEntries(Object.entries({
            ...previous.imageInput as Record<string, boolean>,
            ...incoming.imageInput as Record<string, boolean | undefined>,
          }).filter(([, value]) => value !== undefined));
        }
      }
      settings = { ...settings, llm: { ...settings.llm, ...(patch.llm ?? {}), vendors } };
      publish();
      return settings;
    }),
    onSettingsUpdated: vi.fn((listener: (next: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ...rest,
  });
  return {
    api,
    /** A settings write landing from elsewhere, as every save broadcasts. */
    broadcast: async (vendors: Record<string, unknown>) => {
      settings = { ...settings, llm: { ...settings.llm, vendors } };
      await act(async () => {
        publish();
        await Promise.resolve();
      });
      // Separate acts, so the effects the broadcast queued are mounted before
      // their requests are waited on — inside a single act they would not be.
      await settleModelListRequests();
    },
  };
}

/** The generic custom provider: one stored key, one endpoint of its own. */
function genericRowApi(
  listLlmModels: MockApi["listLlmModels"] | undefined,
  baseUrl = CUSTOM_ENDPOINT,
  rest: MockApi = {},
): MockApi {
  return profileApi(
    { vendors: { "openai-compatible": baseUrl ? { baseUrl } : {} } },
    {
      hasApiKey: storedKeysFor("openai-compatible"),
      ...(listLlmModels ? { listLlmModels } : {}),
      ...rest,
    },
  ).api;
}

/** `getSettings` carrying a model-list cache, so a handshake can be pre-landed. */
function settingsWithCache(cache: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: cache },
    marketplace: { installedProviderIds: [] },
  });
}

/** `getSettings` with stored blocks, for the per-row endpoint and dirty signal. */
function settingsWithVendorBlocks(vendors: Record<string, Record<string, string>>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: {}, vendors },
    marketplace: { installedProviderIds: [] },
  });
}

interface TabProps {
  retiredLlmProvider?: RetiredLlmProvider;
  vendor?: string;
  baseUrl?: string;
  /** Seeds the parent-held credential draft, as a half-typed card would. */
  draft?: ProviderCredentialDraft | null;
  hasKey?: boolean;
  model?: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  outputTokenLimit?: number;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  marketplaceProviderPresetId?: string;
  fallbackChain?: import("../LlmTab.js").FallbackEntry[];
  fallbackOpen?: boolean;
}

/** A draft for a row whose only content is a typed key. */
function keyDraft(rowId: string, vendorId: string, keyInput: string): ProviderCredentialDraft {
  return {
    rowId,
    vendorId,
    presetId: "",
    keyInput,
    baseUrl: "",
    vertexProject: "",
    vertexLocation: "",
  };
}

interface TabHooks {
  setThinkingBudget: Mock<(budget: number) => void>;
  selectApiVendorModel: Mock<(vendorId: string, modelId: string) => void>;
  onSelectMarketplaceProviderPreset: Mock<(preset: MarketplaceInstalledProviderPreset) => void>;
  onClearMarketplaceProviderPreset: Mock<() => void>;
  onImmediateChange: Mock<() => void>;
  onSaveProviderCredential: Mock<(input: ProviderCredentialSave) => Promise<boolean>>;
}

function makeHooks(): TabHooks {
  return {
    setThinkingBudget: vi.fn(),
    selectApiVendorModel: vi.fn(),
    onSelectMarketplaceProviderPreset: vi.fn(),
    onClearMarketplaceProviderPreset: vi.fn(),
    onImmediateChange: vi.fn(),
    onSaveProviderCredential: vi.fn(async () => true),
  };
}

/**
 * The tab under its real parent contract: the credential draft is owned above
 * it, so the harness holds it in state and hands the setter down. A `vi.fn()`
 * here would make every card look permanently empty.
 */
function TabHarness({
  api,
  props,
  hooks,
}: {
  api: MockApi;
  props: TabProps;
  hooks: TabHooks;
}) {
  const [drafts, setDrafts] = useState<readonly ProviderCredentialDraft[]>(
    props.draft ? [props.draft] : [],
  );
  const [thinkingBudget, setThinkingBudget] = useState(props.thinkingBudget ?? 10_000);
  return (
    <TooltipProvider>
      <LlmTab
        api={api as never}
        marketplaceProviderPresets={props.marketplaceProviderPresets ?? NO_PRESETS}
        marketplaceProviderPresetId={props.marketplaceProviderPresetId ?? ""}
        vendor={props.vendor ?? "openai"}
        retiredLlmProvider={props.retiredLlmProvider}
        baseUrl={props.baseUrl ?? ""}
        hasKey={props.hasKey ?? true}
        setHasKey={vi.fn()}
        providerCredentialDrafts={drafts}
        onProviderCredentialDraftsChange={setDrafts}
        onSaveProviderCredential={hooks.onSaveProviderCredential}
        onSelectMarketplaceProviderPreset={hooks.onSelectMarketplaceProviderPreset}
        onClearMarketplaceProviderPreset={hooks.onClearMarketplaceProviderPreset}
        model={props.model ?? "gpt-5.4"}
        setModel={vi.fn()}
        selectApiVendorModel={hooks.selectApiVendorModel}
        enableThinking={props.enableThinking ?? false}
        setEnableThinking={vi.fn()}
        thinkingBudget={thinkingBudget}
        setThinkingBudget={(budget) => {
          hooks.setThinkingBudget(budget);
          setThinkingBudget(budget);
        }}
        outputTokenLimit={props.outputTokenLimit ?? 32_000}
        fallbackChain={props.fallbackChain ?? []}
        setFallbackChain={vi.fn()}
        fallbackOpen={props.fallbackOpen ?? false}
        setFallbackOpen={vi.fn()}
        onSaved={vi.fn()}
        onSave={vi.fn()}
        onImmediateChange={hooks.onImmediateChange}
        settingsLoaded={true}
      />
    </TooltipProvider>
  );
}

async function renderTab(api: MockApi, props: TabProps = {}) {
  const hooks = makeHooks();
  const result = render(<TabHarness api={api} props={props} hooks={hooks} />);
  // Let the mount commit; the catalogue requests it queues are awaited per test.
  await act(async () => {
    await Promise.resolve();
  });
  let current = props;
  return {
    ...result,
    hooks,
    /** Move the props the parent owns — the ACTIVE provider above all — as an
     *  explicit switch really does. */
    rerender: async (next: TabProps) => {
      current = { ...current, ...next };
      result.rerender(<TabHarness api={api} props={current} hooks={hooks} />);
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

/** Radix menus open on pointerdown, not click. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

/**
 * The model chooser's contents, by the model id each row prints.
 *
 * The rendered text runs provider and id together in adjacent spans, so a
 * substring match on it can land on the wrong row; the id attribute is the
 * only unambiguous handle.
 */
async function chooserModelIds(): Promise<string[]> {
  if (!document.querySelector("[role='option']")) {
    openMenu(screen.getByTestId(TEST_IDS.llmModelSelect));
  }
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role='option']")];
    if (found.length === 0) throw new Error("the model chooser did not open");
    return found.map((option) =>
      option.querySelector("[data-model-id]")?.getAttribute("data-model-id") ?? "");
  });
}

/** The open chooser's row for this model id. The chosen model is mirrored
 *  into the collapsed trigger as well, so the id alone can land outside the
 *  list — only a match inside an option is the row. */
function chooserOption(modelId: string): HTMLElement {
  const option = [...document.querySelectorAll(`[data-model-id="${modelId}"]`)]
    .map((node) => node.closest("[role='option']"))
    .find((node): node is HTMLElement => node instanceof HTMLElement);
  if (!option) throw new Error(`the chooser offers no ${modelId}`);
  return option;
}

/** The provider group a chooser row sits under, label included. */
function chooserGroupText(modelId: string): string {
  return chooserOption(modelId).closest("[role='group']")?.textContent ?? "";
}

/** Radix commits a chooser row on Enter, and only for the focused one. */
function pickChooserOption(modelId: string) {
  const option = chooserOption(modelId);
  option.focus();
  fireEvent.keyDown(option, { key: "Enter" });
}

/**
 * Let every model-list request the tab queued reach the API stub. Nothing on
 * that path is timed: the sync debounce went away when model lists became a
 * cached catalogue, so a request is the tail of an effect → `hasApiKey` →
 * `listLlmModels` promise chain. A few macrotask turns, each inside `act` so
 * the effects a turn commits run before the next, is all the chance the tab
 * needs to ask — and what "nothing was asked" has to wait for.
 */
async function settleModelListRequests(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function rowOrder(): (string | null)[] {
  return Array.from(
    screen.getByTestId("llm-tab:connections").querySelectorAll("[data-connection-row]"),
  ).map((node) => node.getAttribute("data-connection-row")?.replace("llm-tab:connection:", "") ?? null);
}

beforeEach(() => {
  vi.useRealTimers();
  useSubscriptionProvidersMock.mockReset();
  installSubscription([]);
  // Each test is its own app launch. The once-per-launch marker lives in the
  // module, so without this the second test in the file would inherit the
  // first one's "already asked" and every catalogue assertion after it would
  // be measuring the wrong run.
  forgetModelListLaunchRefreshes();
});

describe("LlmTab provider cards", () => {
  it("accepts an explicit choice of the same model after a provider retirement", async () => {
    const { hooks } = await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { model: "gpt-5.4", retiredLlmProvider: "copilot" });
    await chooserModelIds();
    await act(async () => { pickChooserOption("gpt-5.4"); });
    expect(hooks.selectApiVendorModel).toHaveBeenCalledWith("openai", "gpt-5.4");
    expect(hooks.onImmediateChange).toHaveBeenCalledOnce();
  });
  it.each([
    { model: "GPT-4.1", reportedModel: "gpt-4.1", inputModalities: ["text"], supportedParameters: ["tools"], vision: false, tools: true },
    { model: "GPT-4o", reportedModel: "gpt-4o", inputModalities: ["text", "image"], supportedParameters: ["tools"], vision: true, tools: true },
    { model: "Text-Embedding-3-Small", reportedModel: "text-embedding-3-small", inputModalities: ["text"], supportedParameters: ["tools"], vision: false, tools: true },
  ])("matches engine capabilities when the saved model and report differ in case: $model", async ({ model, reportedModel, inputModalities, supportedParameters, vision, tools }) => {
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("openai")]: {
        vendor: "openai", models: [reportedModel], endpoint: "https://provider.invalid/v1/models",
        modelEntries: [{ id: reportedModel, inputModalities, supportedParameters }], fetchedAt: new Date(0).toISOString(),
      },
    };
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = model;
    const route = resolveContextWindowForRoute({ provider: "openai", vendors, modelListCache });
    expect(supportsVision("openai", model, route)).toBe(vision);
    expect(route.toolCall?.supported).toBe(tools);
    const { api } = profileApi({ vendors, modelListCache }, { hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    const option = within(chooserOption(model));
    expect(Boolean(option.queryByTestId(`llm-tab:model-vision:${model}`))).toBe(vision);
    expect(Boolean(option.queryByTestId(`llm-tab:model-no-tools:${model}`))).toBe(!tools);
  });

  it("draws every fact on a case-matched row from the one report its badges use", async () => {
    const model = "GPT-4.1";
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("openai")]: {
        vendor: "openai", models: ["gpt-4.1"], endpoint: "https://provider.invalid/v1/models",
        modelEntries: [{
          id: "gpt-4.1", provider: "Reported Lab", inputModalities: ["text", "image"],
          supportedParameters: ["tools", "reasoning"],
        }],
        fetchedAt: new Date(0).toISOString(),
      },
    };
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = model;
    const { api } = profileApi({ vendors, modelListCache }, { hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    const option = within(chooserOption(model));
    expect(option.queryByTestId(`llm-tab:model-vision:${model}`)).not.toBeNull();
    expect(option.queryByTestId(`llm-tab:model-reasoning:${model}`)).not.toBeNull();
    expect(option.getByTestId(`llm-tab:model-provider:${model}`).textContent).toBe("Reported Lab");
  });

  it.each([false, true].flatMap((reversed) => [
    { reversed, model: "Text-Embedding-3-Small", vision: true, tools: true },
    { reversed, model: "text-embedding-3-small", vision: false, tools: false },
    { reversed, model: "tExT-eMbEdDiNg-3-sMaLl", vision: false, tools: false },
  ]))("keeps case-distinct model badges separate: $model ($reversed)", async ({ reversed, model, vision, tools }) => {
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("openai")]: {
        vendor: "openai", models: ["Text-Embedding-3-Small", "text-embedding-3-small"], endpoint: "https://provider.invalid/v1/models",
        modelEntries: [
          { id: "Text-Embedding-3-Small", inputModalities: ["text", "image"], supportedParameters: ["tools"] },
          { id: "text-embedding-3-small", inputModalities: ["text"], supportedParameters: ["temperature"] },
        ],
        fetchedAt: new Date(0).toISOString(),
      },
    };
    if (reversed) modelListCache[llmModelListCacheKey("openai")]!.modelEntries!.reverse();
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = model;
    const { api } = profileApi({ vendors, modelListCache }, { hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    const option = within(chooserOption(model));
    expect(Boolean(option.queryByTestId(`llm-tab:model-vision:${model}`))).toBe(vision);
    expect(Boolean(option.queryByTestId(`llm-tab:model-no-tools:${model}`))).toBe(!tools);
    const route = resolveContextWindowForRoute({ provider: "openai", vendors, modelListCache });
    expect(supportsVision("openai", model, route)).toBe(vision);
    expect(route.toolCall?.supported).toBe(tools);
  });

  it("names no model on a first run with no provider connected", async () => {
    // Owner report: an empty Model select above "Declares image support for
    // gpt-5.4-mini on this provider". The id is the vendor default nobody
    // picked, on a route with no credential behind it.
    await renderTab(makeApi(), { vendor: "openai", model: "", hasKey: false });
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.llmModelSelect))
      .toHaveTextContent(t("llmTab.modelPlaceholderNoProvider")));
    expect(screen.queryByTestId("llm-tab:image-input-row")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "이미지 입력" })).toBeNull();
    expect(document.body).not.toHaveTextContent(/gpt-5\.4-mini/);
  });

  it("shows image input for the selected model once its provider holds a key (control)", async () => {
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { vendor: "openai", model: "gpt-5.4", hasKey: true });
    const control = await screen.findByRole("combobox", { name: "이미지 입력" });
    expect(control).toHaveAccessibleDescription(expect.stringContaining("gpt-5.4"));
  });

  it("saves the active vendor model without a stale preset's scope", async () => {
    const model = "gpt-5.4";
    const { api } = profileApi({ vendors: { openai: { model } } }, { hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model, marketplaceProviderPresetId: "stale-provider" });
    openMenu(screen.getByRole("combobox", { name: "이미지 입력" }));
    fireEvent.click(screen.getByRole("option", { name: /^지원$/ }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm: { vendors: {
      openai: { imageInput: { [llmImageInputKey(model)]: true } },
    } } }));
  });

  it("lets an unknown custom model declare image support and return to automatic", async () => {
    const model = "opaque-model";
    const { api } = profileApi({ vendors: { "openai-compatible": { model, baseUrl: CUSTOM_ENDPOINT } } }, {
      hasApiKey: storedKeysFor("openai-compatible"),
    });
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model });
    const control = screen.getByRole("combobox", { name: "이미지 입력" });
    expect(control).toHaveTextContent("자동");
    expect(control).toHaveAccessibleDescription(expect.stringContaining(model));
    openMenu(control);
    fireEvent.click(screen.getByRole("option", { name: /^지원$/ }));
    await waitFor(() => expect(control).toHaveTextContent("지원"));
    expect(api.updateSettings).toHaveBeenCalledWith({ llm: { vendors: {
      "openai-compatible": { imageInput: { [llmImageInputKey(model)]: true } },
    } } });
    expect(await chooserModelIds()).toContain(model);
    expect(within(chooserOption(model)).getByTestId(`llm-tab:model-vision:${model}`)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    openMenu(control);
    fireEvent.click(screen.getByRole("option", { name: /^자동$/ }));
    await waitFor(() => expect(control).toHaveTextContent("자동"));
    expect(api.updateSettings).toHaveBeenCalledWith({ llm: { vendors: {
      "openai-compatible": { imageInput: { [llmImageInputKey(model)]: undefined } },
    } } });
    expect(await chooserModelIds()).toContain(model);
    expect(within(chooserOption(model)).queryByTestId(`llm-tab:model-vision:${model}`)).not.toBeInTheDocument();
  });

  it.each(["rejected", "refused"])("keeps the saved image capability after a %s declaration save", async (failure) => {
    const model = "opaque-model";
    const { api } = profileApi({ vendors: { "openai-compatible": { model, baseUrl: CUSTOM_ENDPOINT } } }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      updateSettings: failure === "rejected"
        ? vi.fn().mockRejectedValue(new Error("fixture settings write failed"))
        : vi.fn().mockResolvedValue({ ok: false, error: "settings-update-failed" }),
    });
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model });
    const control = screen.getByRole("combobox", { name: "이미지 입력" });
    openMenu(control);
    fireEvent.click(screen.getByRole("option", { name: /^지원$/ }));
    // The renderer fixture's catalog policy is unavailable, which raises its own alert.
    await waitFor(() => expect(screen.getAllByRole("alert").map((alert) => alert.textContent))
      .toContainEqual(expect.stringContaining("이미지 입력 설정을 저장하지 못했습니다")));
    expect(control).toHaveTextContent("자동");
    expect(await chooserModelIds()).toContain(model);
    expect(within(chooserOption(model)).queryByTestId(`llm-tab:model-vision:${model}`)).not.toBeInTheDocument();
  });

  it.each([
    { model: "text-embedding-3-small", badge: true },
    { model: "gpt-4.1", badge: false },
    { model: "a-served-model", badge: false },
    { model: "text-embedding-3-small", supportedParameters: ["tools"], badge: false },
  ])("shows the no-tools badge only for a route that withholds tools: %j", async ({ model, supportedParameters, badge }) => {
    const { api } = profileApi({ vendors: { openai: { model } } }, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://provider.invalid/v1/models",
        models: [model],
        modelEntries: [{ id: model, contextLength: 777_000, ...(supportedParameters ? { supportedParameters } : {}) }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    await waitFor(() => expect(within(chooserOption(model)).getByTestId(`llm-tab:model-facts:${model}`)).toHaveTextContent("777k"));
    await waitFor(() => {
      const row = within(chooserOption(model));
      const chip = row.queryByTestId(`llm-tab:model-no-tools:${model}`);
      if (badge) {
        expect(chip).toHaveTextContent("도구 미지원");
        expect(chip).toHaveAccessibleName("이 모델에는 도구를 보내지 않습니다");
        expect(chip).toHaveAttribute("title", "이 모델에는 도구를 보내지 않습니다");
      } else {
        expect(chip).not.toBeInTheDocument();
      }
    });
  });

  it.each([
    { model: "gpt-4.1", catalogModel: "openai/gpt-3.5-turbo", badge: true },
    { model: "text-embedding-3-small", catalogModel: "openai/gpt-4.1", badge: false },
    { model: "text-embedding-3-small", catalogModel: "openai/not-listed", badge: false },
    { model: "gpt-4.1", catalogModel: "openai/gpt-3.5-turbo", supportedParameters: ["tools"], badge: true },
  ])("uses the vendor route's named catalog entry for the tool badge: %j", async ({ model, catalogModel, supportedParameters, badge }) => {
    const { api } = profileApi({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, model, catalogModel } },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai-compatible",
        endpoint: `${CUSTOM_ENDPOINT}/models`,
        models: [model],
        modelEntries: [{ id: model, contextLength: 777_000, ...(supportedParameters ? { supportedParameters } : {}) }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model });
    expect(await chooserModelIds()).toContain(model);
    await waitFor(() => expect(within(chooserOption(model)).getByTestId(`llm-tab:model-facts:${model}`)).toHaveTextContent("777k"));
    await waitFor(() => {
      const chip = within(chooserOption(model)).queryByTestId(`llm-tab:model-no-tools:${model}`);
      expect(Boolean(chip)).toBe(badge);
    });
  });

  it.each([
    { catalogModel: "openai/gpt-4", reportedInput: ["text", "image"], vision: false },
    { catalogModel: "openai/gpt-4o", reportedInput: ["text"], vision: true },
  ])("uses the named route's input modalities for the vision badge: %j", async ({ catalogModel, reportedInput, vision }) => {
    const model = "opaque-model";
    const { api } = profileApi({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, model, catalogModel } },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true, vendor: "openai-compatible", endpoint: `${CUSTOM_ENDPOINT}/models`, models: [model],
        modelEntries: [{ id: model, inputModalities: reportedInput }], fetchedAt: new Date(0).toISOString(),
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model });
    expect(await chooserModelIds()).toContain(model);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(Boolean(within(chooserOption(model)).queryByTestId(`llm-tab:model-vision:${model}`))).toBe(vision);
  });

  it.each(["pending", "failed"])("uses saved input modalities for the vision badge while a cache save is %s", async (saveState) => {
    const model = "gpt-4o";
    const { api } = profileApi({
      vendors: { openai: { model } },
      modelListCache: {
        [["openai", "", ""].join("\n")]: {
          vendor: "openai", models: [model], endpoint: "https://provider.invalid/v1/models",
          modelEntries: [{ id: model, inputModalities: ["text"] }], fetchedAt: new Date(0).toISOString(),
        },
      },
    }, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true, vendor: "openai", endpoint: "https://provider.invalid/v1/models", models: [model],
        modelEntries: [{ id: model, inputModalities: ["text", "image"] }], fetchedAt: new Date(1).toISOString(),
      } satisfies LlmModelListResult),
      updateSettings: saveState === "pending"
        ? vi.fn(() => new Promise(() => {}))
        : vi.fn().mockResolvedValue({ ok: false, error: "settings-update-failed" }),
    });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(within(chooserOption(model)).queryByTestId(`llm-tab:model-vision:${model}`)).not.toBeInTheDocument();
  });

  it("does not apply the generic route's named no-tools entry to a preset", async () => {
    const gateway = preset("model-gateway", "Model Gateway", "https://gateway.example/v1");
    const model = "gpt-4.1";
    const { api } = profileApi({
      vendors: { "openai-compatible": { catalogModel: "openai/gpt-3.5-turbo" } },
      installedProviderPresets: [gateway],
      modelListCache: {
        [["openai-compatible", gateway.baseUrl, gateway.providerId].join("\n")]: {
          vendor: "openai-compatible", baseUrl: gateway.baseUrl, credentialScope: gateway.providerId,
          endpoint: `${gateway.baseUrl}/models`, models: [model], modelEntries: [{ id: model }],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }, {
      hasApiKey: storedKeysFor(`marketplace-provider:${gateway.providerId}`),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "openai-compatible", model, marketplaceProviderPresets: [gateway],
      marketplaceProviderPresetId: gateway.providerId,
    });
    expect(await chooserModelIds()).toContain(model);
    expect(within(chooserOption(model)).queryByTestId(`llm-tab:model-no-tools:${model}`)).not.toBeInTheDocument();
  });

  it.each([
    { baseUrl: "https://gateway.invalid/v1", badge: false },
    { baseUrl: "https://api.openai.com/v1", badge: true },
  ])("follows the engine's endpoint identity for a same-name model's tool badge: $baseUrl", async ({ baseUrl, badge }) => {
    const model = "text-embedding-3-small";
    const { api } = profileApi({ vendors: { openai: { model, baseUrl } } }, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, { vendor: "openai", baseUrl, model });
    expect(await chooserModelIds()).toContain(model);
    expect(Boolean(within(chooserOption(model)).queryByTestId(`llm-tab:model-no-tools:${model}`))).toBe(badge);
  });

  it.each([
    { baseUrl: "https://gateway.invalid/v1", badge: false },
    { baseUrl: "https://api.openai.com/v1", badge: true },
  ])("matches a fallback row's tool badge under its saved endpoint like the engine: $baseUrl", async ({ baseUrl, badge }) => {
    // provider.ts builds a fallback on the vendor block's saved baseUrl, and the
    // adapter matches the catalog under that endpoint's identity.
    const model = "text-embedding-3-small";
    const { api } = profileApi({ vendors: { openai: { model, baseUrl } } }, {
      hasApiKey: storedKeysFor("openai", "claude"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "claude", model: "claude-sonnet-4-6",
      fallbackOpen: true, fallbackChain: [{ provider: "openai", model }],
    });
    const section = screen.getByTestId("fallback-chain-section");
    const triggers = [...section.querySelectorAll<HTMLElement>("[role='combobox']")];
    openMenu(triggers[triggers.length - 1]!);
    const option = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")]
        .find((node) => node.querySelector(`[data-model-id='${model}']`));
      expect(found).toBeDefined();
      return found!;
    });
    expect(Boolean(within(option).queryByTestId(`llm-tab:model-no-tools:${model}`))).toBe(badge);
  });

  it("hides a model the catalog deprecates from the chooser, the saved one included (design §6.1)", async () => {
    const { api } = profileApi({ vendors: { openai: { model: "o4-mini" } } }, {
      hasApiKey: storedKeysFor("openai"),
      // The endpoint still answers with it; the catalog's status decides.
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true, vendor: "openai", endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5.4", "o3", "o4-mini"], fetchedAt: "2026-10-13T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    // The deprecated tier sets no marker: the trigger names the model and its tier.
    await renderTab(api, { vendor: "openai", model: "o4-mini" });
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.llmModelSelect))
      .toHaveTextContent(t("llmTab.modelDeprecatedPlaceholder", { model: "o4-mini" })));
    const ids = await chooserModelIds();
    expect(ids).toContain("gpt-5.4");
    expect(ids).toContain("o3");
    expect(ids).not.toContain("o4-mini");
  });

  it("hides a model the vendor's complete listing dropped, and leaves a saved fallback at it unselected", async () => {
    const listing = {
      vendor: "openai",
      endpoint: "https://api.openai.com/v1/models",
      models: ["gpt-5.4", "gpt-5.4-mini"],
      complete: true,
      fetchedAt: "2026-10-13T00:00:00.000Z",
    };
    const { api } = profileApi({
      vendors: { openai: { model: "gpt-5.4" } },
      modelListCache: { ["openai\n\n"]: listing },
    }, {
      hasApiKey: storedKeysFor("openai", "claude"),
      listLlmModels: vi.fn(async ({ vendor }: { vendor: string }) => (vendor === "openai"
        ? { ...listing, ok: true, complete: true }
        : new Promise<LlmModelListResult>(() => {})) as LlmModelListResult),
    });
    await renderTab(api, {
      vendor: "claude", model: "claude-sonnet-4-6",
      fallbackOpen: true, fallbackChain: [{ provider: "openai", model: "gpt-4.1" }],
    });
    const section = screen.getByTestId("fallback-chain-section");
    const triggers = [...section.querySelectorAll<HTMLElement>("[role='combobox']")];
    const modelTrigger = triggers[triggers.length - 1]!;
    await waitFor(() => expect(modelTrigger).toHaveTextContent(t("llmTab.modelRetiredPlaceholder", { model: "gpt-4.1" })));
    openMenu(modelTrigger);
    const ids = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")]
        .map((node) => node.querySelector("[data-model-id]")?.getAttribute("data-model-id") ?? node.textContent ?? "");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(ids).toContain("gpt-5.4");
    expect(ids).not.toContain("gpt-4.1");
  });

  it.each([
    { model: "gpt-5.1-codex", supportedParameters: undefined, unstated: true, reasoning: false },
    { model: "gpt-5.4", supportedParameters: undefined, unstated: false, reasoning: true },
    { model: "gpt-5.1-codex", supportedParameters: ["tools", "reasoning"], unstated: false, reasoning: true },
  ])("marks a route whose reasoning levels nobody states, as the engine plans it: $model $supportedParameters", async ({ model, supportedParameters, unstated, reasoning }) => {
    const modelListCache: LlmModelListCache = {
      [llmModelListCacheKey("openai")]: {
        vendor: "openai", models: [model], endpoint: "https://api.openai.com/v1/models",
        modelEntries: [{ id: model, ...(supportedParameters ? { supportedParameters } : {}) }], fetchedAt: new Date(0).toISOString(),
      },
    };
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = model;
    const { api } = profileApi({ vendors, modelListCache }, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    const row = within(chooserOption(model));
    const badge = row.queryByTestId(`llm-tab:model-reasoning-unstated:${model}`);
    expect(Boolean(badge)).toBe(unstated);
    if (badge) {
      expect(badge).toHaveTextContent(t("llmTab.modelReasoningUnstatedBadge"));
      expect(badge).toHaveAttribute("role", "note");
      expect(badge.getAttribute("title")).toContain("llm.vendors.openai.catalogModel");
      expect(badge).toHaveAccessibleName(t("llmTab.modelReasoningUnstatedHelp", { vendor: "openai" }));
    }
    expect(Boolean(row.queryByTestId(`llm-tab:model-reasoning:${model}`))).toBe(reasoning);
  });

  it("does not mark an OpenAI-compatible route, which plans no effort of its own", async () => {
    const model = "lab/unlisted-model";
    const { api } = profileApi({ vendors: { openrouter: { model } } }, {
      hasApiKey: storedKeysFor("openrouter"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, { vendor: "openrouter", model });
    expect(await chooserModelIds()).toContain(model);
    expect(within(chooserOption(model)).queryByTestId(`llm-tab:model-reasoning-unstated:${model}`)).toBeNull();
  });

  it("marks a fallback row the same way the engine plans a fallback", async () => {
    const { api } = profileApi({
      vendors: { "azure-foundry": { model: "my-deployment", baseUrl: "https://synthetic.openai.azure.com/openai/v1" } },
      installedProviderIds: ["azure-foundry"],
    }, {
      hasApiKey: storedKeysFor("azure-foundry", "claude"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "claude", model: "claude-sonnet-4-6",
      fallbackOpen: true, fallbackChain: [{ provider: "azure-foundry", model: "my-deployment" }],
    });
    const section = screen.getByTestId("fallback-chain-section");
    const triggers = [...section.querySelectorAll<HTMLElement>("[role='combobox']")];
    openMenu(triggers[triggers.length - 1]!);
    await waitFor(() => expect(document.querySelector("[data-testid='llm-tab:model-reasoning-unstated:my-deployment']")).not.toBeNull());
  });

  it.each(["pending", "failed"])("keeps the tool badge consistent with the engine during a %s capability cache save", async (saveState) => {
    const model = "text-embedding-3-small";
    const { api } = profileApi({
      vendors: { openai: { model } },
    }, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true, vendor: "openai", endpoint: "https://provider.invalid/v1/models", models: [model],
        modelEntries: [{ id: model, contextLength: 777_000, supportedParameters: ["tools"] }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
      updateSettings: saveState === "pending"
        ? vi.fn(() => new Promise(() => {}))
        : vi.fn().mockResolvedValue({ ok: false, error: "settings-update-failed" }),
    });
    await renderTab(api, { vendor: "openai", model });
    expect(await chooserModelIds()).toContain(model);
    await waitFor(() => expect(within(chooserOption(model)).getByTestId(`llm-tab:model-facts:${model}`)).toHaveTextContent("777k"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(within(chooserOption(model)).getByTestId(`llm-tab:model-no-tools:${model}`)).toHaveTextContent("도구 미지원");
  });

  it.each([[32_000, 16_000], [16_000, 8_000], [32_001, 32_000]])(
    "offers only presets below output %i", async (outputTokenLimit, expected) => {
      const { hooks } = await renderTab(makeApi(), { enableThinking: true, thinkingBudget: 4_000, outputTokenLimit });
      const slider = within(screen.getByTestId("llm-tab:section-thinking")).getByRole("slider");
      const maximumIndex = outputTokenLimit === 32_000 ? "2" : outputTokenLimit === 16_000 ? "1" : "3";
      expect(slider).toHaveAttribute("aria-valuemax", maximumIndex);
      fireEvent.keyDown(slider, { key: "End" });
      expect(hooks.setThinkingBudget).toHaveBeenLastCalledWith(expected);
      expect(hooks.onImmediateChange).toHaveBeenCalled();
      expect(slider).toHaveAttribute("aria-valuenow", maximumIndex);
    },
  );

  it("displays a custom saved budget without snapping it until the user selects a preset", async () => {
    const { hooks } = await renderTab(makeApi(), { enableThinking: true, thinkingBudget: 14_000, outputTokenLimit: 32_000 });
    const section = screen.getByTestId("llm-tab:section-thinking");
    expect(section).toHaveTextContent("14,000");
    expect(hooks.setThinkingBudget).not.toHaveBeenCalled();
    const presets = within(section).getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));
    expect(presets).toHaveLength(3);
    expect(presets.every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
    fireEvent.click(presets[2]!);
    expect(hooks.setThinkingBudget).toHaveBeenLastCalledWith(16_000);
    expect(section).toHaveTextContent("16,000");
  });

  it("shows the existing custom budget without a preset slider when the output ceiling is too small", async () => {
    const { hooks } = await renderTab(makeApi(), { enableThinking: true, thinkingBudget: 1_999, outputTokenLimit: 2_000 });
    const section = screen.getByTestId("llm-tab:section-thinking");
    expect(section).toHaveTextContent("1,999");
    expect(within(section).queryByRole("slider")).toBeNull();
    expect(hooks.setThinkingBudget).not.toHaveBeenCalled();
  });

  it("puts Save inside the card being edited, not on the page", async () => {
    await renderTab(makeApi(), { draft: keyDraft("openai", "openai", "sk-typed") });

    expect(screen.queryByTestId("llm-tab:save-providers")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection:openai:toggle"));

    const card = screen.getByTestId("llm-tab:connection:openai");
    expect(card).toContainElement(screen.getByTestId("llm-tab:save-providers"));
  });

  it("hides the API key field until the API-key route is chosen", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }));

    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
    // The sign-in buttons are the row's too, and stay folded away with the rest.
    expect(screen.queryByTestId("subscription-provider:codex:login-browser")).not.toBeInTheDocument();

    const toggle = screen.getByTestId("llm-tab:connection:codex:toggle");
    fireEvent.click(toggle);
    const body = screen.getByTestId("llm-tab:connection:codex:detail");
    // ONE row, opened on the method already in use — here the stored key — so
    // the key form shows and the sign-in controls wait behind the other choice.
    await waitFor(() => expect(screen.getByTestId("llm-tab:sign-in-method:codex:api"))
      .toHaveAttribute("aria-checked", "true"));
    const form = await screen.findByTestId("llm-tab:manual-section");
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-provider:codex:login-browser")).not.toBeInTheDocument();
    expect(body).toContainElement(form);
    expect(toggle).toHaveAttribute("aria-controls", body.id);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(/설정됨|Configured|Set/);
  });

  it("asks for the sign-in method before showing its credential form", async () => {
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(makeApi());
    fireEvent.click(screen.getByTestId("llm-tab:connection:codex:toggle"));
    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("llm-tab:save-providers")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("llm-tab:sign-in-method:codex:api"));
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("");
    expect(screen.queryByTestId("subscription-provider:codex:login-browser")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("llm-api-key-input"), { target: { value: "sk-typed" } });
    fireEvent.click(screen.getByTestId("llm-tab:sign-in-method:codex:subscription"));
    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("llm-tab:sign-in-method:codex:api"));
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("");
    fireEvent.click(screen.getByTestId("llm-tab:save-providers-cancel"));
    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
  });

  it("offers to replace, not set, a key the row already holds", async () => {
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { vendor: "openai", hasKey: true });
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai:toggle"));
    expect(await screen.findByTestId("llm-tab:api-key-reveal")).toHaveTextContent(t("llmTab.replaceApiKey"));
    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
  });

  it("asks for no endpoint where the endpoint is fixed", async () => {
    const { unmount } = await renderTab(makeApi());
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai:toggle"));
    expect(screen.queryByTestId("llm-base-url-input")).not.toBeInTheDocument();
    unmount();

    await renderTab(makeApi(), { vendor: "openrouter", model: "openai/gpt-5.4" });
    fireEvent.click(screen.getByTestId("llm-tab:connection:openrouter:toggle"));
    expect(screen.queryByTestId("llm-base-url-input")).not.toBeInTheDocument();
  });

  it("asks for an endpoint on the custom OpenAI-compatible provider", async () => {
    await renderTab(makeApi(), {
      vendor: "openai-compatible",
      baseUrl: "http://localhost:8001/v1",
      model: "local-model",
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    expect(screen.getByTestId("llm-base-url-input")).toBeInTheDocument();
  });

  it("asks for an endpoint on a self-hosted vendor whose address is per install", async () => {
    const api = makeApi({
      getSettings: settingsWithVendorBlocks({ ollama: { baseUrl: "http://127.0.0.1:11434/v1" } }),
    });
    await renderTab(api, { vendor: "ollama", model: "llama3" });
    fireEvent.click(screen.getByTestId("llm-tab:connection:ollama:toggle"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue("http://127.0.0.1:11434/v1");
  });

  it("appends an added provider below every existing card", async () => {
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(makeApi());

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("claude");
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe("LlmTab provider cards leave the chat route alone", () => {
  it("opens an added provider's card without switching what chat runs on", async () => {
    // The live regression: picking a vendor from the add menu persisted
    // `llm.provider`, so chat moved to a provider with no credential at all.
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    // The card is open and editable...
    expect(screen.getByTestId("llm-tab:connection:claude"))
      .toContainElement(screen.getByTestId("llm-tab:manual-section"));
    // ...and nothing was persisted by opening it.
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onSelectMarketplaceProviderPreset).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ llm: expect.objectContaining({ provider: expect.anything() }) }),
    );
    // The live-route badge is still on the provider chat is actually using.
    expect(screen.getByTestId("llm-tab:connection-route:openai:api"))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("llm-tab:connection-route:claude:api"))
      .toHaveAttribute("data-active", "false");
  });

  it("offers no way to choose a provider on the card itself", async () => {
    // Picking a model is the whole decision. A second control that also moved
    // the route made "which provider answers" a question the screen asked
    // twice, in two places that could disagree.
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    expect(document.querySelector("[data-testid^='llm-tab:connection-use']")).toBeNull();
  });

  it("writes only the row's own secret when its key is saved", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), {
      target: { value: "sk-ant-new" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await waitFor(() => expect(hooks.onSaveProviderCredential).toHaveBeenCalledWith({
      credentialProviderId: "claude",
      vendorId: "claude",
      apiKey: "sk-ant-new",
    }));
    // A fixed-endpoint vendor owns no persisted field here, so no block is
    // written — and saving a credential is not choosing who answers.
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(screen.getByTestId("llm-tab:connection-route:openai:api"))
      .toHaveAttribute("data-active", "true");
    // A committed card closes and gives its room back to the list.
    await waitFor(() => expect(screen.queryByTestId("llm-api-key-input")).toBeNull());
    expect(screen.getByTestId("llm-tab:connection:claude:toggle"))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a refused save open on its row, with the fields still in it", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });
    hooks.onSaveProviderCredential.mockResolvedValue(false);

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), { target: { value: "sk-ant-new" } });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    // Closing on a refusal would take away the very fields that have to be
    // corrected, and say nothing about why.
    await screen.findByTestId("llm-tab:connection-save-failed:claude");
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("sk-ant-new");
    expect(screen.getByTestId("llm-tab:connection:claude:toggle"))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("puts a cancelled key field away along with what was typed into it", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), { target: { value: "sk-ant-new" } });

    fireEvent.click(screen.getByTestId("llm-tab:save-providers-cancel"));

    // Cancelling is a decision: the field goes with what was typed into it,
    // and asking for it again must not bring the abandoned key back.
    expect(screen.queryByTestId("llm-api-key-input")).toBeNull();
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("");
  });

  it("edits each row's own endpoint while a third provider is the active one", async () => {
    const generic = "http://localhost:8001/v1";
    const selfHosted = "http://127.0.0.1:11434/v1";
    const api = makeApi({
      hasApiKey: storedKeysFor("openai", "openai-compatible", "ollama"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: {
            "openai-compatible": { baseUrl: generic },
            ollama: { baseUrl: selfHosted },
          },
        },
        marketplace: { installedProviderIds: ["ollama"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    const generalRow = screen.getByTestId("llm-tab:connection:openai-compatible");
    expect(within(generalRow).getByTestId("llm-base-url-input")).toHaveValue(generic);

    // Opening a second row leaves the first open: comparing two providers is a
    // normal thing to do, and each keeps its own fields.
    fireEvent.click(screen.getByTestId("llm-tab:connection:ollama:toggle"));
    const ollamaRow = screen.getByTestId("llm-tab:connection:ollama");
    expect(within(ollamaRow).getByTestId("llm-base-url-input")).toHaveValue(selfHosted);
    expect(within(generalRow).getByTestId("llm-base-url-input")).toHaveValue(generic);
    // Neither card is the one chat is on, and neither claims to be.
    expect(screen.getByTestId("llm-tab:connection-route:openai:api"))
      .toHaveAttribute("data-active", "true");
  });

  it("offers no chat switch on a signed-out subscription runtime", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { vendor: "openai", model: "" });

    // The runtime's own action is the single source for that route, and it is
    // simply not on offer until the user is signed in.
    expect(screen.queryByTestId("subscription-provider:codex:use-for-chat")).toBeNull();
  });

  it("names the active provider on its own card, not the open one", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    fireEvent.click(screen.getByTestId("llm-tab:connection:claude:toggle"));

    // Opening a card is reading, not choosing: the live-route badge stays where
    // the route is, and the card that is merely open says nothing about it.
    expect(screen.getByTestId("llm-tab:connection-route:openai:api"))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("llm-tab:connection-route:claude:api"))
      .toHaveAttribute("data-active", "false");
  });

  it("keeps the card on screen after its only credential is deleted", async () => {
    // This row exists because of the stored key and nothing else, so removing
    // the key used to remove the place a replacement could be entered.
    const deleted = deferred<{ ok: true }>();
    const credentials = deferred<boolean>();
    const api = makeApi({
      hasApiKey: storedKeysFor("claude"),
      deleteApiKey: vi.fn(() => deleted.promise),
    });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    fireEvent.click(screen.getByTestId("llm-tab:connection:claude:toggle"));
    api.hasApiKey = vi.fn(() => credentials.promise);
    fireEvent.click(screen.getByText(/^(삭제|Delete|Remove)$/));

    await waitFor(() => expect(api.deleteApiKey).toHaveBeenCalledWith("claude"));
    await act(async () => {
      deleted.resolve({ ok: true });
      await deleted.promise;
    });
    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("claude"));
    await act(async () => {
      credentials.resolve(false);
      await credentials.promise;
    });
    expect(screen.getByTestId("llm-tab:connection:claude")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tab:api-key-reveal")).toHaveTextContent(t("llmTab.setApiKey"));
    expect(screen.getByTestId("llm-tab:api-key-status"))
      .toHaveTextContent(t("llmTab.apiKeyNotSet"));
  });
});

describe("LlmTab model chooser is the whole switch", () => {
  it("leaves an uncredentialed provider out of the chooser and says so on its card", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("gemini") });
    await renderTab(api, { vendor: "gemini", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    // The card is there to type a key into, and it says what the key buys.
    expect(screen.getByTestId("llm-tab:connection-blocked:claude"))
      .toHaveTextContent(/키|key|Schlüssel|clave|clé|キー|密钥/i);
    // The chooser is populated — by the provider that CAN answer, only.
    const offered = await chooserModelIds();
    expect(offered).toContain("gemini-3.8-flash");
    expect(offered.some((id) => id.startsWith("claude"))).toBe(false);
  });

  it("offers a keyed provider's models and moves the route on the pick alone", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    const offered = await chooserModelIds();
    // A curated vendor's bundled line is its catalogue, so a saved key is all
    // it takes for its models to be choosable from another provider's row.
    expect(offered).toContain("claude-sonnet-4-6");
    expect(offered).toContain("claude-opus-4-6");
    expect(chooserGroupText("claude-opus-4-6")).toMatch(/Claude/);

    pickChooserOption("claude-opus-4-6");

    // Provider and model move together, in one write, with no Save button in
    // the path — the same way the thinking controls persist.
    await waitFor(() => expect(hooks.selectApiVendorModel)
      .toHaveBeenCalledWith("claude", "claude-opus-4-6"));
    expect(hooks.onImmediateChange).toHaveBeenCalled();
    expect(hooks.onSaveProviderCredential).not.toHaveBeenCalled();
  });

  it("offers a connected subscription's models beside the API providers", async () => {
    const useForChat = vi.fn();
    installSubscription(
      [codexView({
        status: {
          runtime: "ready",
          connection: "connected",
          models: [{ id: "codex-mini", label: "codex-mini" }],
        },
      })],
      { useForChat, useApiForChat: vi.fn() },
    );
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), {
      vendor: "openai",
      model: "",
    });

    expect(await chooserModelIds()).toContain("codex-mini");
    // The company, not the runtime: the chooser never offers "Codex".
    expect(chooserGroupText("codex-mini")).toMatch(/OpenAI/);
    expect(chooserGroupText("codex-mini")).not.toMatch(/Codex/);

    pickChooserOption("codex-mini");

    // A subscription pick still goes through the runtime's own action: it is
    // a sign-in-backed route, not an API credential.
    await waitFor(() => expect(useForChat).toHaveBeenCalledWith("codex", "codex-mini"));
  });

  /**
   * The subscription half of the merge, at the level the runtime cannot be
   * reached.
   *
   * An isolated home has no signed-in account, so the live path cannot be
   * exercised — but the claim the merge makes is structural and holds without
   * one: a provider is ONE row and states ONE verdict, whether its models come
   * from a signed-in runtime or from an endpoint's catalogue. Both shapes are
   * on screen together here, so "the same" is asserted rather than assumed.
   */
  it("gives a subscription-fed row the same shape and the same one verdict as an API-key row", async () => {
    const api = genericRowApi(vi.fn().mockResolvedValue({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: ["qwen-self-hosted"],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult));
    // Connected runtime, models from the runtime, and no OpenAI key at all —
    // so this row has no endpoint handshake of any kind behind it.
    installSubscription(
      [codexView({
        status: {
          runtime: "ready",
          connection: "connected",
          models: [{ id: "codex-mini", label: "codex-mini" }],
        },
      })],
      { refreshStatus: vi.fn(), useForChat: vi.fn(), useApiForChat: vi.fn() },
    );
    await renderTab(api, {
      vendor: "openai-compatible",
      baseUrl: CUSTOM_ENDPOINT,
      model: "",
    });

    await waitFor(() => expect(rowOrder()).toEqual(["codex", "openai-compatible"]));

    // One verdict per row, never more — the invariant a live subscription would
    // have to satisfy too, and the one the two surfaces used to break.
    await waitFor(() => {
      const verdicts = [...document.querySelectorAll("[data-provider-sync-status]")];
      expect(verdicts).toHaveLength(rowOrder().length);
    });

    for (const rowId of ["codex", "openai-compatible"]) {
      const row = screen.getByTestId(`llm-tab:connection:${rowId}`);
      expect(row.querySelectorAll("[data-provider-sync-status]")).toHaveLength(1);
      expect(row.querySelectorAll("[data-testid^='llm-tab:connection-refresh:']")).toHaveLength(1);
      expect(row.querySelectorAll("[data-testid^='llm-tab:connection:'][data-testid$=':state']")).toHaveLength(1);
      expect(row.querySelectorAll("[data-testid*=':capability']")).toHaveLength(0);
      expect(row.querySelectorAll("[data-testid$=':load-models']")).toHaveLength(0);
      expect(row.querySelectorAll("[data-testid$=':use-for-chat']")).toHaveLength(0);
    }

    // A runtime-fed row has no endpoint to have synced, so it claims no sync
    // outcome and names what it is offering instead...
    const runtimeRow = screen.getByTestId("llm-tab:connection-subline:codex");
    expect(runtimeRow).toHaveAttribute("data-provider-sync-status", "none");
    expect(runtimeRow).toHaveTextContent("1");
    // ...while the endpoint-fed row reports its handshake on the same line.
    const endpointRow = screen.getByTestId("llm-tab:connection-subline:openai-compatible");
    expect(endpointRow).toHaveAttribute("data-provider-sync-status", "ready");
    expect(endpointRow).toHaveTextContent(`${CUSTOM_ENDPOINT}/models`);

    // And both providers' models are choosable from the one list.
    const ids = await chooserModelIds();
    expect(ids).toContain("codex-mini");
    expect(ids).toContain("qwen-self-hosted");
  });

  it("names a self-hosted row by its card title, not by what its catalogue calls itself", async () => {
    // An OpenAI-compatible server answers `/models` with `owned_by: "openai"`
    // for everything it serves. That is the endpoint's word for its own
    // software; printed beside the model, it makes a self-hosted endpoint read
    // as OpenAI's. The chooser names the row the user connected instead — the
    // same name the card carries.
    const api = genericRowApi(vi.fn().mockResolvedValue({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: ["qwen-self-hosted"],
      modelEntries: [{ id: "qwen-self-hosted", provider: "openai", ownedBy: "openai" }],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult));
    await renderTab(api, { vendor: "openai-compatible", model: "qwen-self-hosted" });

    const card = await screen.findByTestId("llm-tab:connection:openai-compatible:toggle");
    const cardTitle = card.querySelector(".font-medium")?.textContent ?? "";
    expect(cardTitle).not.toBe("");
    expect(await chooserModelIds()).toContain("qwen-self-hosted");

    // The open row, not the collapsed trigger mirroring it.
    const column = within(chooserOption("qwen-self-hosted"))
      .getByTestId("llm-tab:model-provider:qwen-self-hosted");
    expect(column.textContent).toBe(cardTitle);
    expect(chooserGroupText("qwen-self-hosted")).toContain(cardTitle);
  });

  it("names a marketplace preset row by its card title as well", async () => {
    // A preset is reached through the openai-compatible vendor, so its
    // catalogue names itself the same untrustworthy way. The row the user
    // installed is what the column says.
    const gateway = preset("acme-gw", "Acme Gateway", "https://acme.example/v1");
    const { api } = profileApi({
      installedProviderPresets: [gateway],
      modelListCache: {
        [["openai-compatible", gateway.baseUrl, "acme-gw"].join("\n")]: {
          vendor: "openai-compatible",
          baseUrl: gateway.baseUrl,
          credentialScope: "acme-gw",
          endpoint: `${gateway.baseUrl}/models`,
          models: ["acme-large"],
          modelEntries: [{ id: "acme-large", provider: "openai", ownedBy: "openai" }],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }, {
      hasApiKey: storedKeysFor("marketplace-provider:acme-gw"),
      // The cached catalogue is what this reads; a fresh answer would only
      // race it.
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
      marketplaceProviderPresets: [gateway],
      marketplaceProviderPresetId: "acme-gw",
      model: "acme-large",
    });

    expect(await chooserModelIds()).toContain("acme-large");
    const column = within(chooserOption("acme-large"))
      .getByTestId("llm-tab:model-provider:acme-large");
    expect(column.textContent).toBe("Acme Gateway");
  });

  it("keeps an aggregator's sub-vendor on the model it serves", async () => {
    // An aggregator's catalogue IS other companies' models, and its entries
    // say which company serves each one. Printing the row name on every one of
    // them would erase the only thing that tells them apart — so the override
    // that saves a self-hosted row must not reach this list.
    const ROUTED = "anthropic/claude-sonnet-4.6";
    const { api } = profileApi({ installedProviderIds: ["openrouter"] }, {
      hasApiKey: storedKeysFor("openrouter"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/models",
        models: [ROUTED],
        modelEntries: [{
          id: ROUTED,
          provider: "anthropic",
          ownedBy: "anthropic",
          tags: { router: true },
        }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, {
      vendor: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: ROUTED,
    });

    expect(await chooserModelIds()).toContain(ROUTED);
    // The row offers its own saved model before any handshake, and the entry
    // that names the sub-vendor arrives with the catalogue — so the column is
    // read once that has landed.
    await waitFor(() => expect(
      within(chooserOption(ROUTED)).getByTestId(`llm-tab:model-provider:${ROUTED}`).textContent,
    ).toBe("anthropic"));
    // The group is still the row: the list is navigated by provider row, and
    // only the leading column speaks for the individual model.
    expect(chooserGroupText(ROUTED)).toMatch(/OpenRouter/i);
  });
});

/** The shared row's "connected" word, as both locales say it. */
const CONNECTED = /연결됨|Connected/;

describe("LlmTab names each route's state on a row that has two", () => {
  const SIGNED_IN = { runtime: "ready", connection: "connected", models: [] } as const;
  const SUBSCRIPTION = /구독|Subscription/;
  const API_KEY = /API/;
  const SIGNED_OUT = /설정 필요|Setup needed/;
  const NOT_SET = /미설정|Not set/;

  it("says one thing about a provider reached two ways", async () => {
    // The row is one provider reached two ways. Its sign-in is healthy and it
    // holds no key; the row used to be drawn twice, and "connected" and "signed
    // out" side by side described those two routes without saying so — which
    // read as one row contradicting itself.
    installSubscription([codexView({ status: SIGNED_IN })], { refreshStatus: vi.fn() });
    await renderTab(makeApi(), { vendor: "claude", model: "claude-sonnet-4-6" });

    const card = await screen.findByTestId("llm-tab:connection:codex");
    // ONE state word for the row, and it is the usable one: this provider can
    // answer a turn, through the route the badges name.
    const state = within(card).getByTestId("llm-tab:connection:codex:state");
    expect(state).toHaveTextContent(CONNECTED);
    expect(within(card).queryByText(SIGNED_OUT)).toBeNull();
    expect(within(card).queryByText(NOT_SET)).toBeNull();
    expect(within(card).getByTestId("llm-tab:connection-route:codex:subscription"))
      .toHaveTextContent(SUBSCRIPTION);
    expect(within(card).getByTestId("llm-tab:connection-route:codex:api"))
      .toHaveTextContent(API_KEY);
    // ...and exactly one of each control the two cards used to duplicate.
    expect(card.querySelectorAll("[data-testid^='llm-tab:connection-refresh:']")).toHaveLength(1);
    expect(card.querySelectorAll("[data-testid^='llm-tab:connection:'][data-testid$=':state']")).toHaveLength(1);
  });

  it("holds the chevron column steady across rows that have no refresh", async () => {
    // "Nothing lines up" was half the complaint. The chevron is a column, so a
    // row with nothing to refresh still owes the list the width the refreshable
    // rows take — otherwise the disclosure arrow moves as the eye goes down.
    installSubscription([codexView()]);
    const api = genericRowApi(vi.fn().mockResolvedValue(FETCH_FAILED));
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    // Claude's list is curated here, so it has no endpoint to re-ask...
    const curated = screen.getByTestId("llm-tab:connection:claude");
    expect(curated.querySelectorAll('[data-testid^="llm-tab:connection-refresh:"]')).toHaveLength(0);
    // ...and the row still reserves the column the refreshable rows use.
    const heads = [...document.querySelectorAll('[data-connection-row^="llm-tab:connection:"]')]
      .map((row) => row.firstElementChild!.childElementCount);
    expect(new Set(heads).size).toBe(1);
  });

  it("does not call a provider connected over a line saying the sync failed", async () => {
    // The complaint this row was built for: one provider stating a healthy
    // verdict and a failed one at the same instant. Merging the surfaces gave
    // the sync fact one home; the word above it still has to agree with that
    // home, and "on, but not well" is already in the five-word vocabulary, so
    // no sixth word is invented to say it.
    installSubscription([]);
    const api = genericRowApi(vi.fn().mockResolvedValue(FETCH_FAILED));
    await renderTab(api, { vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model: "" });

    const card = await screen.findByTestId("llm-tab:connection:openai-compatible");
    await waitFor(() => expect(
      within(card).getByTestId("llm-tab:connection-subline:openai-compatible"),
    ).toHaveAttribute("data-provider-sync-status", "error"));
    const state = within(card).getByTestId("llm-tab:connection:openai-compatible:state");
    expect(state).toHaveAttribute("data-state", "attention");
    expect(state).not.toHaveTextContent(CONNECTED);
    // Still exactly one statement of the outcome in the whole tab.
    expect(document.querySelectorAll("[data-provider-sync-status]")).toHaveLength(1);
  });

  it("still calls a provider connected when one of its two routes failed to sync", async () => {
    // The other half of the rule above, and the one a real account hits: the
    // sign-in is live, its models are in the chooser, and the SECOND route —
    // the stored API key — cannot fetch a catalogue. Wording the row "needs
    // checking" over that sends someone to repair a provider they are
    // successfully using; the failed route is named on the sub-line instead,
    // which is on screen with the row shut.
    installSubscription([codexView({
      status: {
        runtime: "ready",
        connection: "connected",
        models: [{ id: "codex-mini", label: "codex-mini" }],
      },
    })], { refreshStatus: vi.fn(), useForChat: vi.fn(), useApiForChat: vi.fn() });
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    await renderTab(api, { vendor: "openai", model: "" });

    const card = await screen.findByTestId("llm-tab:connection:codex");
    // The endpoint handshake really did fail, and the row says so on its line.
    await waitFor(() => expect(
      within(card).getByTestId("llm-tab:connection-subline:codex"),
    ).toHaveAttribute("data-provider-sync-status", "error"));
    // ...and the word above it still describes the provider, which works.
    const state = within(card).getByTestId("llm-tab:connection:codex:state");
    expect(state).toHaveAttribute("data-state", "connected");
    expect(state).toHaveTextContent(CONNECTED);
    // The claim that makes "connected" true: this provider is feeding the one
    // chooser right now.
    expect(await chooserModelIds()).toContain("codex-mini");
  });

  it("keeps a row down to the shared five words and says the rest on its line", async () => {
    // A runtime the user has not chosen yet is not a sixth state word. The
    // column has to stay readable straight down against the remote connections
    // list beside it, so the row is worded "setup needed" like any other
    // half-configured connection, and WHICH setup is missing goes to the
    // sub-line, where it has room to be a sentence.
    installSubscription([codexView({
      status: { runtime: "not-configured", connection: "connected", models: [] },
    })]);
    await renderTab(makeApi(), { vendor: "claude", model: "claude-sonnet-4-6" });

    const card = await screen.findByTestId("llm-tab:connection:codex");
    const state = within(card).getByTestId("llm-tab:connection:codex:state");
    expect(state).toHaveTextContent(SIGNED_OUT);
    expect(state).toHaveAttribute("data-state", "needs-setup");
    // The specific answer is on the line, not in a word of its own.
    expect(within(card).getByTestId("llm-tab:connection-subline:codex").textContent?.trim())
      .not.toBe("");
    expect(card.querySelectorAll("[data-testid$=':state']")).toHaveLength(1);
  });

  it("says why a provider is missing from the picker without being opened", async () => {
    // "Why is this one not in the chooser" is a question someone has while the
    // row is folded, so answering it inside the body would put the answer
    // exactly where it cannot be read.
    installSubscription([]);
    const api = genericRowApi(
      vi.fn(() => new Promise<LlmModelListResult>(() => {})),
      CUSTOM_ENDPOINT,
      { hasApiKey: storedKeysFor("claude", "openai-compatible") },
    );
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    const card = await screen.findByTestId("llm-tab:connection:openai-compatible");
    const note = await within(card).findByTestId("llm-tab:connection-blocked:openai-compatible");
    // The row is folded — it has no body at all — and the answer is still there.
    expect(card.querySelector('[data-testid="llm-tab:connection:openai-compatible:detail"]')).toBeNull();
    expect(within(card).getByTestId("llm-tab:connection:openai-compatible:note"))
      .toContainElement(note);
  });

  it("still offers the sign-in a usable provider has not taken", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi({
      hasApiKey: storedKeysFor("openai"),
      // The key has to actually reach something: a stored key over a dead
      // endpoint is "needs attention", and this test is about the healthy case.
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    }), {
      vendor: "claude",
      model: "claude-sonnet-4-6",
    });

    const card = await screen.findByTestId("llm-tab:connection:codex");
    // A stored key that reaches its endpoint makes the provider usable, so
    // that is what the row says.
    await waitFor(() => expect(within(card).getByTestId("llm-tab:connection:codex:state"))
      .toHaveTextContent(CONNECTED));
    // Which route is still unused is a question the expanded row answers, in
    // the only place that can do anything about it.
    fireEvent.click(within(card).getByTestId("llm-tab:connection:codex:toggle"));
    fireEvent.click(await within(card).findByTestId("llm-tab:sign-in-method:codex:subscription"));
    expect(within(card).getByTestId("subscription-provider:codex:login-browser")).toBeInTheDocument();
  });
});

describe("LlmTab asks how to sign in to a provider reached two ways", () => {
  const method = (rowId: string, which: "subscription" | "api") =>
    screen.getByTestId(`llm-tab:sign-in-method:${rowId}:${which}`);

  it.each([
    ["codex", "OpenAI", "ChatGPT", () => codexView()],
    ["claude-code", "Anthropic Claude", "Claude", () => claudeCodeView()],
  ] as const)("%s: chooses nothing until asked, then shows only the chosen method", async (rowId, company, plan, view) => {
    installSubscription([view()], { beginLogin: vi.fn(), refreshStatus: vi.fn() });
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId(`llm-tab:add-provider-item:${rowId}`));
    const card = await screen.findByTestId(`llm-tab:connection:${rowId}`);
    if (within(card).getByTestId(`llm-tab:connection:${rowId}:toggle`).getAttribute("aria-expanded") !== "true") {
      fireEvent.click(within(card).getByTestId(`llm-tab:connection:${rowId}:toggle`));
    }
    expect(card).toHaveTextContent(company);

    // Nothing configured: the card asks, and shows neither a key field nor sign-in.
    expect(method(rowId, "subscription")).toHaveAttribute("aria-checked", "false");
    expect(method(rowId, "api")).toHaveAttribute("aria-checked", "false");
    expect(method(rowId, "subscription")).toHaveAccessibleName(
      t("subscriptionProvidersSection.methodSubscription", { plan }),
    );
    expect(within(card).queryByTestId("llm-api-key-input")).toBeNull();
    expect(within(card).queryByTestId(`subscription-provider:${rowId}:login-browser`)).toBeNull();

    fireEvent.click(method(rowId, "api"));
    expect(await within(card).findByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(within(card).queryByTestId(`subscription-provider:${rowId}`)).toBeNull();

    fireEvent.click(method(rowId, "subscription"));
    expect(within(card).queryByTestId("llm-api-key-input")).toBeNull();
    expect(within(card).getByTestId(`subscription-provider:${rowId}:login-browser`)).toBeInTheDocument();
    // The user never picks the CLI: there is no runtime picker on the card.
    expect(within(card).queryByTestId(`subscription-provider:${rowId}:configure-runtime`)).toBeNull();
    expect(within(card).queryByTestId(`subscription-provider:${rowId}:change-runtime`)).toBeNull();
    expect(within(card).queryByTestId(`subscription-provider:${rowId}:forget-runtime`)).toBeNull();
  });

  it("opens a signed-in subscription on the subscription method, with no key field", async () => {
    installSubscription([codexView({ status: { runtime: "ready", connection: "connected", models: [] } })], { logout: vi.fn() });
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });
    fireEvent.click(await screen.findByTestId("llm-tab:connection:codex:toggle"));
    expect(method("codex", "subscription")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("llm-api-key-input")).toBeNull();
    expect(screen.getByTestId("subscription-provider:codex:logout")).toBeInTheDocument();
  });

  it("keeps a saved key when switching to the subscription, and removes it only on request", async () => {
    installSubscription([codexView()], { beginLogin: vi.fn() });
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    api.deleteApiKey = vi.fn().mockResolvedValue(undefined);
    await renderTab(api, { vendor: "openrouter", model: "" });
    fireEvent.click(await screen.findByTestId("llm-tab:connection:codex:toggle"));
    await waitFor(() => expect(method("codex", "api")).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(method("codex", "subscription"));
    expect(api.deleteApiKey).not.toHaveBeenCalled();
    const note = screen.getByTestId("llm-tab:other-credential:codex:api");
    expect(note).toHaveTextContent(t("subscriptionProvidersSection.otherApiKeySaved"));

    fireEvent.click(within(note).getByTestId("llm-tab:other-credential:codex:remove-api-key"));
    await waitFor(() => expect(api.deleteApiKey).toHaveBeenCalledExactlyOnceWith("openai"));
  });

  it("keeps a signed-in subscription when switching to the API key, and signs out only on request", async () => {
    const logout = vi.fn();
    installSubscription([claudeCodeView({ status: { runtime: "ready", connection: "connected", models: [] } })], { logout });
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });
    fireEvent.click(await screen.findByTestId("llm-tab:connection:claude-code:toggle"));

    fireEvent.click(method("claude-code", "api"));
    expect(await screen.findByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
    const note = screen.getByTestId("llm-tab:other-credential:claude-code:subscription");
    expect(note).toHaveTextContent(t("subscriptionProvidersSection.otherSubscriptionSignedIn", { plan: "Claude" }));

    fireEvent.click(within(note).getByTestId("llm-tab:other-credential:claude-code:sign-out"));
    expect(logout).toHaveBeenCalledExactlyOnceWith("claude-code");
  });

  it("shows install guidance and Check again, not a file picker, when the CLI is missing", async () => {
    const refreshStatus = vi.fn();
    installSubscription([codexView({ status: { runtime: "not-configured", connection: "signed-out", models: [] } })], {
      refreshStatus, configureRuntime: vi.fn(),
    });
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:codex"));
    const card = await screen.findByTestId("llm-tab:connection:codex");
    if (within(card).getByTestId("llm-tab:connection:codex:toggle").getAttribute("aria-expanded") !== "true") {
      fireEvent.click(within(card).getByTestId("llm-tab:connection:codex:toggle"));
    }
    expect(within(card).getByTestId("llm-tab:connection-subline:codex"))
      .toHaveTextContent(t("subscriptionProvidersSection.statusCliNotFound"));
    expect(within(card).getByTestId("llm-tab:connection:codex:state"))
      .toHaveTextContent(t("connectionRow.stateNeedsSetup"));
    fireEvent.click(method("codex", "subscription"));
    expect(within(card).getByTestId("subscription-provider:codex:install-guidance"))
      .toHaveTextContent(t("subscriptionProvidersSection.installGuidance", { cli: "Codex CLI", plan: "ChatGPT" }));
    expect(within(card).queryByTestId("subscription-provider:codex:configure-runtime")).toBeNull();
    fireEvent.click(within(card).getByTestId("subscription-provider:codex:check-again"));
    expect(refreshStatus).toHaveBeenCalledWith("codex");
  });

  it("words a Claude plan with no CLI found as needing setup, though its account is unknown", async () => {
    installSubscription([claudeCodeView({ status: { runtime: "not-configured", connection: "unknown", models: [] } })]);
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude-code"));
    expect(await screen.findByTestId("llm-tab:connection:claude-code:state"))
      .toHaveTextContent(t("connectionRow.stateNeedsSetup"));
  });

  it("does not hold a working API-key provider back on a CLI that is not installed", async () => {
    installSubscription([codexView({ status: { runtime: "not-configured", connection: "signed-out", models: [] } })]);
    await renderTab(makeApi({
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    }), { vendor: "openai", model: "gpt-5", hasKey: true });
    const card = await screen.findByTestId("llm-tab:connection:codex");
    await waitFor(() => expect(within(card).getByTestId("llm-tab:connection:codex:state")).toHaveTextContent(CONNECTED));
    expect(card).not.toHaveTextContent(t("subscriptionProvidersSection.statusCliNotFound"));
  });

  it("keeps the key form on screen after the key it was opened for is deleted", async () => {
    installSubscription([codexView()]);
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    api.deleteApiKey = vi.fn().mockResolvedValue(undefined);
    await renderTab(api, { vendor: "openrouter", model: "" });
    fireEvent.click(await screen.findByTestId("llm-tab:connection:codex:toggle"));
    await waitFor(() => expect(method("codex", "api")).toHaveAttribute("aria-checked", "true"));
    api.hasApiKey = vi.fn().mockResolvedValue(false);
    fireEvent.click(within(screen.getByTestId("llm-tab:manual-section")).getByRole("button", { name: t("llmTab.delete") }));
    await waitFor(() => expect(api.deleteApiKey).toHaveBeenCalledWith("openai"));
    await waitFor(() => expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(t("llmTab.apiKeyNotSet")));
    expect(method("codex", "api")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
  });

  it("offers each company once in 'add a provider', and never a runtime by name", async () => {
    installSubscription([codexView(), claudeCodeView()]);
    await renderTab(makeApi(), { vendor: "openrouter", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    await screen.findByTestId("llm-tab:add-provider-item:codex");
    const labels = screen.getAllByTestId(/^llm-tab:add-provider-item:/).map((item) => item.textContent ?? "");
    expect(labels).toContain("OpenAI");
    expect(labels).toContain("Anthropic Claude");
    expect(labels.filter((label) => label === "Anthropic Claude")).toHaveLength(1);
    expect(labels.filter((label) => label === "OpenAI")).toHaveLength(1);
    expect(labels.join("\n")).not.toMatch(/Codex|Claude Code/);
    // The Anthropic API vendor is that row's API-key method, not a second row.
    expect(screen.queryByTestId("llm-tab:add-provider-item:claude")).toBeNull();
  });
});

describe("LlmTab preset and generic custom provider are separate rows", () => {
  // A preset that ships its own model list, so the row has something to offer
  // before any endpoint has answered.
  const acme = preset("acme-gw", "Acme Gateway", "https://acme.example/v1", "static");
  const GENERIC_ENDPOINT = "http://localhost:8001/v1";

  /** A preset is the active route; the generic row has its own saved endpoint. */
  function bothRows() {
    return makeApi({
      hasApiKey: storedKeysFor("marketplace-provider:acme-gw", "openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: GENERIC_ENDPOINT, model: "local-model" } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [acme] },
      }),
    });
  }

  const activePreset = {
    vendor: "openai-compatible",
    marketplaceProviderPresetId: "acme-gw",
    marketplaceProviderPresets: [acme],
    model: "acme-gw-default",
  } as const;

  it("opens the generic card on the generic endpoint, not the active preset's", async () => {
    await renderTab(bothRows(), activePreset);

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));

    const field = screen.getByTestId("llm-base-url-input");
    expect(field).toHaveValue(GENERIC_ENDPOINT);
    expect(field).not.toHaveValue(acme.baseUrl);
  });

  it("offers a preset's models under its own name and selects the preset on the pick", async () => {
    const { hooks, rerender } = await renderTab(bothRows(), {
      vendor: "openai-compatible",
      marketplaceProviderPresets: [acme],
      model: "local-model",
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:acme-gw");
    expect(await chooserModelIds()).toContain("acme-gw-default");
    // Two presets are two providers reached through one vendor, so the name on
    // the group has to be the preset's, not the vendor's.
    expect(chooserGroupText("acme-gw-default")).toMatch(/Acme Gateway/);

    pickChooserOption("acme-gw-default");

    await waitFor(() => expect(hooks.onSelectMarketplaceProviderPreset).toHaveBeenCalledWith(acme));
    expect(hooks.onImmediateChange).toHaveBeenCalled();

    // The parent moves the active route; the badge follows it, not the form.
    await rerender(activePreset);
    expect(screen.getByTestId("llm-tab:connection-route:marketplace-provider:acme-gw:api"))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("llm-tab:connection-route:openai-compatible:api"))
      .toHaveAttribute("data-active", "false");
  });

  it("drops the preset when the generic row's own model is picked, endpoint intact", async () => {
    const { hooks, rerender } = await renderTab(bothRows(), activePreset);

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    expect(await chooserModelIds()).toContain("local-model");

    pickChooserOption("local-model");

    // The generic custom provider IS this vendor without a preset.
    await waitFor(() => expect(hooks.onClearMarketplaceProviderPreset).toHaveBeenCalled());
    expect(hooks.selectApiVendorModel).toHaveBeenCalledWith("openai-compatible", "local-model");
    expect(hooks.onImmediateChange).toHaveBeenCalled();

    await rerender({
      vendor: "openai-compatible",
      marketplaceProviderPresetId: "",
      model: "local-model",
    });
    expect(screen.getByTestId("llm-tab:connection-route:openai-compatible:api"))
      .toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    // The endpoint the user saved is still the generic row's own.
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(GENERIC_ENDPOINT);
  });
});

describe("LlmTab chat-route availability", () => {
  it("asks Vertex for a project rather than a key it never stores", async () => {
    // Vertex authenticates out of band, so the key question can never be
    // satisfied on this card — it used to leave the row permanently unusable.
    const withoutProject = makeApi({
      hasApiKey: storedKeysFor("claude"),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: { installedProviderIds: ["vertex-ai"], installedProviderPresets: [] },
      }),
    });
    const { unmount } = await renderTab(withoutProject, { vendor: "claude", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:vertex-ai"));

    // The card asks for the project, and says that is what is missing.
    expect(screen.getByTestId("llm-tab:manual-section")).toBeInTheDocument();
    expect(screen.queryByTestId("llm-api-key-input")).toBeNull();
    expect(screen.getByTestId("llm-tab:connection-blocked:vertex-ai"))
      .toHaveTextContent(/GCP|프로젝트|project|Projekt|proyecto|projet|プロジェクト|项目/i);
    // And nothing of Vertex's is choosable while it cannot answer.
    expect((await chooserModelIds()).some((id) => id.startsWith("gemini"))).toBe(false);
    unmount();

    const withProject = makeApi({
      hasApiKey: storedKeysFor("claude"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "vertex-ai": { vertexProject: "my-gcp-project" } },
        },
        marketplace: { installedProviderIds: ["vertex-ai"], installedProviderPresets: [] },
      }),
    });
    const { hooks } = await renderTab(withProject, { vendor: "claude", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:vertex-ai"));

    await waitFor(() =>
      expect(screen.queryByTestId("llm-tab:connection-blocked:vertex-ai")).toBeNull());
    // With the project stored the row is choosable like any other — through
    // the one chooser, with no second control of its own.
    expect(await chooserModelIds()).toContain("gemini-3.5-flash");
    expect(chooserGroupText("gemini-3.5-flash")).toMatch(/Vertex/i);

    pickChooserOption("gemini-3.5-flash");
    await waitFor(() => expect(hooks.selectApiVendorModel)
      .toHaveBeenCalledWith("vertex-ai", "gemini-3.5-flash"));
  });
});

describe("LlmTab rows that are not the active one", () => {
  const acme = preset("acme-gw", "Acme Gateway", "https://acme.example/v1");
  const zenith = preset("zenith-gw", "Zenith Gateway", "https://zenith.example/v1");

  it("syncs a credentialed row against its OWN endpoint and offers what it answers", async () => {
    // The regression: the catalogue sync only ever carried the ACTIVE route's
    // address, so a configured generic custom provider that was not the active
    // one synced against nothing — its models could never land, and a provider
    // the user had fully set up was absent from the only switch there is.
    const api = genericRowApi(
      vi.fn(async (request: { vendor: string; baseUrl?: string }) =>
        request.vendor === "openai-compatible" && request.baseUrl === CUSTOM_ENDPOINT
          ? {
            ok: true,
            vendor: "openai-compatible",
            endpoint: `${CUSTOM_ENDPOINT}/models`,
            models: ["served-by-the-endpoint"],
            fetchedAt: "2026-01-01T00:00:00.000Z",
          } satisfies LlmModelListResult
          : FETCH_FAILED),
      CUSTOM_ENDPOINT,
      { hasApiKey: storedKeysFor("claude", "openai-compatible") },
    );
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT }),
    ));
    await waitFor(async () =>
      expect(await chooserModelIds()).toContain("served-by-the-endpoint"));
    expect(chooserGroupText("served-by-the-endpoint")).not.toMatch(/Claude/);
  });

  it("says a credentialed row has nothing to choose until its endpoint answers", async () => {
    const api = genericRowApi(
      vi.fn(() => new Promise<LlmModelListResult>(() => {})),
      CUSTOM_ENDPOINT,
      { hasApiKey: storedKeysFor("claude", "openai-compatible") },
    );
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    // The card says why it is not in the list, rather than looking ready while
    // the chooser silently omits it.
    const note = await screen.findByTestId("llm-tab:connection-blocked:openai-compatible");
    expect(note.textContent?.trim()).not.toBe("");
    expect((await chooserModelIds()).every((id) => id.startsWith("claude"))).toBe(true);
  });

  it("reads each preset row's own stored model, never another row's", async () => {
    // Every one of these rows is reached through the openai-compatible vendor.
    // They used to share that block's single `model`, so the chooser showed the
    // same id under all three names.
    const api = makeApi({
      hasApiKey: storedKeysFor(
        "claude",
        "marketplace-provider:acme-gw",
        "marketplace-provider:zenith-gw",
        "openai-compatible",
      ),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: {
            "openai-compatible": {
              baseUrl: CUSTOM_ENDPOINT,
              model: "generic-own-model",
              presetModels: { "acme-gw": "acme/chosen", "zenith-gw": "zenith/chosen" },
            },
          },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [acme, zenith] },
      }),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [acme, zenith],
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:acme-gw");
    const offered = await chooserModelIds();
    expect(offered).toContain("acme/chosen");
    expect(offered).toContain("zenith/chosen");
    expect(offered).toContain("generic-own-model");
    expect(chooserGroupText("acme/chosen")).toMatch(/Acme Gateway/);
    expect(chooserGroupText("zenith/chosen")).toMatch(/Zenith Gateway/);
  });

  it("points at the model list after a save instead of switching to what was saved", async () => {
    // The user's decision: saving a credential never moves the conversation,
    // not even when the provider it is on cannot answer. What the save owes is
    // the pointer to the one switch there is.
    const api = makeApi({ hasApiKey: storedKeysFor() });
    const { hooks } = await renderTab(api, { vendor: "openai", hasKey: false, model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), {
      target: { value: "sk-ant-new" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await screen.findByTestId("llm-tab:connection-pick-model:claude");
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onSelectMarketplaceProviderPreset).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
  });
});

describe("LlmTab asks only the rows that have a catalogue to give", () => {
  /** Every endpoint the tab actually asked for a model list, in call order. */
  function requestedEndpoints(api: MockApi): string[] {
    return (api.listLlmModels as Mock<(request: {
      vendor: string; baseUrl?: string;
    }) => unknown>).mock.calls
      .map(([request]) => request.baseUrl ?? `<fixed:${request.vendor}>`);
  }

  it("asks a paired vendor's fixed endpoint, since a stored key makes it an API row too", async () => {
    // OpenAI's `/models` is fixed and known, so a stored key is all it takes to
    // ask — the card is the Codex runtime's AND a configured API route's, and
    // the API half is entitled to its own catalogue. What must not happen is
    // that call being reported on a card with no API route: see
    // "keeps a subscription card free of a sync line…" above.
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView()]);
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6", hasKey: false });

    await waitFor(() => expect(rowOrder()).toEqual(["codex"]));
    await settleModelListRequests();
    expect(requestedEndpoints(api)).toEqual(["<fixed:openai>"]);
  });

  it("keeps a subscription card free of a sync line for an API path it has not configured", async () => {
    // The card borrows its API counterpart's cache key, so whatever is filed
    // under that key — here the active route's own "no credential stored"
    // answer — would otherwise be printed on a signed-in runtime's card as if
    // the runtime had made that call.
    const api = makeApi({ hasApiKey: storedKeysFor() });
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: false });

    await settleModelListRequests();

    expect(rowOrder()).toEqual(["codex"]);
    // The row's line reports no sync outcome at all for a route it has not
    // configured; it names what the signed-in runtime offers instead.
    expect(screen.getByTestId("llm-tab:connection-subline:codex"))
      .toHaveAttribute("data-provider-sync-status", "none");
  });

  it("asks nothing of a vendor whose model list is curated here", async () => {
    // Azure AI Foundry's endpoint is one deployment's address, not a catalogue,
    // and its models are the bundled list — so there is nothing to ask it for.
    const api = makeApi({
      hasApiKey: storedKeysFor("azure-foundry"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "azure-foundry": { baseUrl: "https://example-resource.example/deployments/gpt" } },
        },
        marketplace: { installedProviderIds: ["azure-foundry"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await screen.findByTestId("llm-tab:connection:azure-foundry");
    await settleModelListRequests();
    expect(requestedEndpoints(api)).toEqual([]);
    // And its curated models are still choosable, so nothing was lost.
    expect(await chooserModelIds()).toContain("gpt-5.4-mini");
  });

  it("asks a preset that declares its models nothing, and one that does not for its list", async () => {
    const declared = preset("declared-gw", "Declared Gateway", "https://declared.example/v1", "static");
    const asked = preset("asked-gw", "Asked Gateway", "https://asked.example/v1");
    const api = makeApi({
      hasApiKey: storedKeysFor(
        "marketplace-provider:declared-gw",
        "marketplace-provider:asked-gw",
      ),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: {
          installedProviderIds: [],
          installedProviderPresets: [declared, asked],
        },
      }),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [declared, asked],
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:declared-gw");
    await waitFor(() => expect(requestedEndpoints(api)).toEqual(["https://asked.example/v1"]));
    // The declaring preset needs no handshake to be choosable.
    expect(await chooserModelIds()).toContain("declared-gw-default");
  });

  it("asks a credentialed custom provider for the list at its own endpoint", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(requestedEndpoints(api)).toEqual([CUSTOM_ENDPOINT]));
  });

  it("asks nothing for a row with no credential, and says that is what is missing", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor(),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: { installedProviderIds: ["openrouter"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    for (const vendorId of ["openrouter", "gemini", "openai"]) {
      openMenu(screen.getByTestId("llm-tab:add-provider"));
      fireEvent.click(await screen.findByTestId(`llm-tab:add-provider-item:${vendorId}`));
      expect(screen.getByTestId(`llm-tab:connection-blocked:${vendorId}`))
        .toHaveTextContent(/키|key|Schlüssel|clave|clé|キー|密钥/i);
    }
    await settleModelListRequests();
    expect(requestedEndpoints(api)).toEqual([]);
  });
});

describe("LlmTab says which kind of nothing a row has", () => {
  const NOT_ASKED = /아직|yet|noch|Aún|encore|まだ|暂无/i;
  const EMPTY = /비어|empty|leere|vacía|vide|空/i;
  const FAILED = /못했습니다|Could not|konnte nicht|No se pudo|Impossible|できませんでした|无法/i;

  const genericRow = genericRowApi;

  async function blockerText(): Promise<string> {
    const note = await screen.findByTestId("llm-tab:connection-blocked:openai-compatible");
    return note.textContent ?? "";
  }

  it("says the list has not been asked for when the row has no endpoint yet", async () => {
    const api = genericRow(undefined, "");
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    expect(await blockerText()).toMatch(NOT_ASKED);
    await settleModelListRequests();
    expect(api.listLlmModels).not.toHaveBeenCalled();
  });

  it("says the same while the endpoint has been asked and has not answered", async () => {
    const api = genericRow(vi.fn(() => new Promise<LlmModelListResult>(() => {})));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalled());
    expect(await blockerText()).toMatch(NOT_ASKED);
  });

  it("says the list could not be read when the handshake failed", async () => {
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
  });

  it("says the list came back empty when the endpoint answered with none", async () => {
    const api = genericRow(vi.fn(async () => ({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult)));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(EMPTY));
  });

  it("says it on the ACTIVE row too, whose own catalogue came back empty", async () => {
    // The row chat is running on is the one where an empty list matters most:
    // with no model saved there is nothing to send, and "has not answered yet"
    // would be the wrong account of an endpoint that answered with nothing.
    const api = genericRow(vi.fn(async () => ({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult)));
    await renderTab(api, {
      vendor: "openai-compatible",
      baseUrl: CUSTOM_ENDPOINT,
      model: "",
    });

    await waitFor(async () => expect(await blockerText()).toMatch(EMPTY));
  });

  function broadcast(api: MockApi, vendors: Record<string, unknown>) {
    const handler = (api.onSettingsUpdated as Mock).mock.calls.at(-1)?.[0] as
      ((s: unknown) => void) | undefined;
    expect(handler).toBeTruthy();
    return (async () => {
      await act(async () => {
        handler!({
          llm: { provider: "claude", pinnedModels: [], modelListCache: {}, vendors },
          marketplace: { installedProviderIds: [], installedProviderPresets: [] },
        });
        await Promise.resolve();
      });
      // Separate acts, so the effects the broadcast queued are mounted before
      // their requests are waited on — inside one act they would not be.
      await settleModelListRequests();
    })();
  }

  it("does not ask a failed endpoint again on a broadcast that changed nothing", async () => {
    // Every settings write broadcasts one of these, and a fresh object identity
    // each time re-ran every effect reading a row's endpoint — including the
    // one that asks endpoints for their catalogues.
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
    const asked = (api.listLlmModels as Mock).mock.calls.length;

    await broadcast(api, { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(asked);
  });

  it("does not re-ask an endpoint mid-handshake when a broadcast changed nothing", async () => {
    // The broadcast carries the same vendor content, so nothing about this row
    // moved. A fresh object identity for the vendor map on every settings write
    // was enough to re-run the sync and ask again while the first ask was
    // still in flight.
    const api = genericRow(vi.fn(() => new Promise<LlmModelListResult>(() => {})));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect((api.listLlmModels as Mock).mock.calls.length).toBe(1));

    await broadcast(api, { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(1);
  });

  it("does not ask a failed endpoint again when some other row changes", async () => {
    // Here the broadcast IS news — another vendor's block moved — so the effect
    // legitimately re-runs. This row's own inputs did not change, and a failure
    // is an answer: re-asking on someone else's edit is how one unreachable
    // endpoint became a request per settings write.
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
    const asked = (api.listLlmModels as Mock).mock.calls.length;

    await broadcast(api, {
      "openai-compatible": { baseUrl: CUSTOM_ENDPOINT },
      ollama: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(asked);
  });
});

describe("LlmTab model lists are cached, not re-fetched", () => {
  const gateway = preset("acme-gw", "Acme Gateway", "https://acme.example/v1");
  const GATEWAY_SECRET = "marketplace-provider:acme-gw";
  const CACHED_MODEL = "cached-from-the-endpoint";
  const genericKey = ["openai-compatible", CUSTOM_ENDPOINT, ""].join("\n");
  const AZURE_ENDPOINT = "https://example-resource.example/deployments/gpt";

  /** This block's profile, with its gateway preset installed throughout. */
  const presetProfile = (profile: Profile, rest: MockApi = {}) =>
    profileApi({ ...profile, installedProviderPresets: [gateway] }, rest);

  function cacheEntry(baseUrl: string, models: string[], credentialScope?: string) {
    return {
      vendor: "openai-compatible",
      baseUrl,
      ...(credentialScope ? { credentialScope } : {}),
      endpoint: `${baseUrl}/models`,
      models,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  /** An endpoint that answers, so a request can be told from a cache read. */
  function answering(models: string[]) {
    return vi.fn(async (request: { vendor: string; baseUrl?: string }) => ({
      ok: true,
      vendor: request.vendor,
      endpoint: `${request.baseUrl ?? ""}/models`,
      models,
      fetchedAt: "2026-02-02T00:00:00.000Z",
    } satisfies LlmModelListResult));
  }

  function askedCount(api: MockApi): number {
    return (api.listLlmModels as Mock).mock.calls.length;
  }

  function askedAddresses(api: MockApi): string[] {
    return (api.listLlmModels as Mock).mock.calls
      .map(([request]) => (request as { baseUrl?: string }).baseUrl ?? "");
  }

  it("renders the cached catalogue without waiting on a request", async () => {
    // A model list is a catalogue, not live data. A chooser that blanks itself
    // until a network call returns is what this policy exists to remove: the
    // request below never resolves, and the list is still there.
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    expect(await chooserModelIds()).toContain(CACHED_MODEL);
  });

  it("asks nothing when the settings tab is opened again in the same launch", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    const first = await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));
    first.unmount();

    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await settleModelListRequests();

    // Leaving the settings tab and coming back is not a new launch.
    expect(askedCount(api)).toBe(1);
  });

  it("asks each routed row exactly once when the app runs again", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT }, "azure-foundry": { baseUrl: AZURE_ENDPOINT } },
      installedProviderIds: ["azure-foundry"],
      modelListCache: {
        [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]),
        [["openai-compatible", gateway.baseUrl, gateway.providerId].join("\n")]:
          cacheEntry(gateway.baseUrl, ["gateway-model"], gateway.providerId),
      },
    }, {
      hasApiKey: storedKeysFor("openai-compatible", GATEWAY_SECRET, "azure-foundry"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    // The marker is per launch and lives in the module, so a test crosses that
    // boundary by forgetting it — which is the whole of what a restart does.
    forgetModelListLaunchRefreshes();
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [gateway],
    });

    await waitFor(() => expect(askedCount(api)).toBe(2));
    await settleModelListRequests();
    // The two routed rows, once each — and never Foundry, whose list is
    // curated here however its endpoint is configured.
    expect(askedAddresses(api).sort()).toEqual([CUSTOM_ENDPOINT, gateway.baseUrl].sort());
  });

  it("asks once more when a row's endpoint moves", async () => {
    const MOVED = "http://localhost:31000/v1";
    const { api, broadcast } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    await broadcast({ "openai-compatible": { baseUrl: MOVED } });

    // A different address is a different catalogue, and no cache entry names
    // this one yet.
    await waitFor(() => expect(askedCount(api)).toBe(2));
    expect((api.listLlmModels as Mock).mock.calls.at(-1)?.[0]).toMatchObject({ baseUrl: MOVED });
  });

  it("asks nothing when a broadcast says the same thing in a different order", async () => {
    const { api, broadcast } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, enableThinking: true } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    // The same block with its keys written the other way round: identical
    // settings, which a serialized comparison would have called news.
    await broadcast({ "openai-compatible": { enableThinking: true, baseUrl: CUSTOM_ENDPOINT } });

    expect(askedCount(api)).toBe(1);
  });

  it("asks again when the card's refresh is pressed, cached or not", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL, "and-a-new-one"]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    fireEvent.click(screen.getByTestId("llm-tab:connection-refresh:openai-compatible"));

    // The press is the one thing that lifts both the cache and the marker.
    await waitFor(() => expect(askedCount(api)).toBe(2));
    expect(await chooserModelIds()).toContain("and-a-new-one");
  });

  it("asks a fixed-endpoint vendor once when its card and the fallback chain both want it", async () => {
    // A vendor with no endpoint of its own is asked whether it holds a key
    // before anything is fetched, and its card and the fallback chain want the
    // same catalogue. One list, one request, however many callers want it.
    const { api } = presetProfile({}, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: answering(["gpt-from-the-endpoint"]),
    });
    // The credential store answers before the settings read does, which is the
    // interleaving that puts both callers in one commit: the row is already
    // known to hold a key when `settingsLoaded` flips, so the card's refresh
    // and the fallback panel's both run off that same flush.
    const readSettings = api.getSettings as Mock;
    api.getSettings = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return readSettings();
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      fallbackOpen: true,
      fallbackChain: [{ provider: "openai", model: "gpt-from-the-endpoint" }],
    });

    await waitFor(() => expect(askedCount(api)).toBeGreaterThan(0));
    await settleModelListRequests();
    expect(askedCount(api)).toBe(1);
  });

  it("asks a fixed-endpoint vendor once when its refresh is pressed twice in a row", async () => {
    // Such a vendor is asked whether it holds a key before anything is
    // fetched. A second press landing during that question is the same
    // request, and the answer to the first is the answer to both.
    const { api } = presetProfile({}, {
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: answering(["gpt-from-the-endpoint"]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai"))
      .toHaveAttribute("data-provider-sync-status", "ready"));
    expect(askedCount(api)).toBe(1);

    const refresh = screen.getByTestId("llm-tab:connection-refresh:openai");
    fireEvent.click(refresh);
    fireEvent.click(refresh);

    await waitFor(() => expect(askedCount(api)).toBe(2));
    await settleModelListRequests();
    expect(askedCount(api)).toBe(2);
  });

  it("shows no sync on a keyless row while the credential store is still answering", async () => {
    // The in-flight claim is taken before the credential question, but the
    // visible "syncing" state is not: a row with nothing stored makes no
    // request, and must not look for a moment as if it had.
    const { api } = presetProfile({}, {
      hasApiKey: vi.fn(() => new Promise<boolean>(() => {})),
    });
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { model: "", hasKey: false });

    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("openai"));
    await settleModelListRequests();
    expect(askedCount(api)).toBe(0);
    expect(document.querySelector("[data-provider-sync-status=\"loading\"]")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("offers a refresh only on the cards that have a list to refresh", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT }, "azure-foundry": { baseUrl: AZURE_ENDPOINT } },
      installedProviderIds: ["azure-foundry"],
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible", "azure-foundry", "claude"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await screen.findByTestId("llm-tab:connection:azure-foundry");
    expect(screen.getByTestId("llm-tab:connection-refresh:openai-compatible")).toBeInTheDocument();
    // A curated list has no endpoint to ask, so there is nothing to offer.
    expect(screen.queryByTestId("llm-tab:connection-refresh:azure-foundry")).toBeNull();
    // The native model-list address is fixed, so a keyed card can sync it.
    expect(screen.getByTestId("llm-tab:connection-refresh:claude")).toBeInTheDocument();
  });

  it("asks a row again once its credential is replaced", async () => {
    // The cache key is built from vendor, address and scope — never from the
    // credential — so a key stored over a broken one changes nothing the key
    // can see, and the launch marker alone would hold the row on its failure.
    let answer: LlmModelListResult = FETCH_FAILED;
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn(async () => answer),
    });
    const { hooks } = await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai-compatible"))
      .toHaveAttribute("data-provider-sync-status", "error"));
    expect(askedCount(api)).toBe(1);

    answer = {
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: ["works-now"],
      fetchedAt: "2026-03-03T00:00:00.000Z",
    };
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    fireEvent.click(screen.getByTestId("llm-tab:api-key-reveal"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), { target: { value: "sk-fixed" } });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await waitFor(() => expect(hooks.onSaveProviderCredential).toHaveBeenCalled());
    await waitFor(() => expect(askedCount(api)).toBe(2));
    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai-compatible"))
      .toHaveAttribute("data-provider-sync-status", "ready"));
  });

  it("lands a fetched list where the fallback chain reads it", async () => {
    // The write went to `vendor\n<address>\n` and the read looked under
    // `vendor\n\n`, so a vendor with an address of its own offered the
    // fallback dropdown nothing however well its endpoint had answered.
    const { api } = presetProfile({
      installedProviderIds: ["openrouter"],
    }, {
      hasApiKey: storedKeysFor("openrouter"),
      listLlmModels: answering(["router/one", "router/two"]),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      fallbackOpen: true,
      fallbackChain: [{ provider: "openrouter", model: "router/one" }],
    });

    await waitFor(() => expect(askedCount(api)).toBeGreaterThan(0));
    const section = screen.getByTestId("fallback-chain-section");
    const triggers = [...section.querySelectorAll<HTMLElement>("[role='combobox']")];
    openMenu(triggers[triggers.length - 1]!);

    await waitFor(() => {
      const offered = [...document.querySelectorAll<HTMLElement>("[role='option'] [data-model-id]")]
        .map((node) => node.getAttribute("data-model-id"));
      expect(offered).toContain("router/two");
    });
  });

  it("ignores a cache entry filed under an address the row no longer uses", async () => {
    // An older build filed this vendor's catalogue under a different address.
    // Binding the row to that entry left it reading a key nothing writes any
    // more — an old catalogue with no way to refresh.
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: {
        [["openai-compatible", "http://stale.invalid/v1", ""].join("\n")]:
          cacheEntry("http://stale.invalid/v1", ["from-the-old-address"]),
      },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering(["from-the-current-address"]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(askedCount(api)).toBeGreaterThan(0));
    expect(askedAddresses(api)).toContain(CUSTOM_ENDPOINT);
    expect(askedAddresses(api)).not.toContain("http://stale.invalid/v1");
    const offered = await chooserModelIds();
    expect(offered).toContain("from-the-current-address");
    expect(offered).not.toContain("from-the-old-address");
  });
});

describe("LlmTab marketplace preset rows", () => {
  const presets = [
    preset("acme-gw", "Acme Gateway", "https://acme.example/v1"),
    preset("bolt-gw", "Bolt Gateway", "https://bolt.example/v1"),
  ] as const;

  async function addBothPresets(api: MockApi) {
    await renderTab(api, {
      vendor: "openai-compatible",
      marketplaceProviderPresets: presets,
      model: "",
      hasKey: false,
    });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:acme-gw"));
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw"));
  }

  it("gives each installed preset its own named card", async () => {
    await addBothPresets(makeApi());

    expect(screen.getByTestId("llm-tab:connection:marketplace-provider:acme-gw"))
      .toHaveTextContent("Acme Gateway");
    expect(screen.getByTestId("llm-tab:connection:marketplace-provider:bolt-gw"))
      .toHaveTextContent("Bolt Gateway");
    expect(rowOrder()).toEqual(["marketplace-provider:acme-gw", "marketplace-provider:bolt-gw"]);
  });

  it("drops an added preset out of the add menu", async () => {
    await addBothPresets(makeApi());

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    await screen.findByTestId("llm-tab:add-provider-item:claude");
    expect(screen.queryByTestId("llm-tab:add-provider-item:marketplace-provider:acme-gw")).toBeNull();
    expect(screen.queryByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw")).toBeNull();
  });

  it("reports each preset's handshake on its own card", async () => {
    const api = makeApi({
      // The launch refresh confirms the cached catalogue, so the endpoint
      // answers here; a failure would leave the row on its cached list and say
      // so, which is a different test.
      listLlmModels: vi.fn(async () => ({
        ok: true,
        vendor: "openai-compatible",
        endpoint: "https://acme.example/v1/models",
        models: ["acme-1", "acme-2"],
        fetchedAt: "2026-01-02T00:00:00.000Z",
      } satisfies LlmModelListResult)),
      getSettings: settingsWithCache({
        [["openai-compatible", "https://acme.example/v1", "acme-gw"].join("\n")]: {
          vendor: "openai-compatible",
          baseUrl: "https://acme.example/v1",
          credentialScope: "acme-gw",
          endpoint: "https://acme.example/v1/models",
          models: ["acme-1", "acme-2"],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
      marketplaceProviderPresets: presets,
      model: "",
      hasKey: false,
    });
    // Acme's catalogue landed, so its row is already there; only Bolt is left
    // to add — and the two must not share one set of facts.
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw"));

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:marketplace-provider:acme-gw"))
        .toHaveAttribute("data-provider-sync-status", "ready");
    });
    expect(screen.queryByTestId("llm-tab:connection-subline:marketplace-provider:bolt-gw")).toBeNull();
  });
});

describe("LlmTab unsaved provider input", () => {
  it("keeps Save unavailable until a field actually changes", async () => {
    const saved = { baseUrl: "http://localhost:8001/v1" };
    await renderTab(
      makeApi({ getSettings: settingsWithVendorBlocks({ "openai-compatible": saved }) }),
      { vendor: "openai-compatible", model: "local-model" },
    );
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    // Opened on the stored endpoint, so there is nothing to commit yet.
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeDisabled());

    fireEvent.change(screen.getByTestId("llm-base-url-input"), {
      target: { value: "http://localhost:9999/v1" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
  });

  it("keeps a card with uncommitted input on screen and marks it when collapsed", async () => {
    // Nothing was added and nothing is configured: this row exists only
    // because the draft does — which is the part that survives a remount.
    await renderTab(makeApi(), {
      vendor: "claude",
      hasKey: false,
      draft: keyDraft("claude", "claude", "sk-ant-typed"),
      model: "",
    });

    expect(screen.getByTestId("llm-tab:connection:claude")).toBeInTheDocument();
    // Collapsed, but not silent about what it is holding.
    expect(screen.getByTestId("llm-tab:connection-unsaved:claude")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection:claude:toggle"));
    expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled();
    expect(screen.queryByTestId("llm-tab:connection-unsaved:claude")).toBeNull();
  });
});

describe("LlmTab OpenAI model catalogue", () => {
  it("offers the endpoint's catalogue rather than the bundled list", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-from-endpoint"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { model: "" });

    await waitFor(() => {
      expect(api.listLlmModels).toHaveBeenCalledWith({ vendor: "openai" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:openai"))
        .toHaveAttribute("data-provider-sync-status", "ready");
    });
    expect(screen.getByTestId("llm-tab:connection-subline:openai"))
      .toHaveTextContent("https://api.openai.com/v1/models");
    expect(screen.getByTestId("llm-tab:connection-subline:openai")).toHaveTextContent("1");

    openMenu(screen.getByTestId(TEST_IDS.llmModelSelect));
    await screen.findByText("gpt-from-endpoint");
    // The bundled catalogue is metadata, never the list: none of its ids may
    // appear once the endpoint has answered.
    expect(document.querySelector("[data-model-id=\"gpt-5.4\"]")).toBeNull();
    expect(document.querySelector("[data-model-id=\"o3\"]")).toBeNull();
  });

  it("says the handshake failed instead of standing in a bundled list", async () => {
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { model: "" });

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:openai"))
        .toHaveAttribute("data-provider-sync-status", "error");
    });
    // A failed handshake reads as a failure, never as a short catalogue.
    expect(screen.getByTestId("llm-tab:connection-subline:openai")).not.toHaveTextContent(/\d+/);
  });

  it("names the endpoint and its catalogue on the row once the endpoint has answered", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai"),
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-from-endpoint"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { model: "" });

    // ONE telling of the handshake per row: the sub-line names the endpoint it
    // reached and what came back. The head used to carry a dot saying the same
    // thing a second time, computed separately.
    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai"))
      .toHaveAttribute("data-provider-sync-status", "ready"));
    const subline = screen.getByTestId("llm-tab:connection-subline:openai");
    expect(subline).toHaveTextContent("https://api.openai.com/v1/models");
    expect(subline.textContent).toMatch(/1 models synced|모델 1개 동기화됨/);
  });

  it("says on the row when the handshake failed", async () => {
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { model: "" });

    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai"))
      .toHaveAttribute("data-provider-sync-status", "error"));
    expect(screen.getByTestId("llm-tab:connection-subline:openai").textContent)
      .toMatch(/could not be synced|동기화하지 못했습니다/);
  });

  it("says nothing anywhere while no handshake has been made", async () => {
    // No key is stored, so nothing was asked. An unasked question has no
    // answer to report — not on the card, and not under the chooser either.
    const api = makeApi();
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: false });

    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("openai"));
    expect(api.listLlmModels).not.toHaveBeenCalled();
    expect(rowOrder()).toEqual(["codex"]);
    expect(screen.getByTestId("llm-tab:connection-subline:codex"))
      .toHaveAttribute("data-provider-sync-status", "none");
  });

  /**
   * The contradiction this consolidation exists to make impossible.
   *
   * OpenAI used to be drawn twice — a provider row and a subscription card —
   * and each looked the handshake up under a key it built for itself. A
   * signed-in OpenAI card read "sync failed" while the row read "4 models
   * synced", at one instant, about one account. One row now, and one read
   * behind it, so there is nowhere for a second answer to live.
   */
  it("gives one vendor one row and one sync verdict, wherever it is reached", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: true });

    // Reached by subscription AND by API key, and still ONE row.
    expect(rowOrder()).toEqual(["codex"]);
    const card = screen.getByTestId("llm-tab:connection:codex");
    expect(within(card).getByTestId("llm-tab:connection-route:codex:subscription")).toBeInTheDocument();
    expect(within(card).getByTestId("llm-tab:connection-route:codex:api")).toBeInTheDocument();

    // ...and one place in the whole tab where a sync verdict is stated.
    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:codex"))
      .toHaveAttribute("data-provider-sync-status", "error"));
    const verdicts = [...document.querySelectorAll("[data-provider-sync-status]")]
      .map((node) => node.getAttribute("data-provider-sync-status"));
    expect(verdicts).toEqual(["error"]);
    // One refresh, one state word, no capability checklist, no model controls.
    expect(document.querySelectorAll("[data-testid^='llm-tab:connection-refresh:']")).toHaveLength(1);
    expect(document.querySelectorAll("[data-testid^='llm-tab:connection:'][data-testid$=':state']")).toHaveLength(1);
    expect(document.querySelectorAll("[data-testid*=':capability']")).toHaveLength(0);
    expect(document.querySelectorAll("[data-testid$=':load-models']")).toHaveLength(0);
    expect(document.querySelectorAll("[data-testid$=':use-for-chat']")).toHaveLength(0);
  });

  it("distinguishes a failure that left a catalogue standing from one that did not", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai"),
      getSettings: settingsWithCache({
        [["openai", "", ""].join("\n")]: {
          vendor: "openai",
          endpoint: "https://api.openai.com/v1/models",
          models: ["gpt-cached"],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    await renderTab(api, { model: "" });

    const status = await screen.findByTestId("llm-tab:connection-subline:openai");
    await waitFor(() => {
      expect(status).toHaveAttribute("data-provider-sync-status", "error");
    });
    // A cached catalogue is still on offer, so the message must not read as
    // "nothing to show" — the two failures are different states.
    expect(status.textContent).toMatch(/마지막으로 받은|last catalogue/);
  });

  it("does not spend a credentialed handshake when no key is stored", async () => {
    const api = makeApi();
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { model: "", hasKey: false });

    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("openai"));
    expect(api.listLlmModels).not.toHaveBeenCalled();

    // Nothing is stored, so this card has no API path — and no sync line for
    // one. The runtime it does have is signed in and healthy, so the card says
    // nothing is missing either.
    // Nothing was asked, so the row's line reports no handshake — it names what
    // the provider is offering instead, and claims no sync outcome at all.
    expect(screen.getByTestId("llm-tab:connection-subline:codex"))
      .toHaveAttribute("data-provider-sync-status", "none");
    expect(screen.queryByTestId("llm-tab:connection-blocked:codex")).toBeNull();
    // And no second, API-side OpenAI row conjured out of the attempt.
    expect(rowOrder()).toEqual(["codex"]);
  });

  it("keeps the stored key replaceable on a row whose handshake failed", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView()]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:codex"))
        .toHaveAttribute("data-provider-sync-status", "error");
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection:codex:toggle"));
    expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(/설정됨|Configured|Set/);
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(screen.queryByTestId("llm-tab:api-key-reveal")).toBeNull();
    expect(screen.getByTestId("llm-tab:manual-section")).toHaveTextContent(/삭제|Delete|Remove/);
  });

  it("gives a generic openai-compatible row its own endpoint field with the saved value", async () => {
    // The live shape: the active provider is OpenAI, and the openai-compatible
    // provider is configured with a custom endpoint of its own. Clicking its
    // card must show THAT endpoint, without the active provider moving.
    const api = makeApi({
      hasApiKey: storedKeysFor("openai", "openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, model: "local-27b" } },
          modelListCache: {
            [["openai-compatible", CUSTOM_ENDPOINT, ""].join("\n")]: {
              vendor: "openai-compatible",
              baseUrl: CUSTOM_ENDPOINT,
              endpoint: `${CUSTOM_ENDPOINT}/models`,
              models: ["a", "b", "c", "d"],
              fetchedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      }),
    });
    installSubscription([codexView()]);
    const { hooks } = await renderTab(api, { vendor: "openai", model: "", hasKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("llm-tab:connection:openai-compatible")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    const card = screen.getByTestId("llm-tab:connection:openai-compatible");
    expect(card).toContainElement(screen.getByTestId("llm-tab:manual-section"));
    // Row X's field, while the active provider is still Y.
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
    // And the live-route badge stays where chat actually is.
    expect(screen.getByTestId("llm-tab:connection-route:codex:api"))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("llm-tab:connection-route:openai-compatible:api"))
      .toHaveAttribute("data-active", "false");
  });

  it("locks the endpoint on a preset row and not on the generic one beside it", async () => {
    const presets = [preset("acme-gw", "Acme Gateway", "https://acme.example/v1")];
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: settingsWithVendorBlocks({ "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
      model: "local-model",
      marketplaceProviderPresets: presets,
    });

    // The generic row: no preset, so no lock — the field is offered.
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
  });

  it("keeps the generic endpoint field through an unrelated settings broadcast", async () => {
    // A model-list sync persists its cache, which broadcasts settings. That
    // broadcast must not rewrite which provider the form is editing.
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: settingsWithVendorBlocks({ "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
      model: "local-model",
      marketplaceProviderPresets: [preset("acme-gw", "Acme Gateway", "https://acme.example/v1")],
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection:openai-compatible:toggle"));
    expect(screen.getByTestId("llm-base-url-input")).toBeInTheDocument();

    const handler = api.onSettingsUpdated.mock.calls.at(-1)?.[0] as ((s: unknown) => void) | undefined;
    expect(handler).toBeTruthy();
    await act(async () => {
      handler!({
        llm: {
          provider: "openai-compatible",
          marketplaceProviderPresetId: "acme-gw",
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      });
      await Promise.resolve();
    });
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
  });

  it("appends a picked self-hosted provider above the button, with its endpoint focused", async () => {
    // Ollama is not a built-in, so it is offered only once installed.
    const api = makeApi({
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {} },
        marketplace: { installedProviderIds: ["ollama"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", hasKey: false, model: "" });

    // Radix opens the menu on pointerdown; a bare click never renders items.
    fireEvent.click(screen.getByTestId("llm-tab:add-provider"));
    expect(screen.queryByTestId("llm-tab:add-provider-item:ollama")).toBeNull();

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:ollama"));

    // Directly above the button that created it.
    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("ollama");

    // The card offers its endpoint straight away and the caret is in it.
    const field = await screen.findByTestId("llm-base-url-input");
    expect(screen.getByTestId("llm-tab:connection:ollama")).toContainElement(field);
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("draws no configured row from a handshake that only started", async () => {
    let release: ((result: LlmModelListResult) => void) | undefined;
    const api = makeApi({
      listLlmModels: vi.fn().mockImplementation(() => new Promise((resolve) => {
        release = resolve as (result: LlmModelListResult) => void;
      })),
    });
    await renderTab(api, {
      model: "",
      vendor: "claude",
      hasKey: false,
      fallbackOpen: true,
      fallbackChain: [{ provider: "openrouter", model: "x" }],
    });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalled());
    // In flight and nothing stored: a started handshake is not a configured
    // provider, so it must not draw a "connected" row of its own.
    expect(rowOrder()).toEqual([]);

    await act(async () => {
      release?.({
        ok: true,
        vendor: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/models",
        models: ["a", "b"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });
      await Promise.resolve();
    });
    // Once the catalogue lands, the same provider IS configured and gets one.
    await waitFor(() => expect(rowOrder()).toEqual(["openrouter"]));
    expect(screen.getByTestId("llm-tab:connection-subline:openrouter"))
      .toHaveAttribute("data-provider-sync-status", "ready");
  });
});

describe("subscription models in the unified chooser", () => {
  it("offers the CLI default beside catalog model choices", async () => {
    const useForChat = vi.fn();
    installSubscription(
      [codexView({
        descriptor: { id: "claude-code", label: "Claude Code", planName: "Claude", cliName: "Claude Code CLI", executable: "discovered", description: "", loginMethods: ["browser"], supportsLogout: true },
        status: {
          runtime: "ready",
          connection: "connected",
          models: [{ id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" }],
        },
      })],
      { useForChat, useApiForChat: vi.fn() },
    );
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { vendor: "openai", model: "" });

    const cliDefault = t("llmTab.cliDefaultModel");
    expect(await chooserModelIds()).toEqual(expect.arrayContaining([cliDefault, "claude-sonnet-5-5"]));
    expect(chooserGroupText(cliDefault)).toMatch(/Claude/);

    pickChooserOption(cliDefault);
    // No model is sent: the CLI runs its own default.
    await waitFor(() => expect(useForChat).toHaveBeenCalledWith("claude-code", null));
  });
});
