import { describe, expect, it } from "vitest";
import { JudgeCircuitBreaker } from "../judge-breaker.js";
import { createPermissionJudge } from "../create-judge.js";
import { DEFAULT_JUDGE_SETTINGS, JudgeSettingsError, normalizeJudgeSettings, validateJudgeSettings } from "../judge-settings.js";

describe("judge settings", () => {
  it("defaults to off, shadow, shell+write on, network off, breaker 3/20", () => {
    const { settings, issues } = normalizeJudgeSettings(undefined);
    expect(issues).toEqual([]);
    expect(settings).toEqual({
      provider: "off",
      mode: "shadow",
      categories: { shell: true, write: true, network: false },
      timeoutMs: DEFAULT_JUDGE_SETTINGS.timeoutMs,
      breaker: { consecutive: 3, total: 20 },
    });
  });

  it("choosing a provider without a mode stays in shadow", () => {
    expect(validateJudgeSettings({ provider: "builtin-llm" }).mode).toBe("shadow");
    expect(validateJudgeSettings({ provider: "builtin-llm", mode: "active" }).mode).toBe("active");
  });

  it("external needs exactly one safe endpoint; read path disables, write path throws", () => {
    const bad = { provider: "external", external: { command: ["judge", "--json"] } };
    const read = normalizeJudgeSettings(bad);
    expect(read.settings.provider).toBe("off");
    expect(read.issues.join(" ")).toContain("absolute");
    expect(() => validateJudgeSettings(bad)).toThrow(JudgeSettingsError);
    expect(validateJudgeSettings({ provider: "external", external: { command: ["/opt/jev/bin/jev", "judge"] } }).external).toEqual({
      command: ["/opt/jev/bin/jev", "judge"],
    });
    expect(() => validateJudgeSettings({ provider: "external", external: { url: "http://judge.example.test/" } })).toThrow(/loopback/);
  });

  it.each([
    [{ provider: "jev" }],
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

describe("createPermissionJudge", () => {
  const fetchImpl = async () => new Response("{}");
  it("off → null; builtin-llm without reviewer → null (engine: unavailable)", () => {
    const base = normalizeJudgeSettings(undefined).settings;
    expect(createPermissionJudge(base, { llmClassifier: null, autoApprove: () => "medium", fetch: fetchImpl })).toBeNull();
    expect(
      createPermissionJudge({ ...base, provider: "builtin-llm" }, { llmClassifier: null, autoApprove: () => "medium", fetch: fetchImpl }),
    ).toBeNull();
  });

  it("external builds the adapter", () => {
    const s = validateJudgeSettings({ provider: "external", external: { url: "http://127.0.0.1:7777/" } });
    expect(createPermissionJudge(s, { llmClassifier: null, autoApprove: () => "medium", fetch: fetchImpl })?.id).toBe("external");
  });
});

describe("external.env", () => {
  it("accepts plain names for the command transport and refuses Ave runtime variables", () => {
    expect(
      validateJudgeSettings({ provider: "external", external: { command: ["/opt/jev/bin/jev"], env: ["JEV_MODEL"] } }).external,
    ).toEqual({ command: ["/opt/jev/bin/jev"], env: ["JEV_MODEL"] });
    expect(() => validateJudgeSettings({ provider: "external", external: { command: ["/opt/jev/bin/jev"], env: ["AVE_HOME"] } })).toThrow(/Ave runtime/);
    expect(() => validateJudgeSettings({ provider: "external", external: { command: ["/opt/jev/bin/jev"], env: ["BAD-NAME"] } })).toThrow(JudgeSettingsError);
    for (const name of ["OPENAI_API_KEY", "MY_SERVICE_TOKEN", "DB_PASSWORD", "APP_SECRET", "AWS_PROFILE", "GITHUB_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_ORG", "RETIREDNAME_HOME", "ELECTRON_RUN_AS_NODE"]) {
      expect(() => validateJudgeSettings({ provider: "external", external: { command: ["/opt/jev/bin/jev"], env: [name] } })).toThrow(/credential/);
    }
    expect(() => validateJudgeSettings({ provider: "external", external: { url: "https://judge.example.test/", env: ["X"] } })).toThrow(/command transport/);
  });
});
