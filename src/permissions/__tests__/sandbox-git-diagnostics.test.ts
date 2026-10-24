import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: { annotateStderrWithSandboxFailures: (_id: string, text: string) => text },
}));

import { annotateWithSandboxViolations } from "../asrt-sandbox.js";

describe("protected Git metadata diagnostics", () => {
  it.each([
    "/project/.git: Operation not permitted",
    "fatal: cannot create /project/.git/config: Read-only file system",
    "fatal: .GIT/hooks/pre-commit: Permission denied",
    "fatal: invalid gitfile format: /project/.git",
  ])("explains the existing approval route for %s", async message => {
    const output = await annotateWithSandboxViolations("command", message);
    expect(output).toContain("`.git` metadata is protected; rerun outside the sandbox after approval");
    expect(output).toContain('executionMode: "host"');
    expect(output).toContain("host approval is required");
    expect(await annotateWithSandboxViolations("command", output)).toBe(output);
  });

  it("explains the read-only missing-marker clone destination", async () => {
    const output = await annotateWithSandboxViolations("command",
      "fatal: destination path '.' already exists and is not an empty directory.",
      "git -c protocol.file.allow=always clone --local source .");
    expect(output).toContain("`.git` metadata is protected; rerun outside the sandbox after approval");
  });

  it.each(["git status succeeded", ".git/HEAD changed", "ordinary: Permission denied"])("preserves unrelated output: %s", async message => {
    expect(await annotateWithSandboxViolations("command", message)).toBe(message);
  });
});
