// Attached option values must not be parsed as extra flags; single-quoted dollar signs cannot expand. Keep the unquoted-expansion and mutating-command negative controls.
import { describe, expect, it } from "vitest";

import { inspectBuiltinCommandRisk } from "../../__tests__/test-helpers.js";

describe("git short flags with a glued value", () => {
  it.each([
    ["git log -Sneedle", "pickaxe search, value glued"],
    ["git log -S needle", "the same search, value separated"],
    ["git log -Gregex", "diff-content search"],
    ["git log -L10,20:file.ts", "line-range log"],
    ["git log -n5", "max count"],
    ["git diff -U5", "context lines — digits already ended the cluster"],
  ])("%s reads (%s)", (command) => {
    expect(inspectBuiltinCommandRisk(command)).toBe("read");
  });

  it("still escalates an unknown flag letter", () => {
    // The value-taking rule decides where a flag ENDS. It must not decide that the flag is allowed: `-X` is not in the read-only letter set.
    expect(inspectBuiltinCommandRisk("git log -Xbogus")).toBe("shell");
  });

  it("still escalates a writing form of a read-only subcommand", () => {
    expect(inspectBuiltinCommandRisk("git log --output=/tmp/x")).toBe("shell");
  });

  it("still escalates a mutating subcommand", () => {
    expect(inspectBuiltinCommandRisk("git commit -m x")).toBe("shell");
  });
});

describe("dollar in an argument", () => {
  it.each([
    ["rg 'foo$'", "regex anchor, single-quoted"],
    ["rg 'a$' src", "same, with a path operand"],
    ["grep 'foo$' file.txt", "the verb that always allowed it"],
  ])("%s reads (%s)", (command) => {
    expect(inspectBuiltinCommandRisk(command)).toBe("read");
  });

  it.each([
    ["sed $IFS-i f", "word-splits into -i after expansion"],
    ["rg $IFS--pre=evil p", "word-splits into --pre, which runs a program"],
  ])("%s stays shell (%s)", (command) => {
    expect(inspectBuiltinCommandRisk(command)).toBe("shell");
  });

  it("keeps a double-quoted expansion out of read", () => {
    // Double quotes suppress word splitting but NOT expansion, and the expanded value can be a flag in its entirety. Only single quotes prove the `$` is literal, so only they earn the exemption.
    expect(inspectBuiltinCommandRisk('rg "$FLAG" p')).toBe("shell");
  });

  it("keeps a command substitution out of read regardless of quoting", () => {
    expect(inspectBuiltinCommandRisk("rg $(cat /tmp/p) f")).toBe("shell");
  });
});
