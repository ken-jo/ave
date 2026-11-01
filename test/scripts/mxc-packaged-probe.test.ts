import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error standalone probe utilities do not emit declarations
import { exactOwnedPath, finalizePackagedObservation, handleSnapshot, packagedProbeOptions, stdioObservation } from "../../tools/mxc-probes/packaged-protocol.mjs";

const executable = path.resolve(tmpdir(), "packaged-probe", "Ave.exe");

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
    bytes.writeUInt32LE(2, 16 + 32);
    bytes.writeBigUInt64LE(0xfedcba9876543210n, 56);
    bytes.writeUInt32LE(0, 56 + 32);
    expect(handleSnapshot(bytes)).toEqual([
      { value: 0x123456789abcdef0n, attributes: 2 },
      { value: 0xfedcba9876543210n, attributes: 0 },
    ]);
  });

  it("accepts an empty handle snapshot", () => {
    expect(handleSnapshot(Buffer.alloc(16))).toEqual([]);
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
    backpressureWrites: 1, stderr: "fixture-input-eof\n",
    result: { exitCode: 0, timedOut: false },
  };
}

describe("stdio observation classification", () => {
  it("requires a complete byte, backpressure and EOF observation", () => {
    const frame = completeStdioFrame();
    expect(stdioObservation(frame)).toEqual({ ...frame, passed: true });
  });

  it.each([
    { received: 1 }, { expected: 1 }, { sha256: "b".repeat(64) },
    { sha256: "invalid", expectedSha256: "invalid" },
    { backpressureWrites: 0 }, { backpressureWrites: 1.5 },
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
  it("bundles a separate entry that invokes the public owned-process primitive", () => {
    const source = readFileSync("tools/mxc-probes/packaged-main.ts", "utf8");
    expect(source).toContain('from "../../src/permissions/mxc-extension-process.js"');
    expect(source).toContain("await spawnMxcExtensionProcess(request,");
    expect(source).not.toContain("ForTest");
    expect(readFileSync("scripts/build-main-esbuild.mjs", "utf8")).toContain('"mxc-packaged-probe": resolve(repoRoot, "tools", "mxc-probes", "packaged-main.ts")');
  });
});


describe("packaged observation finalization", () => {
  const root = path.resolve(tmpdir(), "packaged-finalization-owned");
  const observed = () => ({ temp: root, observations: Array.from({ length: 6 }, (_, index) => ({ name: String(index), passed: true })) });

  it("removes only the allocated root after verified cleanup", async () => {
    const io = { remove: vi.fn(async () => {}), write: vi.fn(async () => {}) };
    const result = await finalizePackagedObservation(observed(), root, true, io);
    expect(io.remove).toHaveBeenCalledExactlyOnceWith(root, { recursive: true });
    expect(io.write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ nativeVerified: true, cleanupVerified: true, tempRemoved: true, verdict: "measured" });
  });

  it("retains prior native rows and the owned path when removal fails", async () => {
    const original = observed(), rows = original.observations;
    const io = { remove: vi.fn(async () => { throw new Error("root removal denied"); }), write: vi.fn(async () => {}) };
    const result = await finalizePackagedObservation(original, root, true, io);
    expect(result.observations).toBe(rows);
    expect(result).toMatchObject({ temp: root, nativeVerified: false, cleanupVerified: false, tempRemoved: false, verdict: "inconclusive",
      finalizationErrors: [{ stage: "remove-temp", message: "root removal denied" }] });
    expect(io.write).toHaveBeenCalledExactlyOnceWith(path.join(root, "observations.json"), JSON.stringify(result, null, 2) + "\n");
  });

  it("reports retained-observation write failure without losing earlier evidence", async () => {
    const original = observed(), rows = original.observations;
    const io = { remove: vi.fn(async () => {}), write: vi.fn(async () => { throw new Error("observation write denied"); }) };
    const result = await finalizePackagedObservation(original, root, false, io);
    expect(io.remove).not.toHaveBeenCalled();
    expect(result.observations).toBe(rows);
    expect(result).toMatchObject({ temp: root, nativeVerified: false, cleanupVerified: false, verdict: "inconclusive",
      finalizationErrors: [{ stage: "retain-observations", message: "observation write denied" }] });
  });

  it("reports both removal and diagnostic failures in the returned JSON", async () => {
    const original = observed(), rows = original.observations;
    const io = { remove: vi.fn(async () => { throw new Error("remove failed"); }), write: vi.fn(async () => { throw new Error("write failed"); }) };
    const result = await finalizePackagedObservation(original, root, true, io);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ temp: root, observations: rows, nativeVerified: false, cleanupVerified: false,
      finalizationErrors: [{ stage: "remove-temp", message: "remove failed" }, { stage: "retain-observations", message: "write failed" }] });
  });
});
