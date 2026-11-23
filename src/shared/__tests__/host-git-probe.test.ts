import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { gitProbeChild } from "../../__tests__/support/git-probe-child.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { runGitProbeAsync, runGitProbeSync } from "../host-git-probe.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const { TEST_DEADLINE_MS } = vi.hoisted(() => ({ TEST_DEADLINE_MS: 1_500 }));
vi.mock("../tool-timeout-policy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../tool-timeout-policy.js")>();
  return { ...original, TOOL_TIMEOUT_POLICY: { ...original.TOOL_TIMEOUT_POLICY, projectGitQueryMs: TEST_DEADLINE_MS } };
});

beforeEach(() => vi.resetAllMocks());

it("discards stderr independently of the synchronous stdout limit", () => {
  vi.mocked(execFileSync).mockReturnValue("git version 2.56.0");
  expect(runGitProbeSync("git", ["--version"], {})).toEqual({ stdout: "git version 2.56.0", exitCode: 0 });
  expect(execFileSync).toHaveBeenCalledWith("git", ["--version"], expect.objectContaining({
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4096,
  }));
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("unknown option"), { status: 129 }); });
  expect(runGitProbeSync("git", ["--version"], {})).toEqual({ stdout: "", exitCode: 129 });
});

it("discards stderr while asynchronously reading stdout and preserving the exit status", async () => {
  vi.mocked(spawn).mockImplementationOnce(() => gitProbeChild((complete) => complete("git version 2.56.0")))
    .mockImplementationOnce(() => gitProbeChild((complete) => complete("", 129)));
  await expect(runGitProbeAsync("git", ["--version"], {})).resolves.toEqual({ stdout: "git version 2.56.0", exitCode: 0 });
  expect(spawn).toHaveBeenCalledWith("git", ["--version"], expect.objectContaining({
    stdio: ["ignore", "pipe", "ignore"],
  }));
  await expect(runGitProbeAsync("git", ["--version"], {})).resolves.toEqual({ stdout: "", exitCode: 129 });
});

it("rejects an asynchronous probe with oversized stdout", async () => {
  vi.mocked(spawn).mockImplementation(() => gitProbeChild((complete) => complete("x".repeat(4097))));
  await expect(runGitProbeAsync("git", ["--version"], {})).resolves.toEqual({ stdout: "" });
});

const HELD_HELPER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [mode, pidFile] = process.argv.slice(2);
const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"], windowsHide: true });
writeFileSync(pidFile, String(helper.pid));
if (mode === "overflow") process.stdout.write("x".repeat(5000));
if (mode !== "exit") setInterval(() => {}, 60000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Only the Windows tree kill reaches a helper, and only while its wrapper still runs: an orphan has no ancestry left to walk.
const treeKill = process.platform === "win32";
it.each([
  { mode: "running", reaped: treeKill },
  { mode: "overflow", reaped: treeKill },
  { mode: "exit", reaped: false },
])("settles as unavailable when a helper holds stdout open ($mode)", async ({ mode, reaped }) => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation(actual.spawn);
  const fixture = mkdtempSync(join(tmpdir(), "ave-held-probe-"));
  const pidFile = join(fixture, "helper.pid");
  let helperPid = 0;
  try {
    const wrapper = join(fixture, "wrapper.cjs");
    writeFileSync(wrapper, HELD_HELPER);
    const startedAt = Date.now();
    await expect(runGitProbeAsync(process.execPath, [wrapper, mode, pidFile], {})).resolves.toEqual({ stdout: "" });
    expect(Date.now() - startedAt).toBeLessThan(TEST_DEADLINE_MS + 1_000);
    helperPid = await vi.waitFor(() => {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (!(pid > 0)) throw new Error("helper pid not written yet");
      return pid;
    }, { timeout: 5_000, interval: 50 });
    if (reaped) await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 5_000, interval: 50 });
  } finally {
    if (helperPid > 0 && alive(helperPid)) process.kill(helperPid, "SIGKILL");
    await cleanupTmpDir(fixture);
  }
}, TEST_DEADLINE_MS + 8_000);
