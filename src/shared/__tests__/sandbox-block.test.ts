import { expect, it } from "vitest";
import { attachSandboxBlock, issueFilesystemSandboxBlock, sandboxBlockForResult } from "../sandbox-block.js";

it("keeps host-issued block evidence private to the attached result identity", () => {
  const block = issueFilesystemSandboxBlock("printf original", "/workspace");
  const result = { output: "blocked", isError: true };
  attachSandboxBlock(result, block);
  expect(sandboxBlockForResult(result)).toBe(block);
  expect(Object.isFrozen(block)).toBe(true);
  expect(sandboxBlockForResult({ ...result })).toBeUndefined();
  expect(sandboxBlockForResult(JSON.parse(JSON.stringify(result)))).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("original");
  expect(Object.keys(result)).toEqual(["output", "isError"]);
});

it("rejects structural and copied block evidence", () => {
  const result = {};
  const block = issueFilesystemSandboxBlock("original", "/workspace");
  for (const forged of [{ command: "original", cwd: "/workspace" }, { ...block }]) {
    expect(() => attachSandboxBlock(result, forged)).toThrow("Sandbox block was not issued by the host");
  }
  expect(sandboxBlockForResult(result)).toBeUndefined();
});
