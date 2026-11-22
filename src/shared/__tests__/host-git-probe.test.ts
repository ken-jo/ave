import { execFileSync, spawn } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { gitProbeChild } from "../../__tests__/support/git-probe-child.js";
import { runGitProbeAsync, runGitProbeSync } from "../host-git-probe.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

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
