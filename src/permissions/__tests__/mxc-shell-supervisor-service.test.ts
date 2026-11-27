import { afterEach, describe, expect, it } from "vitest";
import { createPosixSupervisorHarness, stageSeatbeltWire } from "../../__tests__/support/mxc-posix-supervisor-harness.js";
import { SEATBELT_CLEANUP_WARNINGS, seatbeltCleanupUnverified } from "../mxc-native-process.js";
import { _lostShellOutcomeForTest, _shellOutcomeForTest } from "../mxc-shell-supervisor-client.js";
import { serveMxcShellSupervisor } from "../mxc-shell-supervisor-service.js";

let harness: ReturnType<typeof createPosixSupervisorHarness> | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; });

async function runToReady(warnings: readonly string[]) {
  harness = createPosixSupervisorHarness();
  const h = harness;
  const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
  await h.host.send({ type: "shell-start", ...stageSeatbeltWire(h.directory) });
  await h.waitFor("shell-ready");
  const native = h.natives[0];
  if (native === undefined) throw new Error("the fake SDK spawned nothing");
  native.native.warnings.push(...warnings);
  native.stdout.end();
  native.stderr.end();
  native.resolve({ exitCode: 0, timedOut: false });
  await served;
  return h.frames.at(-1);
}

describe("macOS shell supervisor cleanup receipts", () => {
  it.each(SEATBELT_CLEANUP_WARNINGS.map((warning) => [warning]))("reports a zero exit with %s as cleanup unverified", async (warning) => {
    expect(await runToReady([warning])).toMatchObject({ type: "error", code: "cleanup-unverified" });
  });

  it("reports any other post-run Seatbelt warning as cleanup unverified", async () => {
    expect(await runToReady(["Seatbelt: a cleanup phrase this build does not name"])).toMatchObject({ code: "cleanup-unverified" });
  });

  it("reports a clean zero exit as an exit", async () => {
    expect(await runToReady([])).toEqual({ type: "exit", exitCode: 0, timedOut: false });
  });

  it("treats only Seatbelt warnings as unverified cleanup", () => {
    expect(seatbeltCleanupUnverified([])).toBe(false);
    expect(seatbeltCleanupUnverified(["profile note"])).toBe(false);
    expect(seatbeltCleanupUnverified(["note", "Seatbelt: anything"])).toBe(true);
  });
});

describe("macOS shell outcome wording", () => {
  it("reports a supervisor lost before the run began as a failed start, still unverified", () => {
    expect(_lostShellOutcomeForTest(false)).toMatchObject({ startFailed: true, cleanupUnverified: true, rejected: false });
    expect(_lostShellOutcomeForTest(true)).toMatchObject({ cleanupUnverified: true });
    expect(_lostShellOutcomeForTest(true)).not.toHaveProperty("startFailed");
  });

  it("reports a channel failure after the run began as a confirmed stop, not a container refusal", () => {
    const contract = { type: "error", code: "contract", message: "Invalid native shell supervisor transport" } as const;
    expect(_shellOutcomeForTest(contract, true)).toMatchObject({ transportFailed: true, cleanupUnverified: false, rejected: false });
    expect(_shellOutcomeForTest(contract, false)).toMatchObject({ rejected: true, cleanupUnverified: false });
    expect(_shellOutcomeForTest(contract, false)).not.toHaveProperty("transportFailed");
    expect(_shellOutcomeForTest({ type: "error", code: "integrity", message: "x" }, true)).toMatchObject({ cleanupUnverified: true });
  });
});
