import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fenceTerminalData, terminalToolFailure } from "../../../tools/terminal-read.js";
import { prepareTerminalGitPolicyCheck, terminalSandboxWindowNotice } from "../terminal-sandbox-policy.js";
import { getLocale, setLocale } from "../../../i18n/index.js";
import { buildMandatorySandboxWritePolicy } from "../../../permissions/sandbox-write-policy.js";

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
      const changed = prepareTerminalGitPolicyCheck([root], initial)!;
      expect(changed()).toBe(false);
      const marker = join(root, "later", ".git");
      mkdirSync(join(marker, "hooks"), { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "[core]\n");
      expect(changed()).toBe(true);
      expect(changed()).toBe(true);
      expect(prepareTerminalGitPolicyCheck([root], initial)!()).toBe(true);
      expect(prepareTerminalGitPolicyCheck([root], buildMandatorySandboxWritePolicy([root]))!()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing Linux runtime policy snapshot", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(() => prepareTerminalGitPolicyCheck([], undefined)).toThrow("filesystem policy is unavailable");
  });
});
