import { describe, expect, it } from "vitest";
import { DEFAULT_JUDGE_SETTINGS, serializeJudgeSettings } from "../../permissions/judge/judge-settings.js";
import { serializePermissionJudgeSettings, type PermissionJudgeSettings } from "../permission-judge-settings.js";

describe("judge settings renderer encoding", () => {
  it("encodes ordered stages using the persisted wire shape", () => {
    const settings: PermissionJudgeSettings = {
      ...structuredClone(DEFAULT_JUDGE_SETTINGS),
      chain: [
        { provider: "external", id: "local", external: { command: ["/opt/judge", "--json"], env: ["JUDGE_MODEL"] }, escalateBelow: 0.8 },
        { provider: "builtin-llm", id: "review", model: { vendor: "openai-compatible", model: "team/model" } },
      ],
    };
    expect(serializePermissionJudgeSettings(settings)).toEqual({
      chain: [
        { provider: "external", id: "local", external: { command: ["/opt/judge", "--json"], env: ["JUDGE_MODEL"] }, escalateBelow: 0.8 },
        { provider: "builtin-llm", id: "review", model: "openai-compatible/team/model" },
      ],
      mode: "shadow",
      categories: { shell: true, write: true, network: false },
      timeoutMs: 15_000,
      chainDeadlineMs: 60_000,
      breaker: { consecutive: 3, total: 20 },
    });
    expect(serializeJudgeSettings).toBe(serializePermissionJudgeSettings);
    expect(settings.chain[1]?.model).toEqual({ vendor: "openai-compatible", model: "team/model" });
  });
});
