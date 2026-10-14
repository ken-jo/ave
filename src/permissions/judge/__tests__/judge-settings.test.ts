import { describe, expect, it } from "vitest";
import { LLM_VENDOR_MODEL_OPTIONS } from "../../../shared/llm-vendor-defaults.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { createJudgeChain, type CreateJudgeDeps } from "../create-judge.js";
import {
  DEFAULT_JUDGE_SETTINGS,
  JudgeSettingsError,
  normalizeJudgeSettings,
  serializeJudgeSettings,
  validateJudgeSettings,
} from "../judge-settings.js";

const PICKER_VENDOR = "claude" as const;
const PICKER_MODEL = LLM_VENDOR_MODEL_OPTIONS[PICKER_VENDOR][0]!;
const JEV = { provider: "external", id: "jev", escalateBelow: 0.8, external: { command: ["/opt/jev/bin/jev", "judge"] } };

describe("judge settings", () => {
  it("defaults to an empty chain (off), shadow, shell+write on, network off, breaker 3/20", () => {
    const { settings, issues, migrated } = normalizeJudgeSettings(undefined);
    expect(issues).toEqual([]);
    expect(migrated).toBe(false);
    expect(settings).toEqual({
      chain: [],
      mode: "shadow",
      categories: { shell: true, write: true, network: false },
      timeoutMs: DEFAULT_JUDGE_SETTINGS.timeoutMs,
      breaker: { consecutive: 3, total: 20 },
    });
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
  ])("write path rejects %j", (patch) => {
    expect(() => validateJudgeSettings(patch)).toThrow(JudgeSettingsError);
  });

  it("breaker thresholds are configurable", () => {
    expect(validateJudgeSettings({ breaker: { consecutive: 2, total: 5 } }).breaker).toEqual({ consecutive: 2, total: 5 });
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
    for (const name of ["AVE_HOME", "OPENAI_API_KEY", "MY_SERVICE_TOKEN", "DB_PASSWORD", "APP_SECRET", "AWS_PROFILE", "GITHUB_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_ORG", "RETIREDNAME_HOME", "ELECTRON_RUN_AS_NODE"]) {
      expect(() => validateJudgeSettings(stage({ command: ["/opt/jev/bin/jev"], env: [name] }))).toThrow(/credential/);
    }
    expect(() => validateJudgeSettings(stage({ url: "https://judge.example.test/", env: ["X"] }))).toThrow(/command transport/);
  });
});

describe("JudgeCircuitBreaker", () => {
  it("trips on N consecutive denials; allow resets the streak, ask does not count", () => {
    const b = new JudgeCircuitBreaker({ consecutive: 3, total: 20 });
    b.record("s", "deny");
    b.record("s", "deny");
    b.record("s", "allow");
    b.record("s", "deny");
    b.record("s", "ask");
    b.record("s", "deny");
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
    expect(b.snapshot("s").total).toBe(20);
  });
});

describe("createJudgeChain", () => {
  const classifier = { classifyWithTrace: async () => Promise.reject(new Error("unused")) };
  const base: CreateJudgeDeps = {
    reviewerClassifier: null,
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

  it("builtin-llm without a model uses the reviewer classifier (current reviewer model)", () => {
    const s = validateJudgeSettings({ chain: [{ provider: "builtin-llm" }] });
    expect(createJudgeChain(s, { ...base, reviewerClassifier: classifier })[0]!.judge?.id).toBe("builtin-llm");
    expect(createJudgeChain(s, base)[0]!.judge).toBeNull();
  });
});
