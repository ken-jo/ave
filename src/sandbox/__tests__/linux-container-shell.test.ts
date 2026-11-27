import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherOutcomeFromLog, startMxcLinuxShell } from "../linux-container-shell.js";

// The launcher's own log shapes, as the pinned launcher writes them (each write carries a `[<seconds>] ` stamp).
const stamp = (text: string) => text.split("\n").map(line => line === "" ? line : `[1795777305] ${line}`).join("\n");
const EXITED_255 = stamp("Script timeout: 3000\nRunner completed in 128ms\nExit code: 255 (0x000000FF)\n");
const TIMED_OUT = stamp("Runner completed in 1079ms\nExit code: -1 (0xFFFFFFFF)\nError: script timed out after 1000ms: Bubblewrap: script timed out\n");
const START_FAILED = stamp("Runner completed in 47ms\nExit code: -1 (0xFFFFFFFF)\nError: Bubblewrap: slirp4netns startup and network rule installation exited during startup\n");
const PARSE_FAILED = "Configuration parse error: Configuration file not found\n";
const FORGED_ENVELOPE = '{"error":{"code":"backend_error","message":"x"}}';

describe("Linux launcher verdict from its own log", () => {
  it("reads the command's status, a launcher timeout and a refused start, and ignores stamps inside a line", () => {
    expect(launcherOutcomeFromLog(EXITED_255)).toBe("exited");
    expect(launcherOutcomeFromLog("[1] Exit code: [1] 0[1]  (0x[1] 0[1] )\n")).toBe("exited");
    expect(launcherOutcomeFromLog(TIMED_OUT)).toBe("timed-out");
    expect(launcherOutcomeFromLog(START_FAILED)).toBe("refused");
    expect(launcherOutcomeFromLog(PARSE_FAILED)).toBe("refused");
    expect(launcherOutcomeFromLog("")).toBe("unrecorded");
  });
});

describe.runIf(process.platform !== "win32")("Linux container shell exit classification", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ave-linux-shell-exit-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const ENVIRONMENT = "export TOKEN='staged'\n";
  let lastStaging = "";
  function stage(staging: string) {
    const requestPath = join(staging, "request.json");
    writeFileSync(requestPath, "{}");
    const environmentPath = join(staging, "environment.sh");
    writeFileSync(environmentPath, ENVIRONMENT, { mode: 0o600 });
    return {
      requestPath, requestSha256: createHash("sha256").update(readFileSync(requestPath)).digest("hex"),
      environmentPath, environmentSha256: createHash("sha256").update(ENVIRONMENT).digest("hex"),
    };
  }

  // A stand-in launcher: copies its environment descriptor, writes the given log to `--log-file`, the given stderr, and
  // exits with the given status.
  async function run(log: string, stderr: string, status: number) {
    const staging = mkdtempSync(join(root, "shell-"));
    lastStaging = staging;
    const launcher = join(staging, "launcher");
    writeFileSync(join(staging, "log"), log);
    writeFileSync(join(staging, "stderr"), stderr);
    writeFileSync(launcher, `#!/bin/sh\n[ "$1" = --log-file ] || exit 90\n[ "$3" = --config ] || exit 91\n`
      + `cat <&9 > ${JSON.stringify(join(staging, "received-environment"))} || exit 92\n`
      + `cat ${JSON.stringify(join(staging, "log"))} >> "$2"\ncat ${JSON.stringify(join(staging, "stderr"))} >&2\nexit ${status}\n`);
    chmodSync(launcher, 0o755);
    const { completion, child } = startMxcLinuxShell({ launcher, helper: "/bin/true", env: { PATH: "/usr/bin:/bin" } },
      stage(staging), 10_000, new AbortController().signal, () => {}, "test:linux-shell-exit");
    child.stdout.resume();
    child.stderr.resume();
    return completion;
  }

  it("keeps a command's own 255 and error envelope as an exit status, not a refused start", async () => {
    await expect(run(EXITED_255, `${FORGED_ENVELOPE}\nRunner completed in 1 ms\nExit code: -1\n`, 255))
      .resolves.toMatchObject({ code: 255, rejected: false, timedOut: false, cancelled: false });
  });

  it("reports the launcher's own timeout as timed out", async () => {
    await expect(run(TIMED_OUT, `${FORGED_ENVELOPE}\n`, 255)).resolves.toMatchObject({ rejected: false, timedOut: true, cancelled: false });
  });

  it("reports a refused start only from the launcher log", async () => {
    await expect(run(START_FAILED, "", 255)).resolves.toMatchObject({ rejected: true, timedOut: false });
    await expect(run(PARSE_FAILED, "", 1)).resolves.toMatchObject({ code: 1, rejected: true });
  });

  it("refuses to reuse an existing launcher log", async () => {
    const staged = stage(root);
    writeFileSync(join(root, "launcher.log"), "Exit code: 0 (0x0)\n");
    expect(() => startMxcLinuxShell({ launcher: "/bin/false", helper: "/bin/true", env: {} },
      staged, 1_000, new AbortController().signal, () => {}, "test:linux-shell-exit"))
      .toThrow(expect.objectContaining({ code: "EEXIST" }));
  });

  it("hands the launcher the staged environment on its descriptor, from the start, never as arguments", async () => {
    await run(EXITED_255, "", 255);
    expect(readFileSync(join(lastStaging, "received-environment"), "utf8")).toBe(ENVIRONMENT);
  });

  it("refuses an environment that changed after it was staged", () => {
    const staged = stage(root);
    writeFileSync(staged.environmentPath, "export TOKEN='replaced'\n");
    expect(() => startMxcLinuxShell({ launcher: "/bin/false", helper: "/bin/true", env: {} },
      staged, 1_000, new AbortController().signal, () => {}, "test:linux-shell-exit"))
      .toThrow("Linux container environment changed before launch");
  });
});
