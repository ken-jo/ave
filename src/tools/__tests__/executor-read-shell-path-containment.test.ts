// Command-bearing inputs always require sensitive-path and directory checks, even with a read-risk verdict.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { inspectHostRisk } from "../../permissions/reviewer/host-risk-inspector.js";
import type { ToolPermissionContext } from "../executor.js";

function makeCommandBearingPluginTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "plugin_run_command",
    description: "A plugin tool whose argument carries a shell command string.",
    source: "plugin",
    pluginId: "p-shellish",
    category: "read",
    pathFields: [],
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
    execute: async () => {
      spy.ran = true;
      return { output: "ran", isError: false };
    },
  });
}

async function runPluginCommand(
  input: Record<string, unknown>,
): Promise<{ isError: boolean; content: string; ran: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "ave-read-containment-"));
  try {
    const spy = { ran: false };
    const registry = new ToolRegistry();
    registry.register(makeCommandBearingPluginTool(spy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
    );
    const permissionContext: ToolPermissionContext = { trustOrigin: "user-keyboard" };
    const results = await executor.executeAll(
      [{ id: "tu-read-containment", name: "plugin_run_command", input }],
      { sessionId: "sess-read-containment", permissionContext },
    );
    return {
      isError: results[0]!.is_error === true,
      content: String(results[0]!.content),
      ran: spy.ran,
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("ToolExecutor — shell path containment runs for read-classified commands", () => {
  it("blocks a sensitive-path operand on a command the host classifies as read", async () => {
    const command = `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`;
    // A read verdict must still reach shell path containment.
    expect(inspectHostRisk({ source: "plugin", finalInput: { command } })).toBe("read");

    const result = await runPluginCommand({ command });
    expect(result.isError).toBe(true);
    // Require a path-policy block, not an unrelated approval denial.
    expect(result.content).toContain("Shell");
    expect(result.content).toContain("Sensitive path");
    expect(result.ran).toBe(false);
  });

  it("blocks a command carried by a non-primary field (script) too", async () => {
    const result = await runPluginCommand({
      command: "cat ./notes.txt",
      script: `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Sensitive path");
    expect(result.ran).toBe(false);
  });
});
