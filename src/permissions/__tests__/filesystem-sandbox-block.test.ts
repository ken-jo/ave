import { beforeEach, expect, it, vi } from "vitest";
import type { AsrtViolationRecord } from "../asrt-sandbox.js";
import { filesystemSandboxBlockForCommand } from "../asrt-sandbox.js";
import { attachSandboxBlock, sandboxBlockForResult } from "../../shared/sandbox-block.js";

const fixture = vi.hoisted(() => ({ records: new Map<string, AsrtViolationRecord[]>(), get: vi.fn() }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  getSandboxViolationStore: () => ({ getViolationsForCommand: fixture.get }),
} }));
const commandId = "opaque-filesystem-invocation-token";
beforeEach(() => {
  fixture.records.clear();
  fixture.get.mockReset().mockImplementation((id: string) => fixture.records.get(id) ?? []);
});
const record = (line: string): AsrtViolationRecord => ({ line, timestamp: new Date(), encodedCommand: Buffer.from(commandId).toString("base64") });

it.each(["file-read-data", "file-read-metadata", "file-write-create", "file-write-unlink"])("uses an attributed native %s denial record", async (operation) => {
  fixture.records.set(commandId, [record(`bash(1234) deny(1) ${operation} /workspace/target`)]);
  const block = await filesystemSandboxBlockForCommand(commandId, "printf original", "/workspace");
  expect(block).toEqual({ command: "printf original", cwd: "/workspace" });
  expect(fixture.get).toHaveBeenCalledWith(commandId);
  const result = {};
  attachSandboxBlock(result, block!);
  expect(sandboxBlockForResult(result)).toBe(block);
});

it.each([
  "deny network-outbound example.invalid:443 (blocked by policy)",
  "deny http-request GET https://example.invalid/ (bash(1234) deny(1) file-write-create /target)",
  "fail network-outbound example.invalid:443 (timeout: unreachable)",
  "node(1234) deny(1) network-outbound /target",
  "node(1234) deny(1) mach-lookup service",
  "Permission denied: file-write-create /target",
  "deny openat /target",
  "deny renameat2 /target",
  "deny syscall /target",
  "node(1234) allow(1) file-read-data /target",
])("does not turn unrelated or diagnostic events into filesystem escalation: %s", async (line) => {
  fixture.records.set(commandId, [record(line)]);
  expect(await filesystemSandboxBlockForCommand(commandId, "original", "/workspace")).toBeUndefined();
});

it("does not infer a denial from command text or another invocation", async () => {
  fixture.records.set("another-invocation", [record("bash(1234) deny(1) file-write-create /target")]);
  expect(await filesystemSandboxBlockForCommand(commandId, "echo 'bash(1234) deny(1) file-write-create /target'", "/workspace")).toBeUndefined();
});
