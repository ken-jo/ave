import { randomUUID } from "node:crypto";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
// Classify raw finalized input identically in reviewer and foreground lanes; DLP masks provider/display/audit/cache sinks, since masking classifier input can destroy policy signals.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuleBasedRiskClassifier,
  LlmRiskClassifier,
  _internal,
  type LlmReviewerProvider,
} from "../reviewer/risk-classifier.js";
import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { maskToolInputForDisplay } from "../../tools/pipeline/display-mask.js";
import { makeRiskClassifierContext } from "./test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const rb = new RuleBasedRiskClassifier();

// Inputs whose DLP-masked form classifies differently from their raw form. These are the calls whose reviewer-lane verdict moves.
const LANE_SENSITIVE: Array<{
  label: string;
  input: Record<string, unknown>;
  rawVerdict: { level: string; reason: string };
  maskedVerdict: { level: string; reason: string };
}> = [
  {
    label: "Azure AI Foundry project endpoint named `test-…`",
    input: { url: "https://test-abcdefgh.services.ai.azure.com/v1/x" },
    rawVerdict: { level: "low", reason: "network trusted host (test-abcdefgh.services.ai.azure.com)" },
    maskedVerdict: { level: "high", reason: "network untrusted host" },
  },
  {
    label: "Azure OpenAI resource named `live-…`",
    input: { url: "https://live-corpname.openai.azure.com/v1/x" },
    rawVerdict: { level: "low", reason: "network trusted host (live-corpname.openai.azure.com)" },
    maskedVerdict: { level: "high", reason: "network untrusted host" },
  },
// URL cases must mask a parser-significant segment to expose lane divergence; bare host values agree after extraction.
];

describe("DLP masking really does change these verdicts", () => {
  // Without this, the parity assertions below could pass for the trivial reason that masking is a no-op on the fixtures.
  for (const c of LANE_SENSITIVE) {
    it(`${c.label}: masked and raw forms classify differently`, () => {
      const raw = rb.classify(makeRiskClassifierContext({ category: "network", finalInput: c.input }));
      const masked = rb.classify(makeRiskClassifierContext({
        category: "network",
        finalInput: maskToolInputForDisplay(c.input),
      }));
      expect(raw).toEqual(c.rawVerdict);
      expect(masked).toEqual(c.maskedVerdict);
      expect(maskToolInputForDisplay(c.input)).not.toEqual(c.input);
    });
  }
});

describe("both lanes classify the same object", () => {
  let dirs: string[] = [];
  const makeManager = () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-lane-parity-"));
    dirs.push(dir);
    const pm = new PermissionManager(join(dir, "permissions.json"));
    const seen: Array<Record<string, unknown>> = [];
    setReviewerForTest(pm, {
      classifier: {
        classify: (ctx) => {
          seen.push(ctx.finalInput);
          return rb.classify(ctx);
        },
      },
      cache: new VerdictCache(join(dir, "cache.jsonl")),
      deferredQueue: new DeferredQueue(join(dir, "queue.jsonl")),
    });
    // `dir` is handed back so a dispatch can name a REAL directory as the tool's execution cwd — `ReviewerDispatchInput.executionCwd` is required precisely so no producer can fall back to `process.cwd`.
    return { pm, seen, dir };
  };

  afterEach(async () => {
    for (const d of dirs) await cleanupTmpDir(d);
    dirs = [];
  });

  for (const c of LANE_SENSITIVE) {
    it(`${c.label}: dispatchReviewer grades the raw arguments and returns the raw verdict`, async () => {
      const { pm, seen, dir } = makeManager();
      const result = await pm.dispatchReviewer("net_probe", {
        invocationId: randomUUID(),
        sessionId: "classifier-lane-parity-session",
        source: "plugin",
        category: "network",
        pathFields: [],
        finalInput: c.input,
        executionCwd: dir,
        allowedDirectories: [],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      });
      expect(seen).toEqual([c.input]);
      expect(result.verdict.level).toBe(c.rawVerdict.level);
    });
  }
});

describe("DLP is preserved at the sinks", () => {
  it("the reviewer LLM prompt never carries the raw value", () => {
    const prompt = _internal.buildUserPrompt(makeRiskClassifierContext({
      category: "network",
      finalInput: {
        url: "https://api.openai.com/v1/x",
        note: "alice@example.com / sk-abcdefghijklmnopqrstuvwxyz",
      },
    }));
    expect(prompt).not.toContain("alice@example.com");
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(prompt).toContain("***@example.com");
    expect(prompt).toContain("[REDACTED:TOKEN]");
  });

  it("an LLM classifier still sees only masked input even though the rule side sees raw", async () => {
    let observedPrompt = "";
    const provider: LlmReviewerProvider = {
      complete: async ({ userPrompt }) => {
        observedPrompt = userPrompt;
        return { text: '{"level":"low","reason":"ok"}', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    };
    const llm = new LlmRiskClassifier(provider, "test-model", "rule");
    await llm.classify(makeRiskClassifierContext({
      category: "network",
      finalInput: { url: "https://api.openai.com/x", note: "alice@example.com" },
    }));
    expect(observedPrompt).not.toContain("alice@example.com");
    expect(observedPrompt).toContain("***@example.com");
  });

  it("the host masks a classifier's verdict reason before any sink sees it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-lane-parity-reason-"));
    try {
      const pm = new PermissionManager(join(dir, "permissions.json"));
      const queue = new DeferredQueue(join(dir, "queue.jsonl"));
      setReviewerForTest(pm, {
        // A classifier that echoes its input into `reason` — the host must not trust classifier prose to be redacted.
        classifier: {
          classify: (ctx) => ({
            level: "high" as const,
            reason: `saw ${String(ctx.finalInput.note)}`,
          }),
        },
        cache: new VerdictCache(join(dir, "cache.jsonl")),
        deferredQueue: queue,
      });
      const result = await pm.dispatchReviewer("net_probe", {
        invocationId: randomUUID(),
        sessionId: "classifier-lane-parity-session",
        source: "plugin",
        category: "network",
        pathFields: [],
        finalInput: { note: "alice@example.com" },
        executionCwd: dir,
        allowedDirectories: [],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      }, undefined, { defer: "medium-high" });
      expect(result.verdict.reason).not.toContain("alice@example.com");
      expect(result.verdict.reason).toContain("***@example.com");
      // …and the deferred-queue row, a file on disk, is masked too.
      const [pending] = queue.listPending();
      expect(pending?.inputSummary).not.toContain("alice@example.com");
      expect(pending?.inputSummary).toContain("***@example.com");
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
