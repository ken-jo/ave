import { describe, expect, it } from "vitest";
import { runGitProbeAsync, runGitProbeSync } from "../host-git-probe.js";

describe.each([
  ["async", runGitProbeAsync],
  ["sync", runGitProbeSync],
] as const)("%s Git capability probe", (_name, probe) => {
  it("accepts bounded stdout while ignoring a long stderr diagnostic", async () => {
    const result = await probe(process.execPath, ["-e", "process.stderr.write('x'.repeat(16384)); process.stdout.write('git version 2.56.0')"], {});
    expect(result).toEqual({ stdout: "git version 2.56.0", exitCode: 0 });
  });

  it("preserves the exit status and rejects output beyond the stdout limit", async () => {
    const exited = await probe(process.execPath, ["-e", "process.exitCode = 129"], {});
    expect(exited.exitCode).toBe(129);
    const oversized = await probe(process.execPath, ["-e", "process.stdout.write('x'.repeat(16384))"], {});
    expect(oversized.exitCode).not.toBe(0);
  });
});
