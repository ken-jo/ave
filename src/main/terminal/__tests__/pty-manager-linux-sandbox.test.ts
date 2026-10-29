import { killTerminal } from "../../../__tests__/support/terminal-agent-fixture.js";
import { spawnTerminal, writeTerminal, resizeTerminal, typeTerminalCommand, verifyTerminalShell, getTerminalBlockTracker } from "../../../__tests__/support/terminal-agent-fixture.js";
/** The workspace terminal under the REAL Linux sandbox (bubblewrap through the sandbox runtime, util-linux script as the shell's pty relay, node-pty): what the user's keys and terminal_run do there. Unit tests stub every one of those layers; the failures this file guards against only exist with all of them present: - Ctrl-C used to
 * reach the outer bubblewrap as SIGINT (the pty's foreground group) and end the whole terminal; - terminal_run found bubblewrap, not the shell, in the foreground and refused every sandboxed terminal. Linux only, and only where the sandbox can start (bubblewrap, socat, ripgrep; AVE_REQUIRE_SANDBOX_CASES=1 turns a skip into a failure). */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { isAsrtSandboxActive, resetAsrtSandbox, useAppOwnedSandboxTempRoot } from "../../../permissions/asrt-sandbox.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../../__tests__/support/native-sandbox.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../../../permissions/sandbox-capability.js";
import { requireSandboxCases } from "../../../plugins/isolation/__tests__/sandbox-cases.js";
import { waitForTerminal } from "../../../__tests__/support/terminal-markers.js";
import {
  __resetTerminalsForTest,
  __terminalSessionCountForTest,
  sandboxedShellVerdict,
  _setTerminalInspectionForTest,
} from "../pty-manager.js";
import { parseProcStat, readSandboxedShell } from "../shell-process.js";
import { USER_INPUT_QUIET_MS, type TerminalBlockTracker } from "../terminal-blocks.js";
import { t } from "../../../i18n/index.js";

const OWNER = 1;
let root: string;
let exits: string[];
/** Everything each terminal showed, for a failure's message. */
let shown: Map<string, string>;

const until = (condition: () => boolean, timeoutMs = 10_000): Promise<void> => waitForTerminal(condition, timeoutMs);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pty-linux-sandbox-")));
  // A directory the sandbox masks with an empty tmpfs (the read floor denies ~/.ssh).
  mkdirSync(join(root, ".ssh"));
  // A real HOME has one; the write floor's nested denies need it to exist.
  mkdirSync(join(root, ".config"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("AVE_HOME", join(root, ".ave"));
  vi.stubEnv("CLAUDE_CODE_TMPDIR", process.env.CLAUDE_CODE_TMPDIR);
  vi.stubEnv("CLAUDE_TMPDIR", process.env.CLAUDE_TMPDIR);
  // Match the host contract: the workspace is below HOME, never HOME itself.
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  vi.spyOn(process, "cwd").mockReturnValue(workspace);
  exits = [];
  shown = new Map();
  _setTerminalInspectionForTest((event, payload) => {
    const { tabId } = payload as { tabId: string };
    if (event === "exit") exits.push(tabId);
    else shown.set(tabId, (shown.get(tabId) ?? "") + (payload as { chunk: string }).chunk);
  });
});

afterEach(async () => {
  // End each terminal the way a closed tab does, and wait for its exit.
  for (const tabId of shown.keys()) {
    killTerminal(tabId);
    await until(() => exits.includes(tabId)).catch(() => undefined);
  }
  expect(__terminalSessionCountForTest()).toBe(0);
  __resetTerminalsForTest();
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

async function startSandboxedShell(shellPath: string, tabId: string): Promise<TerminalBlockTracker> {
  useAppOwnedSandboxTempRoot();
  setShellSandboxRequestedAtBoot(true);
  await initializeRequiredSandbox({ allowedDomains: [], strictAllowlist: true });
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "linux",
    reason: "bubblewrap",
    confines: { filesystem: true, process: true, network: true },
  });
  vi.stubEnv("SHELL", shellPath);
  const spawned = await spawnTerminal({ tabId, ownerWindowId: OWNER, cols: 100, rows: 30 });
  expect(spawned, JSON.stringify(spawned)).toMatchObject({ ok: true });
  const tracker = getTerminalBlockTracker(tabId)!;
  try {
    await until(() => tracker.promptEndCount() > 0, 20_000);
    await until(() => tracker.promptState() === "ready" || tracker.promptState() === "not-found-handler");
    // A system startup file may define a handler: the user has a prompt, while agent typing is refused.
    // Check that refusal before removing the handler through the user's input path for the rest of these cases.
    if (tracker.promptState() === "not-found-handler") {
      const blockId = tracker.nextBlockId();
      await expect(typeTerminalCommand(tabId, OWNER, "echo agent-must-not-run", tracker.currentCwd()!)).resolves.toMatchObject({
        ok: false,
        reason: "not-found-handler",
      });
      expect(tracker.nextBlockId()).toBe(blockId);
      const removeHandler = shellPath.endsWith("/zsh") ? "unfunction command_not_found_handler" : "unset -f command_not_found_handle";
      await userRuns(tabId, tracker, `echo user-prompt-ready; ${removeHandler}`);
      await until(() => tracker.get(blockId)?.status === "done");
      expect(tracker.get(blockId)!.output).toBe("user-prompt-ready\n");
      expect(tracker.get(blockId)!.exitCode).toBe(0);
    }
    await settle(tracker);
  } catch (error) {
    throw new Error(`${(error as Error).message}; prompt state ${tracker.promptState()}; prompt ends ${tracker.promptEndCount()}; the terminal showed ${JSON.stringify(shown.get(tabId) ?? "")}; exits ${JSON.stringify(exits)}`);
  }
  return tracker;
}

/** Wait until the prompt is up and the last key has gone quiet. */
async function settle(tracker: TerminalBlockTracker): Promise<void> {
  await sleep(USER_INPUT_QUIET_MS + 200);
  await until(() => tracker.promptState() === "ready");
}

/** Type a line as the user would, with Enter, and wait for its block to start. */
async function userRuns(tabId: string, tracker: TerminalBlockTracker, line: string): Promise<void> {
  const before = tracker.nextBlockId();
  writeTerminal(tabId, `${line}\r`);
  await until(() => tracker.nextBlockId() > before);
}

async function typeAndWait(tabId: string, tracker: TerminalBlockTracker, line: string): Promise<string> {
  const before = shown.get(tabId) ?? "";
  const prompts = tracker.promptEndCount();
  const typed = await typeTerminalCommand(tabId, OWNER, line, tracker.currentCwd()!);
  // A refusal names what the terminal showed while typing, so a CI-only failure carries the shell's own bytes.
  expect(typed, `${JSON.stringify(typed)}; prompt ends ${prompts} -> ${tracker.promptEndCount()}; edit line ${JSON.stringify(tracker.editLineText())}; `
    + `before typing ${JSON.stringify(before.slice(-1500))}; while typing ${JSON.stringify((shown.get(tabId) ?? "").slice(before.length))}`).toMatchObject({ ok: true });
  const id = (typed as { firstBlockId: number }).firstBlockId;
  await until(() => tracker.get(id)?.status === "done");
  expect(tracker.get(id)!.command).toBe(line);
  return tracker.get(id)!.output;
}

const REQUIRED_SHELLS = ["/bin/zsh", "/bin/bash"];
const SHELLS = REQUIRED_SHELLS.filter((path) => existsSync(path));
if (process.platform === "linux" && process.env.AVE_REQUIRE_SANDBOX_CASES === "1") {
  const missing = REQUIRED_SHELLS.filter((path) => !existsSync(path));
  if (missing.length > 0) throw new Error(`Required sandbox shells are missing: ${missing.join(", ")}`);
}

describe.runIf(process.platform === "linux")("workspace terminal under the Linux sandbox", () => {
  for (const shellPath of SHELLS) {
    const name = shellPath.split("/").pop()!;
    const tabId = name === "zsh" ? "terminal:000000a1-1" : "terminal:000000a2-1";

    it(`${name}: Ctrl-C interrupts a running command and clears an idle line; the terminal survives`, async (test) => {
      await requireSandboxCases(test);
      const tracker = await startSandboxedShell(shellPath, tabId);
      // The shell has its own terminal: job control is on.
      expect(await typeAndWait(tabId, tracker, "case $- in *m*) echo monitor-on;; esac")).toBe("monitor-on\n");
      await settle(tracker);

      await userRuns(tabId, tracker, "sleep 100");
      await until(() => tracker.promptState() === "command-running");
      const sleeping = tracker.nextBlockId() - 1;
      writeTerminal(tabId, "\u0003");
      await until(() => tracker.get(sleeping)?.status === "done", 5_000);
      expect(tracker.get(sleeping)!.exitCode).toBe(130);
      expect(exits).toEqual([]);

      // Ctrl-C at the prompt drops the half-typed line and draws a fresh prompt.
      await settle(tracker);
      writeTerminal(tabId, "echo never-run");
      await until(() => tracker.editLineText().includes("echo never-run"));
      const prompts = tracker.promptEndCount();
      writeTerminal(tabId, "\u0003");
      await until(() => tracker.promptEndCount() > prompts, 5_000);
      expect(tracker.editLineText()).toBe("");
      await settle(tracker);
      expect(await typeAndWait(tabId, tracker, "echo still-here")).toBe("still-here\n");
      expect(exits).toEqual([]);
      expect(__terminalSessionCountForTest()).toBe(1);
    }, 90_000);

    it(`${name}: a resize reaches the shell's own terminal`, async (test) => {
      await requireSandboxCases(test);
      const tracker = await startSandboxedShell(shellPath, tabId);
      expect(await typeAndWait(tabId, tracker, "stty size")).toBe("30 100\n");
      await settle(tracker);
      resizeTerminal(tabId, 132, 41);
      await sleep(500);
      await settle(tracker);
      expect(await typeAndWait(tabId, tracker, "stty size")).toBe("41 132\n");
    }, 90_000);

    it.skipIf(shouldSkipNativeSandboxTests())(`${name}: new repository controls refuse agent typing; raw input keeps the documented window until reopen`, async () => {
      const tracker = await startSandboxedShell(shellPath, tabId);
      const marker = join(process.cwd(), "later", ".git");
      mkdirSync(join(marker, "hooks"), { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "original\n");
      await expect(typeTerminalCommand(tabId, OWNER, "git status", tracker.currentCwd()!)).resolves.toMatchObject({
        ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged"),
      });
      expect(shown.get(tabId)).toContain(t("sandboxPolicy.terminalWindow"));

      // Raw input reaches the original namespace. The write happens while a foreground process still withholds the next command-end marker.
      await userRuns(tabId, tracker, "printf changed > later/.git/config && printf hook > later/.git/hooks/pre-commit && sleep 100");
      await until(() => readFileSync(join(marker, "config"), "utf8") === "changed");
      expect(readFileSync(join(marker, "hooks", "pre-commit"), "utf8")).toBe("hook");
      expect(tracker.get(tracker.nextBlockId() - 1)?.status).toBe("running");
      killTerminal(tabId);
      await until(() => exits.includes(tabId));
      expect(existsSync(marker)).toBe(false);
      expect(shown.get(tabId)).toContain(JSON.stringify(marker));
      await resetAsrtSandbox();
      exits = [];

      mkdirSync(join(marker, "hooks"), { recursive: true });
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "changed");
      const reopened = await startSandboxedShell(shellPath, tabId);
      const id = reopened.nextBlockId();
      await typeAndWait(tabId, reopened, "printf blocked > later/.git/config");
      expect(reopened.get(id)?.exitCode).not.toBe(0);
      expect(readFileSync(join(marker, "config"), "utf8")).toBe("changed");
    }, 90_000);

    it.skipIf(shouldSkipNativeSandboxTests())(`${name}: a newly created control requires reopen and is quarantined when the shell exits`, async () => {
      const marker = join(process.cwd(), ".git");
      mkdirSync(join(marker, "objects"), { recursive: true });
      mkdirSync(join(marker, "refs"));
      writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(marker, "config"), "[core]\n\tbare = false\n");
      const control = join(marker, "commondir");
      const tracker = await startSandboxedShell(shellPath, tabId);
      expect(existsSync(control)).toBe(false);
      await typeAndWait(tabId, tracker, "printf . > .git/commondir");
      expect(readFileSync(control, "utf8")).toBe(".");
      await settle(tracker);
      await expect(typeTerminalCommand(tabId, OWNER, "git status", tracker.currentCwd()!)).resolves.toMatchObject({
        ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged"),
      });
      expect(existsSync(control)).toBe(true);
      killTerminal(tabId);
      await until(() => exits.includes(tabId));
      expect(existsSync(control)).toBe(false);
      expect(existsSync(join(marker, "HEAD"))).toBe(true);
      expect(shown.get(tabId)).toContain(JSON.stringify(control));
      const notice = t("sandboxPolicy.quarantined", { moves: "" });
      expect(shown.get(tabId)).toContain(notice.split("\n")[0]);
      expect(shown.get(tabId)).toContain(notice.split("\n").at(-1));
    }, 90_000);

    it(`${name}: terminal_run types at the shell's prompt, and refuses a busy, nested or moved shell`, async (test) => {
      await requireSandboxCases(test);
      const tracker = await startSandboxedShell(shellPath, tabId);
      const cwd = tracker.currentCwd()!;
      expect(await verifyTerminalShell(tabId, OWNER, cwd)).toEqual({ ok: true, cwd });
      expect(await typeAndWait(tabId, tracker, "echo approved 'a b' && pwd")).toBe(`approved a b\n${cwd}\n`);
      await settle(tracker);

      // The shell the prompt reported, as the process table finds it.
      const reading = await readSandboxedShell(writtenPtyPid(), name, cwd);
      expect(reading).toMatchObject({ ok: true, shell: { command: name, children: [] } });
      const nsPid = (reading as { shell: { nsPid: number } }).shell.nsPid;
      expect(tracker.reportedShellPid()).toBe(nsPid);
      expect(sandboxedShellVerdict(reading, cwd, nsPid + 1)).toMatchObject({ ok: false, reason: "foreground-not-shell" });

      // A running command holds the shell's terminal.
      await userRuns(tabId, tracker, "sleep 30");
      await sleep(300);
      expect(await verifyTerminalShell(tabId, OWNER, cwd)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
      writeTerminal(tabId, "\u0003");
      await settle(tracker);

      // A background job: the shell is at its prompt, but not alone.
      await userRuns(tabId, tracker, "sleep 30 &");
      await settle(tracker);
      await expect(typeTerminalCommand(tabId, OWNER, "echo hi", cwd)).resolves.toMatchObject({ ok: false, reason: "shell-busy" });
      await userRuns(tabId, tracker, "kill %1");
      await settle(tracker);
      await until(() => tracker.promptState() === "ready");
      expect(await verifyTerminalShell(tabId, OWNER, cwd)).toEqual({ ok: true, cwd });

      // A nested shell holds the terminal (and reports no markers).
      writeTerminal(tabId, `${shellPath} ${name === "zsh" ? "-f" : "--norc --noprofile"}\r`);
      await sleep(1_000);
      expect(await verifyTerminalShell(tabId, OWNER, cwd)).toMatchObject({ ok: false, reason: "foreground-not-shell" });
      writeTerminal(tabId, "exit\r");
      await settle(tracker);

      // A directory only the sandbox has: an empty tmpfs where the host has ~/.ssh.
      const masked = join(root, ".ssh");
      await userRuns(tabId, tracker, `cd ${masked}`);
      await settle(tracker);
      expect(tracker.currentCwd()).toBe(masked);
      expect(await verifyTerminalShell(tabId, OWNER, masked)).toMatchObject({ ok: false, reason: "cwd-mismatch" });
      await expect(typeTerminalCommand(tabId, OWNER, "echo hi", masked)).resolves.toMatchObject({ ok: false, reason: "cwd-mismatch" });
      expect(exits).toEqual([]);
    }, 120_000);
  }
});

/** The pid node-pty spawned for the one terminal: the outer bubblewrap, a child of this process. */
function writtenPtyPid(): number {
  const pids = readdirSync("/proc").filter((name) => /^[0-9]+$/u.test(name)).filter((pid) => {
    try {
      const stat = parseProcStat(Number(pid), readFileSync(`/proc/${pid}/stat`, "utf-8"));
      return stat.command === "bwrap" && stat.ppid === process.pid;
    } catch {
      return false;
    }
  });
  expect(pids).toHaveLength(1);
  return Number(pids[0]);
}
