import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { setProcessPlatform } from "../../__tests__/test-helpers.js";
import { admitMxcExtensionFilesystem, assertExtensionStartAllowed } from "../asrt-sandbox.js";
import {
  __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  setWindowsSandboxSubstrate,
} from "../sandbox-capability.js";
import { planWindowsSandbox } from "../../boot/steps/windows-sandbox-plan.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";

const identity = vi.hoisted(() => ({ valid: true }));
vi.mock("../windows-stamp-targets.js", async original => {
  const actual = await original<typeof import("../windows-stamp-targets.js")>();
  return { ...actual, pinWindowsFilesystemConfig: (filesystem: Parameters<typeof actual.pinWindowsFilesystemConfig>[0]) => {
    if (filesystem === undefined) return filesystem;
    const pin = (entries: typeof filesystem.allowRead) => (entries ?? []).map(entry => ({
      get path() {
        if (!identity.valid) throw new Error("Holder root identity changed");
        return typeof entry === "string" ? entry : entry.path;
      }, literal: true as const,
    }));
    return { ...filesystem, allowRead: pin(filesystem.allowRead), allowWrite: pin(filesystem.allowWrite) };
  } };
});
vi.mock("../sandbox-write-policy.js", async original => {
  const actual = await original<typeof import("../sandbox-write-policy.js")>();
  return { ...actual, buildMandatorySandboxWritePolicy: vi.fn((roots: Parameters<typeof actual.buildMandatorySandboxWritePolicy>[0]) => ({
    allowWrite: roots.map(entry => typeof entry === "string" ? entry : entry.path),
    denyWrite: ["C:\\holder\\data\\.envrc"], narrowedWriteRoots: [],
  })) };
});

const HOST_PLATFORM = process.platform;
const HOLDER_OWNERSHIP = { readRoots: [], writeRoots: ["C:\\holder\\data"], hostStorageRoots: [] };
beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
afterEach(() => {
  setProcessPlatform(HOST_PLATFORM);
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
  identity.valid = true;
  vi.clearAllMocks();
});

describe("holder filesystem admission", () => {
  it("requires the native platform and explicit holder roots", () => {
    setProcessPlatform("darwin");
    expect(() => admitMxcExtensionFilesystem({ allowRead: [], allowWrite: [] })).toThrow(/requires win32/);
    setProcessPlatform("win32");
    expect(() => admitMxcExtensionFilesystem({ allowRead: [] })).toThrow(/explicit holder/);
  });

  it("keeps only this holder's roots and shared mandatory controls without a session", () => {
    setProcessPlatform("win32");
    const admitted = admitMxcExtensionFilesystem({ allowRead: ["C:\\runtime"], allowWrite: ["C:\\holder\\data"],
      denyRead: ["C:\\holder\\data\\private"], denyWrite: ["C:\\holder\\data\\readonly"] }, HOLDER_OWNERSHIP);
    expect(admitted.policy.allowRead).toEqual(["C:\\runtime"]);
    expect(admitted.policy.allowWrite).toEqual(["C:\\holder\\data"]);
    expect(admitted.policy.denyRead).toContain("C:\\holder\\data\\private");
    expect(admitted.policy.denyWrite).toEqual(expect.arrayContaining(["C:\\holder\\data\\readonly", "C:\\holder\\data\\.envrc"]));
    expect(buildMandatorySandboxWritePolicy).toHaveBeenCalledOnce();
    admitted.assertStillValid();
    identity.valid = false;
    expect(admitted.assertStillValid).toThrow(/identity changed/);
  });

  it.each(["C:\\holder\\data", "C:\\holder"])("keeps explicit read deny %s over equal or descendant read/write grants", deny => {
    setProcessPlatform("win32");
    const admitted = admitMxcExtensionFilesystem({ allowRead: ["C:\\holder\\data"], allowWrite: ["C:\\holder\\data"], denyRead: [deny] }, HOLDER_OWNERSHIP);
    expect(admitted.policy.protectedFloor).toContain(deny);
    expect(rankMxcFilesystem(admitted.policy, () => true)).toMatchObject({ readwrite: [], readonly: [] });
  });

  it("binds every write grant to the host-captured write roots, inside or outside plugin namespaces", () => {
    setProcessPlatform("win32");
    for (const ownership of [undefined, { ...HOLDER_OWNERSHIP, writeRoots: ["C:\\holder\\other"] }]) {
      expect(() => admitMxcExtensionFilesystem({ allowRead: ["C:\\runtime"], allowWrite: ["C:\\holder\\data"] }, ownership))
        .toThrow(/outside this holder's captured write roots/);
    }
  });

  it("rejects pattern denies whose future matches cannot be fixed in a container policy", () => {
    setProcessPlatform("win32");
    expect(() => admitMxcExtensionFilesystem({ allowRead: ["C:\\runtime"], allowWrite: [], denyRead: ["C:\\holder\\*.secret"] })).toThrow(/represented literally/);
  });

  it("refuses volume-root file-content grants", () => {
    setProcessPlatform("win32");
    expect(() => admitMxcExtensionFilesystem({ allowRead: ["C:\\"], allowWrite: [] })).toThrow(/query access only/);
  });
});

describe("legacy adapter admission", () => {
  it("blocks checking and rejected starts before an unconfined or account holder can spawn", () => {
    setProcessPlatform("win32");
    for (const reason of ["readiness-deadline", "runtime-start-failed"] as const) {
      const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
        mxc: { state: "available" }, extensionMxc: { state: "unavailable", reason },
        admittedAncestorBackend: "srt-win", windowsBuild: null, srtWinReady: true });
      expect(substrate.extensionPlan?.readiness).toBe("rejected");
      setWindowsSandboxSubstrate(substrate);
      expect(() => assertExtensionStartAllowed()).toThrow(/has not admitted/);
    }
  });

  it("requires native streams for selected containers and preserves the worker refusal code", () => {
    setProcessPlatform("win32");
    const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
      mxc: { state: "available" }, extensionMxc: { state: "available" }, windowsBuild: null, srtWinReady: false });
    setWindowsSandboxSubstrate(substrate);
    // Holder-neutral for plugin children, MCP and hooks; the D1 worker code only for a declared worker.
    expect(() => assertExtensionStartAllowed()).toThrow(expect.objectContaining({ code: "native-entry-required" }));
    expect(() => assertExtensionStartAllowed({ holder: "worker" })).toThrow(expect.objectContaining({ code: "worker-transport-unsupported" }));
    expect(() => assertExtensionStartAllowed({ backend: "mxc" })).not.toThrow();
  });

  it("refuses an explicit native adapter on a selected account fallback", () => {
    setProcessPlatform("win32");
    const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
      mxc: { state: "available" }, windowsBuild: null, srtWinReady: true });
    setWindowsSandboxSubstrate(substrate);
    expect(() => assertExtensionStartAllowed({ backend: "mxc" })).toThrow(/not ready/);
  });
});
