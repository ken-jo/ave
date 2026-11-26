import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../approval-gate.js";

// The third column explains the route or effect that owns the card.
const FORCED_CARD_SITES = [
  ["boot/steps/plugin-tool-executor.ts", 1, "plugin operation"],
  ["engine/subagent-runner.ts", 1, "inherits the tool's request"],
  ["hooks/hook-command-policy.ts", 1, "binds"],
  ["permissions/effect-enforcement.ts", 1, "mediated effect"],
  ["permissions/egress-approval.ts", 1, "network destination"],
  ["permissions/extension-start-asker.ts", 1, "extension batch"],
  ["tools/invocation-authorization.ts", 1, "binds"],
  ["tools/invocation-execution.ts", 4, "binds and browser grants"],
  ["tools/invocation-runner.ts", 2, "binds"],
  ["tools/pipeline/user-owned-surface.ts", 1, "inherits the tool's request"],
  ["tools/skill-load.ts", 1, "skill content"],
] as const;

const source = (file: string) => readFileSync(join(process.cwd(), "src", file), "utf8");

describe("process working directory at card issue", () => {
  it("has a reviewed route for each way of forcing a card", () => {
    const files = readdirSync(join(process.cwd(), "src"), { recursive: true, encoding: "utf8" });
    const sites = files.map((file) => file.replaceAll("\\", "/"))
      .filter((file) => /\.tsx?$/.test(file) && !file.split("/").includes("__tests__") && file !== "permissions/approval-gate.ts")
      .flatMap((file) => {
        const count = source(file).match(/\bforceExplicit\s*:/g)?.length ?? 0;
        return count === 0 ? [] : [[file, count]];
      }).sort(([file], [other]) => String(file).localeCompare(String(other)));
    expect(sites).toEqual(FORCED_CARD_SITES.map(([file, count]) => [file, count]));
    for (const [file, , route] of FORCED_CARD_SITES) {
      if (!route.startsWith("binds")) continue;
      expect(source(file)).toMatch(/\bprocessCwd\b/);
    }
    expect(source("permissions/approval-gate.ts")).toMatch(/shellDirectory\.hold\(\)/);
    expect(source("tools/shell-tools.ts")).toMatch(/hostSpawnAuthorization\?\.cwdIdentity\.realpath \?\? resolvedCwd/);
  });

  it.each([true, false])("rejects a shell card with no cwd binding (forced=%s)", async (forceExplicit) => {
    const send = vi.fn();
    const gate = new ApprovalGate({ isDestroyed: () => false, send } as never);
    const controller = new AbortController();
    try {
      const pending = gate.requestAndWait({
        id: "unbound", category: "tool", toolCategory: "shell", toolName: "bash", source: "builtin",
        args: { command: "pwd" }, reason: "Shell approval", createdAt: 1,
        ...(forceExplicit ? { forceExplicit: true as const } : {}),
        abortSignal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toThrow("missing its working directory binding");
      expect(send).not.toHaveBeenCalled();
    } finally {
      controller.abort();
    }
  });
});
