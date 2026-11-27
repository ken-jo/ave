import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../shared/windows-drive-locality.js");

import { LlmRiskClassifier, type LlmReviewerProvider, type ToolInvocationContext } from "../risk-classifier.js";
import { traceRiskClassifier } from "../../judge/builtin-llm-judge.js";
import { setWindowsDriveQueryForTest } from "../../../shared/windows-drive-locality.js";
import { canonicalizePathForMatch } from "../../sensitive-paths.js";
import { detectSandboxCapability } from "../../sandbox-capability.js";

describe.runIf(process.platform === "win32")("reviewer inputs under one decision", () => {
  const query = vi.fn<(drive: string) => string | null>();
  let root: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-reviewer-locality-")));
    query.mockReset().mockReturnValue(String.raw`\Device\HarddiskVolume1`);
    setWindowsDriveQueryForTest(query);
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  function context(): ToolInvocationContext {
    return {
      toolName: "write", category: "write", source: "builtin", pathFields: ["path"],
      finalInput: { path: join(root, "note.txt"), content: "x" },
      executionCwd: root, allowedDirectories: [canonicalizePathForMatch(root).toLowerCase()], sensitivePathsAdjacent: [], sandboxCapability: detectSandboxCapability(),
      conversationContext: { recentUserMessage: "write the note" },
    } as unknown as ToolInvocationContext;
  }

  function reviewer() {
    const complete = vi.fn<LlmReviewerProvider["complete"]>().mockResolvedValue({
      text: JSON.stringify({ level: "low", reason: "in scope" }), tokensIn: 0, tokensOut: 0, costUsd: 0,
    });
    return { complete, classifier: traceRiskClassifier(new LlmRiskClassifier({ complete }, "model", "rule")) };
  }

  it("observes each drive once for the baseline and the prompt facts", async () => {
    const { complete, classifier } = reviewer();
    const input = context();
    query.mockClear();
    await classifier.classifyWithTrace(input);
    expect(complete).toHaveBeenCalledOnce();
    const perDrive = new Map<string, number>();
    for (const [drive] of query.mock.calls) perDrive.set(drive.toUpperCase(), (perDrive.get(drive.toUpperCase()) ?? 0) + 1);
    expect([...perDrive.values()].every((count) => count === 1)).toBe(true);
  });

  it("fails the review closed on a failed host observation without asking the provider", async () => {
    const { complete, classifier } = reviewer();
    const input = context();
    query.mockClear().mockImplementation(() => { throw new Error("drive query failed"); });
    const trace = await classifier.classifyWithTrace(input);
    expect(trace).toMatchObject({ outcome: "error", finalVerdict: { level: "high" }, ruleVerdict: { level: "high" } });
    expect(complete).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });
});
