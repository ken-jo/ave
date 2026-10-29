// Policy refusals must name the rule, state whether retries can help, and identify legitimate alternative directories.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { hostFilesystemPath } from "../../__tests__/support/host-filesystem-path.js";
import { buildPolicyDenialGuidance } from "../invocation-runner.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ToolPermissionContext } from "../executor.js";

// A readable system file outside the allowed directories, named natively on each host.
const HOSTS_FILE = process.platform === "win32" ? `${process.env.SystemRoot!.replaceAll("\\", "/")}/System32/drivers/etc/hosts` : "/etc/hosts";

describe("buildPolicyDenialGuidance", () => {
  it("names the judged operand and the rule that judged it", () => {
    const guidance = buildPolicyDenialGuidance({
      rule: "shell-path-policy/sandbox-boundary",
      operand: "/data/source",
      retry: "never",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work"],
    });
    expect(guidance).toContain("/data/source");
    expect(guidance).toContain("shell-path-policy/sandbox-boundary");
  });

  it("falls back to naming only the rule when no operand was judged", () => {
    // Structural refusals identify a command shape and rule, not a single target token.
    const guidance = buildPolicyDenialGuidance({
      rule: "bash-ast/recursive-delete",
      retry: "never",
      alternative: "restructure-command",
      allowedDirectories: ["/work"],
    });
    expect(guidance).toContain("bash-ast/recursive-delete");
  });

  it("distinguishes a decision no retry can change from one an authorization can", () => {
    const base = {
      rule: "r",
      operand: "/x",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work"],
    } as const;
    const never = buildPolicyDenialGuidance({ ...base, retry: "never" });
    const grant = buildPolicyDenialGuidance({ ...base, retry: "grant" });
    expect(never).not.toEqual(grant);
  });

  it("lists the authorized directories a call could target instead", () => {
    const guidance = buildPolicyDenialGuidance({
      rule: "r",
      operand: "/x",
      retry: "grant",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work", "/scratch"],
    });
    expect(guidance).toContain("/work");
    expect(guidance).toContain("/scratch");
  });

  it("truncates a long grant list rather than enumerating all of it", () => {
    const directories = Array.from({ length: 12 }, (_, i) => `/d${i}`);
    const guidance = buildPolicyDenialGuidance({
      rule: "r",
      operand: "/x",
      retry: "grant",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: directories,
    });
    expect(guidance).toContain("/d0");
    expect(guidance).not.toContain("/d11");
    expect(guidance).toContain("(+4)");
  });

  it("says the filesystem root can never be authorized, so the model stops asking for it", () => {
    const withRoot = buildPolicyDenialGuidance({
      rule: "allowed-directories/not-grantable",
      operand: "/",
      retry: "never",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work"],
      filesystemRootReference: true,
    });
    const withoutRoot = buildPolicyDenialGuidance({
      rule: "allowed-directories/not-grantable",
      operand: "/other",
      retry: "never",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work"],
    });
    expect(withRoot.length).toBeGreaterThan(withoutRoot.length);
  });

  it("names the authorized directories only when the refusal was about scope", () => {
    const scope = buildPolicyDenialGuidance({
      rule: "shell-path-policy/sandbox-boundary",
      operand: "/data/x",
      retry: "grant",
      alternative: "retarget-under-authorized-directory",
      allowedDirectories: ["/work"],
    });
    expect(scope).toContain("/work");

    // Retargeting cannot resolve a structural refusal; do not suggest alternative directories.
    const structural = buildPolicyDenialGuidance({
      rule: "bash-ast/rm-rf-root",
      retry: "never",
      alternative: "restructure-command",
      allowedDirectories: ["/work"],
    });
    expect(structural).not.toContain("/work");

    // Protected paths cannot be granted; never suggest requesting an exception.
    const protectedPath = buildPolicyDenialGuidance({
      rule: "sensitive-paths/**/.ssh/**",
      operand: "/home/u/.ssh/id_rsa",
      retry: "never",
      alternative: "path-never-readable",
      allowedDirectories: ["/work"],
    });
    expect(protectedPath).not.toContain("/work");
    expect(protectedPath).toContain("/home/u/.ssh/id_rsa");
  });
});

function makeCommandBearingTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "plugin_run_command",
    description: "A plugin tool whose argument carries a shell command string.",
    source: "plugin",
    pluginId: "p-denial-guidance",
    category: "read",
    pathFields: [],
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: { command: { type: "string" } } },
    execute: async () => {
      spy.ran = true;
      return { output: "ran", isError: false };
    },
  });
}

async function runUnattended(
  command: string,
  mode: "strict" | "allow" = "strict",
): Promise<{ isError: boolean; content: string; ran: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "ave-denial-guidance-"));
  try {
    const spy = { ran: false };
    const registry = new ToolRegistry();
    registry.register(makeCommandBearingTool(spy));
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
    // Headless calls have no interactive approval surface.
    const permissionContext: ToolPermissionContext = {
      trustOrigin: "user-keyboard",
      headless: true,
    };
    const results = await executor.executeAll(
      [{ id: "tu-denial-guidance", name: "plugin_run_command", input: { command } }],
      { sessionId: "sess-denial-guidance", permissionContext },
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

describe("policy denials carry their guidance through to the tool result", () => {
  it("keeps the permission-denial prefix for a headless host-shell request", async () => {
    const result = await runUnattended("cat $PROJECT_SECRET/file.txt");
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    // Match the suite's Korean locale.
    expect(result.content).toContain("[권한 차단]");
  });

  it("tells the model nobody can approve an opaque headless host-shell request", async () => {
    const result = await runUnattended("cat $PROJECT_SECRET/file.txt");
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.content).toContain("Nobody can approve this request; do not retry.");
  });

  it("admits a quoted literal filename through Allow mode", async () => {
    const result = await runUnattended("cat '$PROJECT_SECRET/file.txt'", "allow");
    expect(result.isError).toBe(false);
    expect(result.ran).toBe(true);
  });

  it("denies a headless root-write request without offering a grant", async () => {
    const result = await runUnattended(`chmod u+w ${hostFilesystemPath("/")}`);
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.content).toContain("Nobody can approve this request; do not retry.");
  });

  it("denies a headless outside-write request with the no-retry instruction", async () => {
    const result = await runUnattended(`chmod u+w ${hostFilesystemPath("/var/tmp/ave-denial-guidance-outside/x")}`);
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.content).toContain("Nobody can approve this request; do not retry.");
  });

  it("lets an ordinary wide read run in Allow mode", async () => {
    const result = await runUnattended(`cat ${HOSTS_FILE}`, "allow");
    expect(result.isError).toBe(false);
    expect(result.ran).toBe(true);
  });
  it("keeps host credential stores admission-denied even in Allow mode", async () => {
    const target = join(tmpdir(), "policy-guidance", ".ave", "secrets", "token");
    const result = await runUnattended(`cat ${shellQuote(target)}`, "allow");
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.content).toContain("sensitive-path");
  });

});
