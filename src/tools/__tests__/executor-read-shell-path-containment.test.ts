// Command-bearing inputs retain secret-read modes and credential admission after read-risk inspection.
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
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";

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
  mode: "default" | "allow" = "default",
): Promise<{ isError: boolean; content: string; ran: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "ave-read-containment-"));
  try {
    const spy = { ran: false };
    const registry = new ToolRegistry();
    registry.register(makeCommandBearingPluginTool(spy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode(mode);
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
  it("requires the normal card for a secret-file operand the host classifies as read", async () => {
    const command = `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`;
    // A read verdict does not override the secret-read mode decision.
    expect(inspectHostRisk({ source: "plugin", finalInput: { command } })).toBe("read");

    const result = await runPluginCommand({ command });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(NO_APPROVER_MESSAGE);
    expect(result.ran).toBe(false);
  });

  it("applies the normal card to secret reads in a non-primary command field too", async () => {
    const result = await runPluginCommand({
      command: "cat ./notes.txt",
      script: `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(NO_APPROVER_MESSAGE);
    expect(result.ran).toBe(false);
  });

  it.each(["primary", "secondary"] as const)("allows ordinary secret reads in the %s field under Allow mode", async field => {
    const secret = `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`;
    const input = field === "primary" ? { command: secret } : { command: "cat ./notes.txt", script: secret };
    const result = await runPluginCommand(input, "allow");
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ran");
    expect(result.ran).toBe(true);
  });

  it.each(["primary", "secondary"] as const)("keeps host credential admission in the %s field despite Allow mode", async field => {
    const credential = `cat ${shellQuote(join(homedir(), ".ave", "secrets", "token.json"))}`;
    const input = field === "primary" ? { command: credential } : { command: "cat ./notes.txt", script: credential };
    const result = await runPluginCommand(input, "allow");
    expect(result.isError).toBe(true);
    expect(result.content).not.toBe(NO_APPROVER_MESSAGE);
    expect(result.content).toMatch(/credential|Sensitive path/i);
    expect(result.ran).toBe(false);
  });
});
