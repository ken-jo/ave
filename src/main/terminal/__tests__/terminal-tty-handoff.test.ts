/**
 * The workspace terminal's own-tty grant (terminal-tty-handoff.ts), EXECUTED:
 * the real patched ASRT profile, the real node-pty, the real fifo handoff.
 *
 * Without the grant a sandboxed zsh cannot turn off ECHO, so each typed line
 * shows twice, and cannot set its foreground process group, so job control is
 * off. With it, the shell owns its own terminal and still cannot set another.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { TEST_COMMAND_ID } from "../../../__tests__/support/egress-fixture.js";

import {
  getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapTerminalCommand,
  wrapWorkerCommand,
} from "../../../permissions/asrt-sandbox.js";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";
import {
  TRAMPOLINE_ENV,
  createTerminalTtyHandoff,
  ownPtySlavePath,
  renderHandoffScript,
} from "../terminal-tty-handoff.js";
import { terminalNeedsOwnTtyGrant } from "../terminal-tty-platform.js";

describe("ownPtySlavePath", () => {
  it("returns node-pty's slave path", () => {
    expect(ownPtySlavePath({ ptsName: "/dev/ttys012" })).toBe("/dev/ttys012");
    expect(ownPtySlavePath({ ptsName: "/dev/ttys1000" })).toBe("/dev/ttys1000");
  });

  it.each([undefined, "", "/dev/ttys*", "/dev/ttys01", "/dev/tty", "/dev/pts/3", "/dev/ttys012\n", 12])(
    "refuses %j",
    (ptsName) => {
      expect(() => ownPtySlavePath({ ptsName })).toThrow(/no pty slave device/);
    },
  );

  it("refuses a missing pty", () => {
    expect(() => ownPtySlavePath(null)).toThrow(/no pty slave device/);
  });
});

describe("renderHandoffScript", () => {
  it("execs the argv under exactly the given environment, quoted", () => {
    expect(renderHandoffScript(["/bin/bash", "-c", "echo 'hi'"], { A: "x y", B: "it's" })).toBe(
      `exec /usr/bin/env -i -- 'A=x y' 'B=it'\\''s' '/bin/bash' '-c' 'echo '\\''hi'\\'''\n`,
    );
  });

  it("refuses a program that is not an absolute path", () => {
    expect(() => renderHandoffScript([], {})).toThrow(/absolute program path/);
    expect(() => renderHandoffScript(["bash"], {})).toThrow(/absolute program path/);
    expect(() => renderHandoffScript(["/bin/X=1"], {})).toThrow(/absolute program path/);
  });

  it("refuses an environment entry env(1) would misread", () => {
    expect(() => renderHandoffScript(["/bin/sh"], { "A=B": "1" })).toThrow(/cannot be passed/);
    expect(() => renderHandoffScript(["/bin/sh"], { A: "1\0" })).toThrow(/cannot be passed/);
    // env(1) would read these as options, or they are not portable names.
    for (const key of ["-S", "-i", "--", "1A", "A-B", "A B", ""]) {
      expect(() => renderHandoffScript(["/bin/sh"], { [key]: "x" }), key).toThrow(/cannot be passed/);
    }
  });
});

describe("the fifo handoff (real fifo)", () => {
  it.runIf(process.platform !== "win32")("stops waiting as soon as the trampoline is gone", async () => {
    const handoff = await createTerminalTtyHandoff();
    try {
      const gone = new AbortController();
      const started = Date.now();
      const delivering = handoff.deliver("exec true\n", { timeoutMs: 10_000, signal: gone.signal });
      setTimeout(() => gone.abort(), 50);
      await expect(delivering).rejects.toThrow(/exited before taking its command/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      handoff.dispose();
    }
  });

  it.runIf(process.platform !== "win32")("refuses at once, without opening the fifo, when the trampoline is already gone", async () => {
    const handoff = await createTerminalTtyHandoff();
    try {
      const gone = new AbortController();
      gone.abort();
      await expect(handoff.deliver("exec true\n", { signal: gone.signal })).rejects.toThrow();
    } finally {
      handoff.dispose();
    }
  });

  it.runIf(process.platform !== "win32")("leaves nothing in the fifo once it has given up", async () => {
    const handoff = await createTerminalTtyHandoff();
    try {
      await expect(handoff.deliver("exec true\n", { timeoutMs: 50 })).rejects.toThrow(/did not take its command/);
      // The give-up opened and closed the read end once; a late write would
      // now block or land. Read with a fresh reader and a short-lived writer.
      const fifo = handoff.trampoline.args[0]!;
      const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const buffer = Buffer.alloc(64);
        let bytes = 0;
        try {
          bytes = readSync(readFd, buffer, 0, buffer.length, null);
        } catch (err) {
          // EAGAIN: no writer has anything to give
          if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
        }
        expect(bytes).toBe(0);
      } finally {
        closeSync(readFd);
      }
    } finally {
      handoff.dispose();
    }
  });
});

describe("terminalNeedsOwnTtyGrant", () => {
  it("is macOS only", () => {
    expect(terminalNeedsOwnTtyGrant("darwin")).toBe(true);
    expect(terminalNeedsOwnTtyGrant("linux")).toBe(false);
    expect(terminalNeedsOwnTtyGrant("win32")).toBe(false);
  });
});

// ─── real sandbox, real pty ────────────────────────────────────────────────

let home: string;
let previousAveHome: string | undefined;
let canRun = false;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ave-own-tty-"));
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(home, ".ave");
  if (process.platform !== "darwin") return;
  if (!(await asrtCanInitialize())) {
    if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
    return;
  }
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  canRun = true;
});

afterAll(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[=>]/g, "");
const lines = (text: string, line: string) =>
  text.split(/\r?\n/).filter((l) => l.replace(/\r/g, "").trim() === line).length;

interface Shell {
  output: () => string;
  type: (input: string, settleMs?: number) => Promise<void>;
  ownTty: string;
  close: () => void;
}

/** A sandboxed `zsh -f -i` on a pty, spawned the way pty-manager does on macOS. */
async function startShell(grantOwnTty: boolean): Promise<Shell> {
  const { spawn } = await import("node-pty");
  const workDir = mkdtempSync(join(home, "work-"));
  const handoff = await createTerminalTtyHandoff();
  const pty: IPty = spawn(handoff.trampoline.file, [...handoff.trampoline.args], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: workDir,
    env: { ...TRAMPOLINE_ENV },
  });
  let out = "";
  pty.onData((chunk) => {
    out += chunk;
  });
  const ownTty = ownPtySlavePath(pty);
  const filesystem = { allowWrite: [workDir], denyRead: [], denyWrite: getDefaultSensitiveWriteDenyPaths() };
  const { argv, env } = grantOwnTty
    ? await wrapTerminalCommand("exec /bin/zsh -f -i", { filesystem, ownTty, commandId: TEST_COMMAND_ID })
    : await wrapWorkerCommand("exec /bin/zsh -f -i", { filesystem, commandId: TEST_COMMAND_ID });
  const childEnv: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: workDir, TERM: "xterm-256color", PS1: "%# " };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (/PROXY$/i.test(key) || key === "SANDBOX_RUNTIME" || key === "TMPDIR")) childEnv[key] = value;
  }
  await handoff.deliver(renderHandoffScript(argv, childEnv));
  handoff.dispose();
  await sleep(1000);
  return {
    output: () => stripAnsi(out),
    type: async (input, settleMs = 500) => {
      pty.write(input);
      await sleep(settleMs);
    },
    ownTty,
    close: () => {
      try {
        pty.kill("SIGKILL");
      } catch {
        // already exited
      }
    },
  };
}

describe("a sandboxed shell on its own pty (macOS)", () => {
  it.runIf(process.platform === "darwin")(
    "prints a typed command once, runs stty, and suspends and resumes a job",
    async () => {
      if (!canRun) return;
      const shell = await startShell(true);
      try {
        await shell.type("echo marker\r");
        await shell.type("stty -a >/dev/null && echo STTY_OK\r");
        await shell.type("sleep 30\r");
        await shell.type("\x1a", 800);
        await shell.type("fg\r", 800);
        await shell.type("\x03");
        await shell.type("echo AFTER_FG\r");
        const out = shell.output();
        expect(out.match(/echo marker/g)?.length, out).toBe(1);
        expect(lines(out, "marker"), out).toBe(1);
        expect(lines(out, "STTY_OK"), out).toBe(1);
        expect(out).not.toMatch(/can't set tty pgrp|Operation not permitted/);
        expect(out).toMatch(/suspended/);
        expect(lines(out, "AFTER_FG"), out).toBe(1);
      } finally {
        shell.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "darwin")(
    "still cannot set another terminal",
    async () => {
      if (!canRun) return;
      const { spawn } = await import("node-pty");
      const other = spawn("/bin/sleep", ["30"], { name: "xterm-256color", cols: 80, rows: 24, env: { ...TRAMPOLINE_ENV } });
      const shell = await startShell(true);
      try {
        const otherTty = ownPtySlavePath(other);
        expect(otherTty).not.toBe(shell.ownTty);
        await shell.type(`stty -echo <${otherTty} 2>/dev/null && echo OTHER_SET || echo OTHER_DENIED\r`, 800);
        const out = shell.output();
        expect(lines(out, "OTHER_DENIED"), out).toBe(1);
        expect(lines(out, "OTHER_SET"), out).toBe(0);
      } finally {
        shell.close();
        other.kill("SIGKILL");
      }
    },
    30_000,
  );

  it.runIf(process.platform === "darwin")(
    "without the grant, shows each command twice and has no job control (control)",
    async () => {
      if (!canRun) return;
      const shell = await startShell(false);
      try {
        await shell.type("echo marker\r");
        const out = shell.output();
        expect(out.match(/echo marker/g)?.length, out).toBe(2);
        expect(out).toMatch(/can't set tty pgrp/);
      } finally {
        shell.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "darwin")("refuses a malformed tty at the wrap", async () => {
    if (!canRun) return;
    await expect(
      wrapTerminalCommand("true", { commandId: TEST_COMMAND_ID, filesystem: { allowWrite: [home], denyRead: [], denyWrite: getDefaultSensitiveWriteDenyPaths() }, ownTty: "/dev/ttys*" }),
    ).rejects.toThrow(/not a pty slave/);
  });
});
