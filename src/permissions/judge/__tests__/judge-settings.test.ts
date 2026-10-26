import { describe, expect, it } from "vitest";
import { llmVendorModelOptions } from "../../../shared/llm-vendor-defaults.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { createJudgeChain, type CreateJudgeDeps } from "../create-judge.js";
import {
  DEFAULT_JUDGE_SETTINGS,
  JudgeSettingsError,
  normalizeJudgeSettings,
  serializeJudgeSettings,
  validateJudgeSettings,
} from "../judge-settings.js";
import { judgeModelCatalogFrom } from "../judge-model-catalog.js";

const PICKER_VENDOR = "claude" as const;
const PICKER_MODEL = llmVendorModelOptions(PICKER_VENDOR)[0]!;
const JEV = { provider: "external", id: "jev", escalateBelow: 0.8, external: { command: ["/opt/jev/bin/jev", "judge"] } };

describe("judge settings", () => {
  it("defaults to an empty chain (off), shadow, shell+write on, network off, breaker 3/20", () => {
    const { settings, issues, migrated } = normalizeJudgeSettings(undefined);
    expect(issues).toEqual([]);
    expect(migrated).toBe(false);
    expect(settings).toEqual({
      // Unset reviewer model: follows the chat model, no fixed default.
      model: null,
      chain: [],
      mode: "shadow",
      categories: { shell: true, write: true, network: false },
      timeoutMs: DEFAULT_JUDGE_SETTINGS.timeoutMs,
      chainDeadlineMs: 60_000,
      breaker: { consecutive: 3, total: 20 },
    });
  });

  it("stores the reviewer model as an explicit choice or explicit null", () => {
    expect(normalizeJudgeSettings({ model: null }).settings.model).toBeNull();
    const picked = validateJudgeSettings({ model: `${PICKER_VENDOR}/${PICKER_MODEL}` });
    expect(picked.model).toEqual({ vendor: PICKER_VENDOR, model: PICKER_MODEL });
    expect(serializeJudgeSettings(picked)).toMatchObject({ model: `${PICKER_VENDOR}/${PICKER_MODEL}` });
    expect(serializeJudgeSettings(validateJudgeSettings({}))).toMatchObject({ model: null });
  });

  it("marks an unoffered reviewer model rejected instead of following chat", () => {
    const read = normalizeJudgeSettings({ model: `${PICKER_VENDOR}/not-offered` });
    expect(read.modelRejected).toBe(true);
    expect(read.settings.model).toBeNull();
    expect(read.issues.join()).toMatch(/permission reviewer unavailable/);
    expect(() => validateJudgeSettings({ model: `${PICKER_VENDOR}/not-offered` })).toThrow(JudgeSettingsError);
  });

  it("a chain without a mode stays in shadow", () => {
    expect(validateJudgeSettings({ chain: [{ provider: "builtin-llm" }] }).mode).toBe("shadow");
    expect(validateJudgeSettings({ chain: [{ provider: "builtin-llm" }], mode: "active" }).mode).toBe("active");
  });

  it("parses a tiered chain with a picker model", () => {
    const s = validateJudgeSettings({ chain: [JEV, { provider: "builtin-llm", model: `${PICKER_VENDOR}/${PICKER_MODEL}` }] });
    expect(s.chain).toEqual([
      { provider: "external", id: "jev", escalateBelow: 0.8, external: { command: ["/opt/jev/bin/jev", "judge"] } },
      { provider: "builtin-llm", id: "builtin-llm", model: { vendor: PICKER_VENDOR, model: PICKER_MODEL } },
    ]);
    expect(serializeJudgeSettings(s).chain).toEqual([
      JEV,
      { provider: "builtin-llm", id: "builtin-llm", model: `${PICKER_VENDOR}/${PICKER_MODEL}` },
    ]);
  });

  describe("migration from the single-provider form", () => {
    it.each([
      [{ provider: "off" }, []],
      [{ provider: "builtin-llm" }, [{ provider: "builtin-llm", id: "builtin-llm" }]],
      [
        { provider: "external", external: { url: "http://127.0.0.1:7777/" } },
        [{ provider: "external", id: "external", external: { url: "http://127.0.0.1:7777/" } }],
      ],
    ])("%j → one-stage chain", (legacy, chain) => {
      const { settings, issues, migrated } = normalizeJudgeSettings({ ...legacy, mode: "active" });
      expect(issues).toEqual([]);
      expect(migrated).toBe(true);
      expect(settings.chain).toEqual(chain);
      expect(settings.mode).toBe("active");
      expect(serializeJudgeSettings(settings)).not.toHaveProperty("provider");
    });

    it("legacy external without a safe endpoint disables the judge on read and throws on write", () => {
      const bad = { provider: "external", external: { command: ["judge", "--json"] } };
      const read = normalizeJudgeSettings(bad);
      expect(read.settings.chain).toEqual([]);
      expect(read.issues.join(" ")).toContain("absolute");
      expect(() => validateJudgeSettings(bad)).toThrow(JudgeSettingsError);
    });

    it("chain and legacy provider together is an invalid shape", () => {
      expect(() => validateJudgeSettings({ provider: "builtin-llm", chain: [{ provider: "builtin-llm" }] })).toThrow(/either chain/);
    });
  });

  it.each([
    [{ chain: {} }, /array/],
    [{ chain: [{ provider: "jev" }] }, /provider/],
    [{ chain: [{ provider: "builtin-llm", model: "claude" }] }, /provider>\/<model/],
    [{ chain: [{ provider: "builtin-llm", model: "nope/x" }] }, /not a configured LLM provider/],
    [{ chain: [{ provider: "builtin-llm", model: `${PICKER_VENDOR}/not-a-picker-model` }] }, /not offered/],
    [{ chain: [{ provider: "builtin-llm", external: { url: "https://judge.example.test/" } }] }, /external.*only/],
    [{ chain: [{ ...JEV, model: `${PICKER_VENDOR}/${PICKER_MODEL}` }] }, /builtin-llm.*only/],
    [{ chain: [{ ...JEV, escalateBelow: 1.2 }] }, /escalateBelow/],
    [{ chain: [{ provider: "builtin-llm", escalateBelow: 0.5 }] }, /builtin-llm \(it reports no confidence\)/],
    [{ chain: [{ ...JEV, extra: true }] }, /unknown keys/],
    [{ chain: [JEV, JEV] }, /duplicated/],
    [{ chain: [{ provider: "builtin-llm", id: "bad id" }] }, /id invalid/],
    [{ chain: Array.from({ length: 5 }, (_, i) => ({ provider: "builtin-llm", id: `s${i}` })) }, /at most/],
  ])("rejects invalid chain %j and never keeps a partial chain", (patch, message) => {
    expect(() => validateJudgeSettings(patch)).toThrow(message);
    expect(normalizeJudgeSettings(patch).settings.chain).toEqual([]);
  });

  it("external stage needs exactly one safe endpoint", () => {
    expect(() => validateJudgeSettings({ chain: [{ provider: "external", external: { url: "http://judge.example.test/" } }] })).toThrow(/loopback/);
    expect(() => validateJudgeSettings({ chain: [{ provider: "external" }] })).toThrow(/requires an external/);
  });

  it.each([
    [{ mode: "auto" }],
    [{ categories: { shell: "yes" } }],
    [{ timeoutMs: 10 }],
    [{ breaker: { consecutive: 5, total: 2 } }],
    [{ breaker: { consecutive: 0 } }],
    [{ chainDeadlineMs: 500 }],
    [{ chainDeadlineMs: 600_001 }],
  ])("write path rejects %j", (patch) => {
    expect(() => validateJudgeSettings(patch)).toThrow(JudgeSettingsError);
  });

  it("the chain deadline is configurable", () => {
    expect(validateJudgeSettings({ chainDeadlineMs: 30_000 }).chainDeadlineMs).toBe(30_000);
  });

  it("validates the model against the picker's live set, including self-hosted openai-compatible models", () => {
    const chain = { chain: [{ provider: "builtin-llm", model: "openai-compatible/team/llama-70b" }] };
    // Static list alone has no openai-compatible models (handshake-only in the picker).
    expect(() => validateJudgeSettings(chain)).toThrow(/not offered/);
    const live = judgeModelCatalogFrom({
      vendors: { "openai-compatible": { baseUrl: "http://10.0.0.5:8000/v1" } },
      modelListCache: {
        k1: { vendor: "openai-compatible", baseUrl: "http://10.0.0.5:8000/v1", endpoint: "http://10.0.0.5:8000/v1/models", models: ["team/llama-70b"], fetchedAt: "t" },
        k2: { vendor: "openai-compatible", baseUrl: "http://other:8000/v1", endpoint: "http://other:8000/v1/models", models: ["other-model"], fetchedAt: "t" },
      },
    });
    expect(validateJudgeSettings(chain, live).chain[0]!.model).toEqual({ vendor: "openai-compatible", model: "team/llama-70b" });
    // A listing for a different endpoint than the configured one is not on offer.
    expect(() => validateJudgeSettings({ chain: [{ provider: "builtin-llm", model: "openai-compatible/other-model" }] }, live)).toThrow(/not offered/);
    // The user's saved selection is on offer even before a handshake.
    const saved = judgeModelCatalogFrom({ vendors: { "openai-compatible": { model: "my-local" } } });
    expect(validateJudgeSettings({ chain: [{ provider: "builtin-llm", model: "openai-compatible/my-local" }] }, saved).chain).toHaveLength(1);
  });

  it("without a configured baseUrl, only the listing for the vendor's default endpoint is on offer", () => {
    const entry = (vendor: string, endpoint: string, models: string[], baseUrl?: string) => ({
      vendor, endpoint, models, fetchedAt: "t", ...(baseUrl ? { baseUrl } : {}),
    });
    const live = judgeModelCatalogFrom({
      vendors: { openai: { model: llmVendorModelOptions("openai")[0]! } },
      modelListCache: {
        std: entry("openai", "https://api.openai.com/v1/models", ["gpt-live-default"]),
        proxy: entry("openai", "https://proxy.example.test/v1/models", ["gpt-via-proxy"], "https://proxy.example.test/v1"),
        router: entry("openrouter", "https://openrouter.ai/api/v1/models", ["vendor/router-live"]),
        routerOther: entry("openrouter", "https://elsewhere.example.test/v1/models", ["vendor/elsewhere"], "https://elsewhere.example.test/v1"),
        compat: entry("openai-compatible", "http://10.0.0.5:8000/v1/models", ["team/llama-70b"], "http://10.0.0.5:8000/v1"),
      },
    });
    const pick = (model: string) => ({ chain: [{ provider: "builtin-llm", model }] });
    expect(validateJudgeSettings(pick("openai/gpt-live-default"), live).chain).toHaveLength(1);
    expect(() => validateJudgeSettings(pick("openai/gpt-via-proxy"), live)).toThrow(/not offered/);
    // A preset vendor's default endpoint is its preset address.
    expect(validateJudgeSettings(pick("openrouter/vendor/router-live"), live).chain).toHaveLength(1);
    expect(() => validateJudgeSettings(pick("openrouter/vendor/elsewhere"), live)).toThrow(/not offered/);
    // A whitespace-only saved baseUrl resolves as the fetch resolves it: the preset default no longer applies.
    const blank = judgeModelCatalogFrom({
      vendors: { openrouter: { baseUrl: "   " } },
      modelListCache: { router: entry("openrouter", "https://openrouter.ai/api/v1/models", ["vendor/router-live"]) },
    });
    expect(() => validateJudgeSettings(pick("openrouter/vendor/router-live"), blank)).toThrow(/not offered/);
    // A vendor with no default endpoint and no configured one takes no listing at all.
    expect(() => validateJudgeSettings(pick("openai-compatible/team/llama-70b"), live)).toThrow(/not offered/);
  });

  it("offers a catalog-backed route's catalog but seeds no endpoint-defined route before its handshake", () => {
    const empty = judgeModelCatalogFrom({});
    expect(empty.optionsFor("openai")).toEqual(llmVendorModelOptions("openai"));
    expect(empty.optionsFor("openai-compatible")).toEqual([]);
    const saved = judgeModelCatalogFrom({ vendors: { "openai-compatible": { model: "team/saved" } } });
    expect(saved.optionsFor("openai-compatible")).toEqual(["team/saved"]);
  });

  it("keeps schema-only catalog validation independent from live route discovery", () => {
    const model = llmVendorModelOptions("openai")[0]!;
    const patch = { chain: [{ provider: "builtin-llm", model: `openai/${model}` }] };
    expect(validateJudgeSettings(patch).chain[0]?.model).toEqual({ vendor: "openai", model });
    // Once the route's own listing arrives, it alone names the offered models.
    const listed = judgeModelCatalogFrom({ modelListCache: {
      live: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-live-only"], fetchedAt: "2026-10-22T00:00:00Z" },
    } });
    expect(() => validateJudgeSettings(patch, listed)).toThrow(/not offered/);
  });

  it.each(["static", "manual"] as const)("uses the active preset's %s model options and its own saved selection", (policy) => {
    const catalog = judgeModelCatalogFrom({
      provider: "openai-compatible",
      marketplaceProviderPresetId: "team-route",
      vendors: { "openai-compatible": { model: "generic/saved", presetModels: { "team-route": "team/saved" } } },
      installedProviderPresets: [{
        providerId: "team-route", baseUrl: "https://models.example.test/v1", defaultModel: "team/default",
        modelOptions: ["team/default", "team/other"], modelDiscoveryPolicy: policy, requiresApiKey: true,
      }, {
        providerId: "inactive-route", baseUrl: "https://other.example.test/v1", defaultModel: "inactive/default",
        modelOptions: ["inactive/default"], requiresApiKey: false,
      }],
      modelListCache: {
        cached: { vendor: "openai-compatible", endpoint: "https://models.example.test/v1/models", credentialScope: "team-route", models: ["network/model"], fetchedAt: "2026-10-22T00:00:00Z" },
      },
    });
    expect(catalog.optionsFor("openai-compatible")).toEqual(["team/saved", "team/default", "team/other"]);
  });

  it("keeps same-endpoint listings separated by the active credential scope", () => {
    const source = {
      provider: "openai-compatible",
      marketplaceProviderPresetId: "team-route",
      vendors: { "openai-compatible": { baseUrl: "https://models.example.test/v1", model: "generic/saved" } },
      installedProviderPresets: [{
        providerId: "team-route", baseUrl: "https://models.example.test/v1", defaultModel: "team/default",
        modelOptions: [], requiresApiKey: true,
      }],
      modelListCache: {
        generic: { vendor: "openai-compatible", endpoint: "https://models.example.test/v1/models", models: ["generic/model"], fetchedAt: "2026-10-22T01:00:00Z" },
        other: { vendor: "openai-compatible", endpoint: "https://models.example.test/v1/models", credentialScope: "other-route", models: ["other/model"], fetchedAt: "2026-10-22T02:00:00Z" },
        selected: { vendor: "openai-compatible", endpoint: "https://models.example.test/v1/models", credentialScope: "team-route", models: ["team/model"], fetchedAt: "2026-10-22T00:00:00Z" },
      },
    };
    // A preset's default is no choice of its own: the listing names the models.
    expect(judgeModelCatalogFrom(source).optionsFor("openai-compatible")).toEqual(["team/model"]);
    expect(judgeModelCatalogFrom({ ...source, marketplaceProviderPresetId: undefined }).optionsFor("openai-compatible")).toContain("generic/model");
    expect(judgeModelCatalogFrom({ ...source, marketplaceProviderPresetId: "missing-route" }).optionsFor("openai-compatible")).toEqual([]);
  });

  it("filters retired saved models using the current route listing", () => {
    const catalog = judgeModelCatalogFrom({
      vendors: { openai: { model: "o4-mini" } },
      modelListCache: {
        live: { vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-5.4"], fetchedAt: "2026-10-22T00:00:00Z", complete: true },
      },
    });
    expect(catalog.optionsFor("openai")).not.toContain("o4-mini");
    expect(catalog.optionsFor("openai")).toContain("gpt-5.4");
  });

  it("a persisted builtin-llm stage with escalateBelow is a named issue on read, not a silent drop", () => {
    const persisted = { chain: [JEV, { provider: "builtin-llm", id: "llm", escalateBelow: 0.5 }], mode: "active" };
    const { settings, issues, chainRejected } = normalizeJudgeSettings(persisted);
    expect(settings.chain).toEqual([]);
    expect(settings.mode).toBe("active");
    expect(chainRejected).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("chain[1] (stage 'llm').escalateBelow");
    expect(issues[0]).toContain("builtin-llm");
    expect(issues[0]).toContain("judge disabled");
    expect(() => validateJudgeSettings(persisted)).toThrow(/chain\[1\] \(stage 'llm'\)\.escalateBelow/);
  });

  it("accepts only the fixed classifier block thresholds", () => {
    expect(validateJudgeSettings({ breaker: { consecutive: 3, total: 20 } }).breaker).toEqual({ consecutive: 3, total: 20 });
    for (const breaker of [{ consecutive: 2, total: 5 }, { consecutive: 3, total: 21 }]) {
      expect(() => validateJudgeSettings({ breaker })).toThrow(/3 consecutive or 20 total/);
      const read = normalizeJudgeSettings({ breaker });
      expect(read.issues.join(" ")).toContain("3 consecutive or 20 total");
      expect(read.chainRejected).toBe(true);
      expect(read.settings.breaker).toEqual({ consecutive: 3, total: 20 });
    }
  });

  it("distinguishes rejected active chains from explicit off and unrelated warnings", () => {
    const mixed = normalizeJudgeSettings({ chain: [], provider: "off", mode: "active" });
    expect(mixed).toMatchObject({ settings: { chain: [], mode: "active" }, chainRejected: true });
    expect(normalizeJudgeSettings({ chain: "invalid", mode: "active" })).toMatchObject({
      settings: { chain: [], mode: "active" }, chainRejected: true,
    });
    for (const input of [undefined, { chain: [] }, { provider: "off", mode: "active" }, { chain: [], timeoutMs: 1 }]) {
      expect(normalizeJudgeSettings(input)).not.toHaveProperty("chainRejected");
    }
    const warning = normalizeJudgeSettings({ chain: [{ provider: "builtin-llm" }], mode: "active", timeoutMs: 1 });
    expect(warning.issues).not.toEqual([]);
    expect(warning.settings.chain).toHaveLength(1);
    expect(warning).not.toHaveProperty("chainRejected");
    expect(normalizeJudgeSettings(null)).toHaveProperty("chainRejected", true);
  });
});

describe("external stage env", () => {
  const stage = (external: Record<string, unknown>) => ({ chain: [{ provider: "external", external }] });
  it("accepts plain names for the command transport and refuses Ave runtime and credential variables", () => {
    expect(validateJudgeSettings(stage({ command: ["/opt/jev/bin/jev"], env: ["JEV_MODEL"] })).chain[0]!.external).toEqual({
      command: ["/opt/jev/bin/jev"],
      env: ["JEV_MODEL"],
    });
    expect(() => validateJudgeSettings(stage({ command: ["/opt/jev/bin/jev"], env: ["BAD-NAME"] }))).toThrow(JudgeSettingsError);
    for (const name of ["AVE_HOME", "OPENAI_API_KEY", "MY_SERVICE_TOKEN", "DB_PASSWORD", "APP_SECRET", "AWS_PROFILE", "GITHUB_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_ORG", "ELECTRON_RUN_AS_NODE"]) {
      expect(() => validateJudgeSettings(stage({ command: ["/opt/jev/bin/jev"], env: [name] }))).toThrow(/credential/);
    }
    expect(() => validateJudgeSettings(stage({ url: "https://judge.example.test/", env: ["X"] }))).toThrow(/command transport/);
  });
});

describe("JudgeCircuitBreaker", () => {
  it("rewiring keeps the pause and rejects noncanonical thresholds", () => {
    const b = new JudgeCircuitBreaker({ consecutive: 3, total: 20 });
    for (let i = 0; i < 3; i++) b.record("s", "deny");
    expect(b.isOpen("s")).toBe(true);
    b.setLimits({ consecutive: 3, total: 20 });
    expect(b.isOpen("s")).toBe(true);
    expect(() => b.setLimits({ consecutive: 5, total: 20 })).toThrow(/3 consecutive or 20 total/);
    expect(b.snapshot("s")).toEqual({ consecutive: 3, total: 3, open: true });
    expect(() => b.setLimits({ consecutive: 5, total: 3 })).toThrow(/3 consecutive or 20 total/);
    expect(b.isOpen("s")).toBe(true);
  });

  it("trips on three consecutive blocks; allow resets the streak and ask counts", () => {
    const b = new JudgeCircuitBreaker({ consecutive: 3, total: 20 });
    b.record("s", "deny");
    b.record("s", "deny");
    b.record("s", "allow");
    b.record("s", "deny");
    b.record("s", "ask");
    expect(b.isOpen("s")).toBe(false);
    expect(b.record("s", "deny")).toBe(true);
    expect(b.isOpen("s")).toBe(true);
  });

  it("trips on M total denials even with allows between", () => {
    const b = new JudgeCircuitBreaker({ consecutive: 3, total: 20 });
    for (let i = 0; i < 19; i++) {
      b.record("s", "deny");
      b.record("s", "allow");
    }
    expect(b.isOpen("s")).toBe(false);
    b.record("s", "deny");
    expect(b.isOpen("s")).toBe(true);
    expect(b.snapshot("s").total).toBe(0);
  });
});

describe("createJudgeChain", () => {
  const classifier = { classifyWithTrace: async () => Promise.reject(new Error("unused")) };
  const base: CreateJudgeDeps = {
    reviewerClassifier: null,
    reviewerModel: null,
    classifierForModel: () => null,
    autoApprove: () => "medium",
    fetch: async () => new Response("{}"),
  };

  it("empty chain → no stages", () => {
    expect(createJudgeChain(normalizeJudgeSettings(undefined).settings, base)).toEqual([]);
  });

  it("builds stages in order; an unconfigured model stays unavailable instead of falling back", () => {
    const s = validateJudgeSettings({
      chain: [
        { provider: "external", id: "jev", external: { url: "http://127.0.0.1:7777/" } },
        { provider: "builtin-llm", model: `${PICKER_VENDOR}/${PICKER_MODEL}` },
      ],
    });
    const requested: unknown[] = [];
    const chain = createJudgeChain(s, {
      ...base,
      reviewerClassifier: classifier,
      classifierForModel: (m) => {
        requested.push(m);
        return null;
      },
    });
    expect(chain.map((c) => c.settings.id)).toEqual(["jev", "builtin-llm"]);
    expect(chain[0]!.judge?.id).toBe("jev");
    expect(chain[1]!.judge).toBeNull();
    expect(requested).toEqual([{ vendor: PICKER_VENDOR, model: PICKER_MODEL }]);
  });

  it("builtin-llm without a model uses the reviewer classifier and names the resolved reviewer model", () => {
    const s = validateJudgeSettings({ chain: [{ provider: "builtin-llm" }] });
    const built = createJudgeChain(s, { ...base, reviewerClassifier: classifier, reviewerModel: { vendor: PICKER_VENDOR, model: PICKER_MODEL } })[0]!;
    expect(built.judge?.id).toBe("builtin-llm");
    expect(built.judge?.model).toBe(`${PICKER_VENDOR}/${PICKER_MODEL}`);
    expect(createJudgeChain(s, base)[0]!.judge).toBeNull();
  });
});
