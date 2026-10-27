vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { vi } from "vitest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceTerminalData, terminalToolFailure } from "../../../tools/terminal-read.js";
import { prepareTerminalGitPolicyCheck, terminalSandboxWindowNotice } from "../terminal-sandbox-policy.js";
import { getLocale, setLocale } from "../../../i18n/index.js";
import { buildMandatorySandboxWritePolicy, isGrantPathWithin, restrictSandboxGitControlSnapshot } from "../../../permissions/sandbox-write-policy.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const locale = getLocale();
beforeEach(() => setLocale("en"));
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  setLocale(locale);
});

describe("persistent terminal sandbox notice", () => {
  it("quantifies the Linux metadata window until shell exit without a time limit", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const notice = terminalSandboxWindowNotice();
    expect(notice).toContain("no time limit");
    expect(notice).toContain("background");
    expect(notice).toContain("raw terminal input");
    expect(notice).toContain("Close and reopen");
  });

  it.each([
    { lane: "agent", typed: true, finished: true, block: { output: "done" } },
    { lane: "agent", typed: true, finished: false, continuation: { blockId: 1 } },
    { lane: "agent", typed: true, finished: false, error: "not verified" },
    { lane: "agent", block: { output: "done" } },
    { terminals: [{ lane: "manual" }, { lane: "agent" }] },
  ])("adds the bound to an agent result: %j", (payload) => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const framed = fenceTerminalData(payload);
    expect(JSON.parse(framed.output.split("\n")[2]!).sandboxNotice).toBe(terminalSandboxWindowNotice());
  });

  it.each(["darwin", "win32"])("does not label %s as using a Linux mount snapshot", (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    expect(terminalSandboxWindowNotice()).toBeUndefined();
    expect(fenceTerminalData({ lane: "agent" }).output).not.toContain("sandboxNotice");
  });

  it("does not attach the agent bound to a manual-only result", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(fenceTerminalData({ lane: "manual" }).output).not.toContain("sandboxNotice");
    expect(fenceTerminalData({ terminals: [{ lane: "manual" }] }).output).not.toContain("sandboxNotice");
    expect(terminalToolFailure("manual shell failed", "manual").output).not.toContain("sandboxNotice");
    expect(terminalToolFailure("target is unknown").output).not.toContain("sandboxNotice");
  });

  it("keeps the full window notice in a host-written agent failure result", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(JSON.parse(terminalToolFailure("repository protection changed", "agent").output)).toEqual({
      error: "repository protection changed", sandboxNotice: terminalSandboxWindowNotice(),
    });
  });

  it("uses the shared bounded scan to detect a repository added after the initial snapshot", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const root = mkdtempSync(join(tmpdir(), "terminal-git-policy-"));
    try {
      const initial = buildMandatorySandboxWritePolicy([root]);
      const changed = prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!;
      expect(changed()).toBe(false);
      const marker = join(root, "later", ".git");
      mkdirSync(join(marker, "hooks"), { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "[core]\n");
      expect(changed()).toBe(true);
      expect(changed()).toBe(true);
      expect(prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!()).toBe(true);
      const reopened = buildMandatorySandboxWritePolicy([root]);
      expect(prepareTerminalGitPolicyCheck(reopened, reopened.gitControlSnapshot)!()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing Linux runtime policy snapshot", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(() => prepareTerminalGitPolicyCheck(undefined)).toThrow("filesystem policy is unavailable");
  });

  it("requires reopen after a new directory link without following it as cleanup authority", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "terminal-new-routing-")));
    try {
      const deep = join(root, "a", "b", "c", "d");
      mkdirSync(join(deep, ".git"), { recursive: true });
      writeFileSync(join(deep, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(deep, ".git", "config"), "original\n");
      const initial = buildMandatorySandboxWritePolicy([root]);
      const changed = prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!;
      expect(changed()).toBe(false);
      symlinkSync(deep, join(root, "alias"), "dir");
      expect(changed()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires reopen when an unchanged alias resolves through a replaced hidden route", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "terminal-chained-routing-")));
    try {
      const original = join(root, "original");
      const deep = join(root, "a", "b", "c", "d");
      mkdirSync(original);
      mkdirSync(join(root, ".cache"));
      mkdirSync(join(deep, ".git"), { recursive: true });
      writeFileSync(join(deep, ".git", "HEAD"), "ref: refs/heads/main\n");
      const router = join(root, ".cache", "router");
      symlinkSync(original, router, "dir");
      symlinkSync(router, join(root, "alias"), "dir");
      const initial = buildMandatorySandboxWritePolicy([root]);
      const changed = prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!;
      expect(changed()).toBe(false);
      rmSync(router);
      symlinkSync(deep, router, "dir");
      expect(changed()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts an unchanged ordinary directory link outside its write root", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const base = realpathSync(mkdtempSync(join(tmpdir(), "terminal-external-routing-")));
    const root = join(base, "work");
    const outside = join(base, "outside");
    try {
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, "alias"), "dir");
      const initial = buildMandatorySandboxWritePolicy([root]);
      const changed = prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!;
      expect(changed()).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it.each(["withheld-root", "masked-subtree"])("ignores command-inaccessible changes in %s", kind => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const base = realpathSync(mkdtempSync(join(tmpdir(), "terminal-excluded-routing-")));
    const root = join(base, "work");
    const hidden = kind === "withheld-root" ? join(base, "hidden") : join(root, "hidden");
    try {
      mkdirSync(root);
      mkdirSync(hidden);
      const initial = buildMandatorySandboxWritePolicy([root, hidden]);
      const controls = restrictSandboxGitControlSnapshot(initial.gitControlSnapshot!, [root], path => isGrantPathWithin(hidden, path));
      const changed = prepareTerminalGitPolicyCheck({ allowWrite: [root], denyWrite: initial.denyWrite }, controls)!;
      expect(changed()).toBe(false);
      mkdirSync(join(hidden, ".git"));
      writeFileSync(join(hidden, ".git", "config"), "host file\n");
      expect(changed()).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("requires the Git identities from the actual wrap instead of capturing a later baseline", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(() => prepareTerminalGitPolicyCheck({ allowWrite: [], denyWrite: [] })).toThrow("Git control snapshot is unavailable");
  });

  it.each(["partial-hooks", "new-control", "replaced-marker"])("refuses %s before the next input", kind => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const root = mkdtempSync(join(tmpdir(), "terminal-control-change-"));
    const marker = join(root, "nested", ".git");
    try {
      mkdirSync(marker, { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "[core]\n");
      const initial = buildMandatorySandboxWritePolicy([root]);
      if (kind === "partial-hooks") mkdirSync(join(root, "partial", ".git", "hooks"), { recursive: true });
      else if (kind === "new-control") writeFileSync(join(marker, "commondir"), "untrusted-target\n");
      else {
        renameSync(marker, `${marker}-original`);
        mkdirSync(marker);
        writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(marker, "config"), "[core]\n");
      }
      const changed = prepareTerminalGitPolicyCheck(initial, initial.gitControlSnapshot)!;
      expect(changed()).toBe(true);
      expect(changed()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
