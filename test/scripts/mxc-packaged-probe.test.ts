import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error standalone probe utilities do not emit declarations
import { cancellationObservation, exactOwnedPath, finalizePackagedObservation, handleSnapshot, inspectOwnerHandleCandidates, ownerHandleObservationPassed, packagedProbeOptions, plantedDllRejected, retainedTreeSize, stdioObservation, terminatePinnedProcess } from "../../tools/mxc-probes/packaged-protocol.mjs";

const executable = path.resolve(tmpdir(), "packaged-probe", "Ave.exe");

describe("separate exact-object cleanup authority (unit only)", () => {
  function native() {
    return { wait: vi.fn(() => 258), pid: vi.fn(() => 42), open: vi.fn((): bigint | null => 456n),
      sameProcess: vi.fn(() => true), terminate: vi.fn(() => true), close: vi.fn() };
  }
  it("obtains cleanup rights and compares objects before terminating, then closes them", () => {
    const api = native();
    terminatePinnedProcess(api, 123n, 74);
    expect(api.open).toHaveBeenCalledWith(0x101001, false, 42);
    expect(api.sameProcess).toHaveBeenCalledWith(123n, 456n);
    expect(api.terminate).toHaveBeenCalledWith(456n, 74);
    expect(api.close).toHaveBeenCalledWith(456n);
    expect(api.sameProcess.mock.invocationCallOrder[0]).toBeLessThan(api.terminate.mock.invocationCallOrder[0]);
  });
  it("refuses PID reuse and closes a mismatched candidate without mutation", () => {
    const api = native(); api.sameProcess.mockReturnValue(false);
    expect(() => terminatePinnedProcess(api, 123n, 74)).toThrow("Cleanup process object mismatch");
    expect(api.terminate).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledWith(456n);
  });
  it("reports termination failure and never requests authority for an already signaled pin", () => {
    const api = native(); api.terminate.mockReturnValue(false);
    expect(() => terminatePinnedProcess(api, 123n, 74)).toThrow("cleanup termination failed");
    expect(api.close).toHaveBeenCalledOnce();
    api.wait.mockReturnValue(0); api.open.mockClear();
    terminatePinnedProcess(api, 123n, 74);
    expect(api.open).not.toHaveBeenCalled();
  });
  it("reports denied cleanup authority unless the original object has now signaled", () => {
    const api = native(); api.open.mockReturnValue(null);
    expect(() => terminatePinnedProcess(api, 123n, 74)).toThrow("Cannot open pinned process for cleanup");
    api.wait.mockReturnValueOnce(258).mockReturnValueOnce(0);
    terminatePinnedProcess(api, 123n, 74);
    expect(api.terminate).not.toHaveBeenCalled();
  });
});

describe("pending native cancellation evidence", () => {
  const frame = { pending: true, name: "MxcProcessContractError" };
  const accounting = { exit: { code: 0, signal: null }, processDeathVerified: true,
    processObservations: [{ role: "main", signaled: true }, { role: "supervisor", signaled: true }, { role: "container", signaled: true }] };
  it("can pass from a retained signaled container object without live fixture journals", () => {
    expect(cancellationObservation(frame, accounting).passed).toBe(true);
    expect(cancellationObservation(frame, accounting).containerObservationComplete).toBe(true);
  });
  it("fails when the retained container survives even with a native cleanup receipt", () => {
    expect(cancellationObservation(frame, { ...accounting, processObservations: [...accounting.processObservations.slice(0, 2), { role: "container", signaled: false }] }).passed).toBe(false);
    expect(cancellationObservation(frame, { ...accounting, processDeathVerified: false }).passed).toBe(false);
  });
  it("refuses missing objects, timing misses and an unclean observer exit", () => {
    expect(cancellationObservation(frame, { ...accounting, processObservations: [] }).passed).toBe(false);
    expect(cancellationObservation({ ...frame, pending: false }, accounting).passed).toBe(false);
    expect(cancellationObservation(frame, { ...accounting, exit: { code: 0, signal: "SIGTERM" } }).passed).toBe(false);
  });
});

describe("packaged probe arguments", () => {
  it("accepts one absolute executable path without additional switches", () => {
    expect(packagedProbeOptions(["--app", executable])).toEqual({ executable });
  });

  it.each([
    [], ["--app"], ["--runtime", executable], ["--app", "relative.exe"],
    ["--app", path.resolve(tmpdir(), "package.zip")], ["--app", executable, "--extra"],
  ].map((argv) => ({ argv })))("rejects incomplete or ambiguous input $argv", ({ argv }) => {
    expect(() => packagedProbeOptions(argv)).toThrow("Expected --app");
  });
});

describe("native handle snapshot decoding", () => {
  it("decodes pointer-sized handles and independent inheritance attributes", () => {
    const bytes = Buffer.alloc(16 + 2 * 40);
    bytes.writeBigUInt64LE(2n, 0);
    bytes.writeBigUInt64LE(0x123456789abcdef0n, 16);
    bytes.writeUInt32LE(7, 16 + 28);
    bytes.writeUInt32LE(2, 16 + 32);
    bytes.writeBigUInt64LE(0xfedcba9876543210n, 56);
    bytes.writeUInt32LE(13, 56 + 28);
    bytes.writeUInt32LE(0, 56 + 32);
    expect(handleSnapshot(bytes)).toEqual([
      { value: 0x123456789abcdef0n, objectTypeIndex: 7, attributes: 2 },
      { value: 0xfedcba9876543210n, objectTypeIndex: 13, attributes: 0 },
    ]);
  });

  it("decodes an empty snapshot as empty evidence, without accepting non-inheritance", () => {
    const empty = handleSnapshot(Buffer.alloc(16));
    expect(empty).toEqual([]);
    expect(() => inspectOwnerHandleCandidates({ objectTypeIndex: 7 }, empty, {})).toThrow(/No owner-type descendant handles/);
    expect(ownerHandleObservationPassed({ supervisorInheritable: false, descendants: [{ inherited: false, inspected: 0 }] })).toBe(false);
  });

  it("rejects short, truncated and unrepresentable snapshots", () => {
    const truncated = Buffer.alloc(55); truncated.writeBigUInt64LE(1n);
    const oversized = Buffer.alloc(16); oversized.writeBigUInt64LE(0xffffffffffffffffn);
    const unsafe = Buffer.alloc(16); unsafe.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER));
    for (const bytes of [null, {}, Buffer.alloc(15), truncated, oversized, unsafe]) {
      expect(() => handleSnapshot(bytes)).toThrow("Invalid process handle snapshot");
    }
  });
});

function completeStdioFrame() {
  return {
    received: 4 * 1024 * 1024, expected: 4 * 1024 * 1024,
    sha256: "a".repeat(64), expectedSha256: "a".repeat(64),
    stderr: "fixture-input-eof\n",
    result: { exitCode: 0, timedOut: false },
  };
}

describe("stdio observation classification", () => {
  it("requires a complete byte count, digest and EOF observation", () => {
    const frame = completeStdioFrame();
    expect(stdioObservation(frame)).toEqual({ ...frame, passed: true });
  });

  it.each([
    { received: 1 }, { expected: 1 }, { sha256: "b".repeat(64) },
    { sha256: "invalid", expectedSha256: "invalid" },
    { stderr: "" }, { stderr: "fixture-input-eof\nextra output" },
    { result: { exitCode: 1, timedOut: false } }, { result: { exitCode: 0, timedOut: true } },
    { result: undefined },
  ])("does not accept partial native evidence %j", (partial) => {
    expect(stdioObservation({ ...completeStdioFrame(), ...partial }).passed).toBe(false);
  });
});

describe("owned cleanup path containment", () => {
  const root = path.resolve(tmpdir(), "owned-probe");
  it("retains an exact child path", () => {
    const child = path.join(root, "run", "fixture.mjs");
    expect(exactOwnedPath(root, child)).toBe(child);
  });

  it("rejects the owner root, siblings and parent traversal", () => {
    for (const candidate of [root, path.dirname(root), root + "-sibling", path.join(root, "..", "other", "fixture.mjs")]) {
      expect(() => exactOwnedPath(root, candidate)).toThrow("Path is outside");
    }
  });
});

describe("packaged probe entry", () => {
  it("bundles an explicitly selected entry that invokes the public owned-process primitive", async () => {
    const source = readFileSync("tools/mxc-probes/packaged-main.ts", "utf8");
    expect(source).toContain('from "../../src/permissions/mxc-extension-process.js"');
    expect(source).toContain("await spawnMxcExtensionProcessForDiagnostics(request,");
    expect(source).not.toContain("ForTest");
    expect(readFileSync("scripts/build-main-esbuild.mjs", "utf8")).toContain("...mxcVerificationEntries(repoRoot)");
    // @ts-expect-error standalone build utilities do not emit declarations
    const { mxcVerificationEntries } = await import("../../scripts/lib/mxc-verification-build.mjs");
    expect(mxcVerificationEntries(process.cwd(), {})).toEqual({});
    expect(mxcVerificationEntries(process.cwd(), { AVE_MXC_VERIFICATION_BUILD: "1" })).toEqual({
      "mxc-packaged-probe": path.join(process.cwd(), "tools", "mxc-probes", "packaged-main.ts"),
    });
  });
});


describe("packaged observation finalization", () => {
  const root = path.resolve(tmpdir(), "packaged-finalization-owned");
  const observed = () => ({ temp: root, observations: Array.from({ length: 6 }, (_, index) => ({ name: String(index), passed: true })) });

  it("removes only the allocated root after verified cleanup", async () => {
    const io = { measure: vi.fn(async () => 123), remove: vi.fn(async () => {}), write: vi.fn(async () => {}) };
    const result = await finalizePackagedObservation(observed(), root, true, io);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(root, { recursive: true });
    expect(io.write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ nativeVerified: true, cleanupVerified: true, tempRemoved: true, verdict: "measured" });
  });

  it("keeps failed native observations even after eventual process cleanup is verified", async () => {
    const io = { measure: vi.fn(async () => 123), remove: vi.fn(async () => {}), write: vi.fn(async () => {}) };
    const original = observed(); original.observations[0].passed = false;
    const result = await finalizePackagedObservation(original, root, true, io);
    expect(io.remove).not.toHaveBeenCalled();
    expect(io.write).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ cleanupVerified: true, nativeVerified: false, tempRemoved: false, verdict: "inconclusive" });
    expect(result.tempSizeBytes).toBeGreaterThan(123);
  });

  it("retains prior native rows and the owned path when removal fails", async () => {
    const original = observed(), rows = original.observations;
    const io = { measure: vi.fn(async () => 123), remove: vi.fn(async () => { throw new Error("root removal denied"); }), write: vi.fn(async () => {}) };
    const result = await finalizePackagedObservation(original, root, true, io);
    expect(result.observations).toBe(rows);
    expect(result).toMatchObject({ temp: root, nativeVerified: false, cleanupVerified: false, tempRemoved: false, verdict: "inconclusive",
      finalizationErrors: [{ stage: "remove-temp", message: "root removal denied" }] });
    expect(io.write).toHaveBeenCalledExactlyOnceWith(path.join(root, "observations.json"), JSON.stringify(result, null, 2) + "\n");
  });

  it("reports retained-observation write failure without losing earlier evidence", async () => {
    const original = observed(), rows = original.observations;
    const io = { measure: vi.fn(async () => 123), remove: vi.fn(async () => {}), write: vi.fn(async () => { throw new Error("observation write denied"); }) };
    const result = await finalizePackagedObservation(original, root, false, io);
    expect(io.remove).not.toHaveBeenCalled();
    expect(result.observations).toBe(rows);
    expect(result).toMatchObject({ temp: root, nativeVerified: false, cleanupVerified: false, verdict: "inconclusive",
      finalizationErrors: [{ stage: "retain-observations", message: "observation write denied" }] });
  });

  it("reports both removal and diagnostic failures in the returned JSON", async () => {
    const original = observed(), rows = original.observations;
    const io = { measure: vi.fn(async () => 123), remove: vi.fn(async () => { throw new Error("remove failed"); }), write: vi.fn(async () => { throw new Error("write failed"); }) };
    const result = await finalizePackagedObservation(original, root, true, io);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ temp: root, observations: rows, nativeVerified: false, cleanupVerified: false,
      finalizationErrors: [{ stage: "remove-temp", message: "remove failed" }, { stage: "retain-observations", message: "write failed" }] });
  });
});

describe("owner-type handle comparisons with injected native calls", () => {
  const owner = { value: 4n, objectTypeIndex: 7, attributes: 0 };
  function calls() {
    return { duplicate: vi.fn((value: bigint) => value + 100n), compare: vi.fn(() => 0xc00001ac), close: vi.fn() };
  }

  it("ignores unrelated non-duplicable object types and compares only owner-type handles", () => {
    const native = calls();
    native.duplicate.mockImplementation((value) => { if (value === 8n) throw new Error("Unrelated handle cannot be duplicated"); return value + 100n; });
    const result = inspectOwnerHandleCandidates(owner, [{ value: 8n, objectTypeIndex: 13 }, { value: 12n, objectTypeIndex: 7 }], native);
    expect(result).toEqual({ inherited: false, inspected: 1 });
    expect(native.duplicate).toHaveBeenCalledExactlyOnceWith(12n);
    expect(native.close).toHaveBeenCalledExactlyOnceWith(112n);
    expect(ownerHandleObservationPassed({ supervisorInheritable: false, descendants: [result] })).toBe(true);
  });

  it("does not accept empty or entirely unrelated descendant evidence", () => {
    for (const entries of [[], [{ value: 8n, objectTypeIndex: 13 }]]) {
      const native = calls();
      expect(() => inspectOwnerHandleCandidates(owner, entries, native)).toThrow(/No owner-type descendant handles/);
      expect(native.duplicate).not.toHaveBeenCalled();
    }
    expect(ownerHandleObservationPassed({ supervisorInheritable: false, descendants: [] })).toBe(false);
    expect(ownerHandleObservationPassed({ supervisorInheritable: false, descendants: [{ inherited: false, inspected: 1 }, { inherited: false, inspected: 0 }] })).toBe(false);
  });

  it("reports same-type duplication failure and stale type comparisons as inconclusive", () => {
    const duplicateFailure = { duplicate: vi.fn(() => null), compare: vi.fn(), close: vi.fn() };
    expect(() => inspectOwnerHandleCandidates(owner, [{ value: 12n, objectTypeIndex: 7 }], duplicateFailure)).toThrow(/Same-type child handle/);
    expect(duplicateFailure.compare).not.toHaveBeenCalled();
    const native = calls(); native.compare.mockReturnValue(0xc0000024);
    expect(() => inspectOwnerHandleCandidates(owner, [{ value: 12n, objectTypeIndex: 7 }], native)).toThrow(/Handle comparison failed/);
    expect(native.close).toHaveBeenCalledExactlyOnceWith(112n);
  });

  it("rejects an inherited owner object despite nonzero inspection evidence", () => {
    const native = calls(); native.compare.mockReturnValue(0);
    const result = inspectOwnerHandleCandidates(owner, [{ value: 12n, objectTypeIndex: 7 }], native);
    expect(result).toEqual({ inherited: true, inspected: 1 });
    expect(ownerHandleObservationPassed({ supervisorInheritable: false, descendants: [result] })).toBe(false);
    expect(ownerHandleObservationPassed({ supervisorInheritable: true, descendants: [{ inherited: false, inspected: 1 }] })).toBe(false);
  });
});

describe("negative-control identity and limited stdio claims", () => {
  it("requires the specific planted path, rather than any integrity error", () => {
    const target = "@microsoft/mxc-sdk/bin/x64/planted.dll";
    expect(plantedDllRejected({ name: "MxcIntegrityError", message: "Unexpected native payload: " + target }, target)).toBe(true);
    expect(plantedDllRejected({ name: "MxcIntegrityError", message: String.raw`Unexpected native payload: @microsoft\mxc-sdk\bin\x64\planted.dll` }, target)).toBe(true);
    expect(plantedDllRejected({ name: "MxcIntegrityError", message: "Unrelated SDK hash mismatch" }, target)).toBe(false);
    expect(plantedDllRejected({ name: "Error", message: target }, target)).toBe(false);
    expect(plantedDllRejected({ name: "MxcIntegrityError", message: "Unexpected native payload: " + target + ".backup" }, target)).toBe(false);
  });

  it("does not claim that local writable thresholds establish end-to-end backpressure", () => {
    expect(stdioObservation(completeStdioFrame()).passed).toBe(true);
    expect(stdioObservation({ ...completeStdioFrame(), backpressureWrites: 0 }).passed).toBe(true);
  });
});

describe("retained evidence byte size", () => {
  it("reports the exact tree size including its own evidence file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ave-retained-evidence-"));
    try {
      mkdirSync(path.join(root, "app")); writeFileSync(path.join(root, "app", "payload.bin"), Buffer.alloc(1234));
      const result = await finalizePackagedObservation({ observations: [{ passed: false }] }, root, false);
      expect(result.tempSizeBytes).toBe(await retainedTreeSize(root));
      expect(JSON.parse(readFileSync(path.join(root, "observations.json"), "utf8")).tempSizeBytes).toBe(result.tempSizeBytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the exact path and explicit sizing failure instead of inventing a byte count", async () => {
    const root = path.resolve(tmpdir(), "owned-retained-size-error");
    const result = await finalizePackagedObservation({ observations: [] }, root, false, {
      measure: async () => { throw new Error("Unreadable retained payload"); }, remove: vi.fn(), write: vi.fn(),
    });
    expect(result).toMatchObject({ temp: root, tempSizeBytes: null, tempRemoved: false, nativeVerified: false,
      finalizationErrors: [{ stage: "size-temp", message: "Unreadable retained payload" }] });
  });
});
