import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WindowsConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { forgetWindowsDenyStampsAsync, stampWindowsAcl, stampWindowsAclAsync } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const scratch = useTempDirs("persistent-deny-transport-");

function helper(reply: unknown = [], code = 0) {
  const root = scratch();
  const script = join(root, "acl-helper.mjs");
  const callsPath = join(root, "calls.jsonl");
  writeFileSync(script, [
    'import { appendFileSync, readFileSync } from "node:fs";',
    `const args = process.argv.slice(2);`,
    `const input = args[1] === "stamp" ? JSON.parse(readFileSync(0, "utf8")) : undefined;`,
    `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, input }) + "\\n");`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(reply))});`,
    `process.exitCode = ${code};`,
  ].join("\n"));
  return {
    srtWin: { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [script] },
    calls: () => readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; input?: unknown }),
  };
}

describe("durable deny transport", () => {
  it("retains the owner in the shared Windows schema and rejects invalid owner names", () => {
    expect(WindowsConfigSchema.parse({ persistentDenyOwner: "ave" })).toEqual({ persistentDenyOwner: "ave" });
    expect(() => WindowsConfigSchema.parse({ persistentDenyOwner: "../another-owner" })).toThrow();
  });

  it.each([stampWindowsAcl, stampWindowsAclAsync])("passes exact durable lists and the live holder to native reconciliation", async stamp => {
    const runtime = helper();
    const denyRead = [join(scratch(), "private")];
    const denyWrite = [join(scratch(), "protected")];
    await stamp({ ...runtime, sandboxUserSid: "S-1-5-21-123", persistentOwner: "ave", holderPid: 4321, denyRead, denyWrite });
    expect(runtime.calls()).toEqual([{
      args: ["acl", "stamp", "--holder-pid", "4321", "--sandbox-user-sid", "S-1-5-21-123", "--persistent-owner", "ave"],
      input: { denyRead, denyWrite },
    }]);
  });

  it("keeps ordinary direct and per-exec stamps transient", async () => {
    const runtime = helper();
    await stampWindowsAclAsync({ ...runtime, sandboxUserSid: "S-1-5-21-123", denyRead: [], denyWrite: [] });
    expect(runtime.calls()[0]?.args).not.toContain("--persistent-owner");
  });

  it("explicit teardown addresses one owner without a caller-supplied trustee", async () => {
    const runtime = helper([{ path: "D:\\fixture", status: "stillHeld" }]);
    await expect(forgetWindowsDenyStampsAsync({ ...runtime, persistentOwner: "ave", timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclMutationMs }))
      .resolves.toEqual([{ path: "D:\\fixture", status: "stillHeld" }]);
    expect(runtime.calls()).toEqual([{ args: ["acl", "forget-denies", "--persistent-owner", "ave", "--json"] }]);
  });

  it.each([
    { reply: [], code: 2 },
    { reply: [{ path: "D:\\fixture", status: "failed" }], code: 0 },
    { reply: { removed: true }, code: 0 },
  ])("rejects incomplete teardown: $reply / exit $code", async ({ reply, code }) => {
    await expect(forgetWindowsDenyStampsAsync({ ...helper(reply, code), persistentOwner: "ave", timeoutMs: TOOL_TIMEOUT_POLICY.windowsAclMutationMs })).rejects.toThrow();
  });
});
