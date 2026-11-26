// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { takeWindowsHelperLaunches } from "../../__tests__/support/windows-helper-spawns.js";
import { configureHostResources } from "../../main/host-resources.js";
import { hostShellAnalysisFacts } from "../prepared-shell-invocation.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

const unreadable = vi.hoisted(() => ({ name: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const counted = (await import("../../__tests__/support/windows-helper-spawns.js")).countingChildProcess(actual);
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const argv = args[1];
    if (unreadable.name && Array.isArray(argv) && argv[0] === "--pin" && argv.some(arg => String(arg).includes(unreadable.name))) {
      counted.execFileSync(...args);
      // The helper exits 4 when it cannot open or read a requested path.
      throw Object.assign(new Error("Command failed"), { status: 4 });
    }
    return counted.execFileSync(...args);
  }) as typeof actual.execFileSync;
  return { ...counted, execFileSync, default: { ...counted, execFileSync } };
});

describe.runIf(process.platform === "win32")("operands pinned in one batch per analysis", () => {
  let root: string;
  const facts = () => hostShellAnalysisFacts(undefined, { substrate: "none" });
  const analyze = (command: string) => findShellPathPolicyViolation(command, root, root, [], true, facts());
  const chain = (names: readonly string[]) => names.map(name => `test -f ${name} && echo ok`).join("; ");
  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "pin-batch-")));
    mkdirSync(join(root, "src"));
    for (const name of ["f0", "f1", "f2", "f3", "unreadable.txt"]) writeFileSync(join(root, "src", name), "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => { unreadable.name = ""; takeWindowsHelperLaunches(); });

  it("pins every operand of the analysis in one launch", () => {
    expect(analyze(`cd src && ${chain(["f0", "f1", "f2", "f3"])}`)).toBeNull();
    // The working-directory check, the cd observation, and one batch for the four operands.
    expect(takeWindowsHelperLaunches()["--pin"]).toBe(3);
  });

  it("refuses an operand whose pin failed in the batch and keeps the other operands' verdicts", () => {
    unreadable.name = "unreadable.txt";
    expect(analyze(`cd src && ${chain(["f0", "f1", "f2", "f3"])}`)).toBeNull();
    expect(analyze(`cd src && ${chain(["f0", "unreadable.txt", "f1"])}`)).toMatchObject({ kind: "sandbox-boundary", candidate: "unreadable.txt" });
    expect(analyze(`cd src && ${chain(["unreadable.txt", "unreadable.txt"])}`)).toMatchObject({ kind: "sandbox-boundary", candidate: "unreadable.txt" });
  });

  it("reports the first violation in walk order", () => {
    unreadable.name = "unreadable.txt";
    expect(analyze(`cat ../outside.txt; cd src && ${chain(["unreadable.txt"])}`)).toMatchObject({ kind: "sandbox-boundary", candidate: "../outside.txt" });
    expect(analyze(`cd src && ${chain(["unreadable.txt"])}; cat ../../outside.txt`)).toMatchObject({ kind: "sandbox-boundary", candidate: "unreadable.txt" });
    expect(analyze(`cd src && ${chain(["unreadable.txt"])}; cat C:later.txt`)).toMatchObject({ kind: "sandbox-boundary", candidate: "unreadable.txt" });
  });
});
