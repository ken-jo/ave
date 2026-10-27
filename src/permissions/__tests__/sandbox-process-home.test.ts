import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appOwnedSandboxHomeRoot, ensureSandboxTempPrincipalDir } from "../asrt-sandbox.js";
import { sweepSandboxPrivateRoots } from "../../boot/steps/sandbox-init.js";
import {
  createSandboxProcessHome,
  sandboxProcessHomesInUse,
  sandboxProcessProfileEnvironment,
} from "../sandbox-process-home.js";
import {
  runWithAgentObservationInvocation,
  runWithAgentObservationTurn,
  setAgentObservationSink,
  type AgentObservationSink,
} from "../../tools/agent-observation-context.js";

// The HOMEs are created under `<AVE_HOME>/sandbox/home` on macOS and Linux, so the real AVE_HOME is never the one these cases fill.
let aveHomeDir: string;
// Every directory a case creates belongs under the temp roots. A Windows profile built on a POSIX host names `\private\var\…\AppData\Local`, which `mkdirSync` there takes for ONE relative name and creates in the working directory — the checkout — so the working directory is held to its listing.
let cwdBefore: string[];
beforeEach(() => {
  cwdBefore = readdirSync(process.cwd()).sort();
  aveHomeDir = mkdtempSync(join(tmpdir(), "ave-process-home-"));
  vi.stubEnv("AVE_HOME", join(aveHomeDir, ".ave"));
});

afterEach(() => {
  setAgentObservationSink(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(aveHomeDir, { recursive: true, force: true });
  expect(readdirSync(process.cwd()).sort(), "a case created entries in the working directory").toEqual(cwdBefore);
});

describe("createSandboxProcessHome", () => {
  it("creates a unique private profile and removes it idempotently", () => {
    const first = createSandboxProcessHome();
    const second = createSandboxProcessHome();
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.env.HOME).toBe(first.path);
      expect(first.env.AVE_DOCUMENT_JOURNAL).toBe(join(first.path, "document-observation", "journal.jsonl"));
      expect(statSync(dirname(first.env.AVE_DOCUMENT_JOURNAL!)).isDirectory()).toBe(true);
      expect(existsSync(first.env.AVE_DOCUMENT_JOURNAL!)).toBe(false);
      expect(statSync(first.path).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(first.path).mode & 0o777).toBe(0o700);
      }

      if (process.platform === "win32") {
        expect(first.env.USERPROFILE).toBe(first.path);
        expect(first.env.APPDATA).toContain(first.path);
        expect(first.env.LOCALAPPDATA).toContain(first.path);
        expect(first.env.HOMEDRIVE).toBeDefined();
        expect(first.env.HOMEPATH).toBeDefined();
      } else {
        expect(first.env.XDG_CONFIG_HOME).toContain(first.path);
        expect(first.env.XDG_DATA_HOME).toContain(first.path);
        expect(first.env.XDG_CACHE_HOME).toContain(first.path);
        expect(first.env.XDG_STATE_HOME).toContain(first.path);
      }

      writeFileSync(`${first.path}/.gitconfig`, "[test]\nvalue = isolated\n", "utf8");
    } finally {
      first.cleanup();
      first.cleanup();
      second.cleanup();
    }

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it("keeps HOME preparation unobserved until an agent invocation is admitted", async () => {
    const poll = vi.fn();
    const finish = vi.fn(async () => {});
    const sink: AgentObservationSink = {
      openJournal: vi.fn(() => ({ poll, finish, dispose: () => {} })),
      beforeMutation: async () => async () => {},
      finishInvocation: async () => {},
      revokeInvocation: () => {},
      finishTurn: () => {},
    };
    setAgentObservationSink(sink);
    const home = createSandboxProcessHome();
    try {
      expect(sink.openJournal).not.toHaveBeenCalled();
      await runWithAgentObservationTurn({ sessionId: "home-session", turnId: "home-turn" }, () =>
        runWithAgentObservationInvocation({ sessionId: "home-session", toolUseId: "home-tool" }, async () => {
          expect(sink.openJournal).toHaveBeenCalledExactlyOnceWith({
            sessionId: "home-session", turnId: "home-turn", toolUseId: "home-tool",
          }, home.path);
          home.cleanup();
          expect(finish).toHaveBeenCalledTimes(1);
          expect(poll).not.toHaveBeenCalled();
          expect(existsSync(home.path)).toBe(false);
        }, home.path),
      );
    } finally { home.cleanup(); }
  });

  it("drains an admitted HOME journal before removing the directory", async () => {
    const order: string[] = [];
    const sink: AgentObservationSink = {
      openJournal: vi.fn((_identity: unknown, homePath: string) => ({
        poll: () => { order.push("poll"); },
        finish: async () => {
          expect(readFileSync(join(homePath, "document-observation", "journal.jsonl"), "utf8"))
            .toBe("bounded journal contents\n");
          order.push("finish");
        },
        dispose: () => {},
      })),
      beforeMutation: async () => async () => {},
      finishInvocation: async () => {},
      revokeInvocation: () => {},
      finishTurn: () => {},
    };
    setAgentObservationSink(sink);
    await runWithAgentObservationTurn({ sessionId: "home-session", turnId: "home-turn" }, () =>
      runWithAgentObservationInvocation({ sessionId: "home-session", toolUseId: "home-tool" }, async () => {
        const home = createSandboxProcessHome(process.platform, (path, options) => {
          order.push("remove");
          rmSync(path, options);
        });
        expect(sink.openJournal).toHaveBeenCalledExactlyOnceWith({
          sessionId: "home-session", turnId: "home-turn", toolUseId: "home-tool",
        }, home.path);
        writeFileSync(home.env.AVE_DOCUMENT_JOURNAL!, "bounded journal contents\n");
        home.cleanup();
        home.cleanup();
        expect(order).toEqual(["finish", "remove"]);
      }),
    );
  });

  it("removes a newly created HOME when observation admission fails", async () => {
    const originalHomes = [...sandboxProcessHomesInUse()];
    const createdHomes: string[] = [];
    const failure = new Error("Observation journal limit exceeded.");
    const sink: AgentObservationSink = {
      openJournal: vi.fn((_identity, path) => { createdHomes.push(path); throw failure; }),
      beforeMutation: async () => async () => {},
      finishInvocation: async () => {},
      revokeInvocation: () => {},
      finishTurn: () => {},
    };
    setAgentObservationSink(sink);
    await runWithAgentObservationTurn({ sessionId: "home-session", turnId: "home-turn" }, () =>
      runWithAgentObservationInvocation({ sessionId: "home-session", toolUseId: "home-tool" }, async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(() => createSandboxProcessHome()).toThrow(failure);
        }
      }),
    );
    expect(createdHomes).toHaveLength(2);
    for (const path of createdHomes) expect(existsSync(path)).toBe(false);
    expect([...sandboxProcessHomesInUse()]).toEqual(originalHomes);
  });

  it.skipIf(process.platform === "win32")(
    "creates each HOME under the app-owned root the read floor denies, and tracks it until removed",
    () => {
      const home = createSandboxProcessHome();
      try {
        expect(dirname(home.path)).toBe(realpathSync(appOwnedSandboxHomeRoot()));
        expect(statSync(appOwnedSandboxHomeRoot()).mode & 0o777).toBe(0o700);
        expect(sandboxProcessHomesInUse().has(home.path)).toBe(true);
      } finally {
        home.cleanup();
      }
      expect(sandboxProcessHomesInUse().has(home.path)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "the boot sweep removes a HOME left by an earlier run and keeps one this process made",
    async () => {
      const live = createSandboxProcessHome();
      const { dir: liveTemp } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "home-sweep" });
      try {
        writeFileSync(join(live.path, "kept"), "kept");
        const stale = join(appOwnedSandboxHomeRoot(), "ave-sandbox-home-stale");
        mkdirSync(join(stale, "config"), { recursive: true, mode: 0o700 });
        await sweepSandboxPrivateRoots();
        expect(existsSync(stale)).toBe(false);
        expect(readdirSync(live.path)).toContain("kept");
        expect(existsSync(liveTemp)).toBe(true);
      } finally {
        live.cleanup();
      }
    },
  );

  // Windows only: the profile's paths are Windows paths (`win32.join`), which only a Windows host creates where they name.
  it.runIf(process.platform === "win32")("keeps the Windows HOME under the host temp directory, as before", () => {
    const home = createSandboxProcessHome("win32");
    try {
      expect(dirname(home.path)).toBe(realpathSync.native(tmpdir()));
      expect(existsSync(appOwnedSandboxHomeRoot())).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a HOME root that is a link, and creates nothing behind it", () => {
    const outside = mkdtempSync(join(aveHomeDir, "outside-"));
    mkdirSync(dirname(appOwnedSandboxHomeRoot()), { recursive: true });
    symlinkSync(outside, appOwnedSandboxHomeRoot());
    expect(() => createSandboxProcessHome()).toThrow(/not a directory the host created/);
    expect(lstatSync(appOwnedSandboxHomeRoot()).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("overrides the Windows HOME drive pair for a non-drive temp path", () => {
    const path = "\\\\server\\temp\\ave-sandbox-home-test";
    const env = sandboxProcessProfileEnvironment(path, "win32");
    expect(env.HOMEDRIVE).toBe("");
    expect(env.HOMEPATH).toBe(path);
  });

  it("keeps cleanup retryable until the profile is actually absent", () => {
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      rmSync(path, options);
    });
    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    profile.cleanup();
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });

  it("automatically retries a transient cleanup failure", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      rmSync(path, options);
    });

    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });
});
