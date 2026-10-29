// Reviewer and pipeline must resolve identical selected path fields using the invocation cwd and ~ expansion. Stub ambient cwd to catch accidental global fallback.
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { RuleBasedRiskClassifier } from "../risk-classifier.js";
import type { ToolInvocationContext } from "../risk-classifier.js";
import { extractTargetFilePaths } from "../../../tools/pipeline/path-extraction.js";
import { resolveToolPathForPermission } from "../../../shared/tool-path-resolution.js";
import { canonicalizePathForMatch } from "../../sensitive-paths.js";
import type { Tool } from "../../../tools/base.js";

const classifier = new RuleBasedRiskClassifier();

function writeContext(input: {
  declaredValue: string;
  executionCwd: string;
  allowedDirectories: readonly string[];
}): ToolInvocationContext {
  return {
    toolName: "write",
    category: "write",
    source: "model",
    pathFields: ["path"],
    finalInput: { path: input.declaredValue },
    executionCwd: input.executionCwd,
    allowedDirectories: [...input.allowedDirectories],
  } as unknown as ToolInvocationContext;
}

// The path the pipeline hands to Layer 1 for this call, canonicalized.
function pipelineTarget(declaredValue: string, invocationCwd: string): string {
  const [resolved] = extractTargetFilePaths(
    { pathFields: ["path"] } as unknown as Tool,
    { path: declaredValue },
    invocationCwd,
  );
  return canonicalizePathForMatch(resolved).toLowerCase();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewer vs. pipeline: leading ~", () => {
  it("a ~ write to an UNALLOWED location classifies as out-of-scope, like Layer 1 sees it", () => {
    // The invocation cwd and process cwd are the project; only the project is an allowed directory. `~/secret.txt` therefore lands OUTSIDE the scope.
    const projectRoot = pathResolve("/work/project");
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    const allowed = [canonicalizePathForMatch(projectRoot).toLowerCase()];

    // What the pipeline resolves — the path Layer 1 checks and the tool writes.
    expect(resolveToolPathForPermission("~/secret.txt", projectRoot)).toBe(
      pathResolve(homedir(), "secret.txt"),
    );
    // Classified on THAT path, the write is high.
    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", projectRoot),
          executionCwd: projectRoot,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });

    // Classified on the RAW declared value — what the reviewer actually gets — the verdict is now the SAME. Pre-alignment the literal `~` segment landed under the project and this read `low` "write at allowed-dir leaf".
    expect(
      classifier.classify(
        writeContext({
          declaredValue: "~/secret.txt",
          executionCwd: projectRoot,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });
  });

  it("expands a home write outside a nested allowed directory", () => {
    // Only the nested cwd is allowed. Treating ~ as a literal cwd segment would incorrectly classify this external home write as low risk.
    const deepCwd = pathResolve(homedir(), "a", "b", "c");
    vi.spyOn(process, "cwd").mockReturnValue(deepCwd);
    const allowed = [canonicalizePathForMatch(deepCwd).toLowerCase()];

    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", deepCwd),
          executionCwd: deepCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });

    expect(
      classifier.classify(
        writeContext({
          declaredValue: "~/secret.txt",
          executionCwd: deepCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });
  });
});

describe("reviewer vs. pipeline: relative values", () => {
  it("resolves a relative value against the invocation cwd, not process.cwd", () => {
    const invocationCwd = pathResolve("/work/project");
    const processCwd = pathResolve("/somewhere/else");
    vi.spyOn(process, "cwd").mockReturnValue(processCwd);

    // Pipeline: invocation cwd.
    expect(resolveToolPathForPermission("notes/x.md", invocationCwd)).toBe(
      pathResolve(invocationCwd, "notes/x.md"),
    );

    // Reviewer: same. Only the invocation cwd is allowed, so a process.cwd-based resolution would read as out of scope.
    const allowed = [canonicalizePathForMatch(invocationCwd).toLowerCase()];
    expect(
      classifier.classify(
        writeContext({
          declaredValue: "notes/x.md",
          executionCwd: invocationCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low" });

    // …and the process-cwd form really is outside that scope, so the assertion above is capable of failing rather than passing for a trivial reason.
    expect(
      canonicalizePathForMatch(pathResolve(processCwd, "notes/x.md"))
        .toLowerCase()
        .startsWith(allowed[0]),
    ).toBe(false);
  });
});
