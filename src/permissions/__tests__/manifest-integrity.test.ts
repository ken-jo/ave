// Permission policy Area C — manifest integrity proxy tests. docs/architecture/permission-policy-design.md.
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as nodeFs from "node:fs";
import {
  ManifestIntegrityError,
  ManifestIntegrityState,
  bindManifestIntegrityLogging,
  createReadOnlyFsProxy,
  createReadOnlyFsPromisesProxy,
  manifestIntegrityState,
  READ_ONLY_FS_DENY_METHODS,
} from "../manifest-integrity.js";

beforeEach(() => {
  manifestIntegrityState.resetForTests();
});

describe("Permission policy P4 createReadOnlyFsProxy", () => {
  it("passes through read methods", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    expect(typeof (proxy as { readFileSync: unknown }).readFileSync).toBe("function");
    expect(typeof (proxy as { readdirSync: unknown }).readdirSync).toBe("function");
  });

  it("throws ManifestIntegrityError on writeFileSync", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "rogue-plugin",
      toolName: "rogue-tool",
    });
    const writeFn = (proxy as { writeFileSync: (...args: unknown[]) => void }).writeFileSync;
    expect(() => writeFn("/tmp/x", "data")).toThrow(ManifestIntegrityError);
    try {
      writeFn("/tmp/x", "data");
    } catch (err) {
      expect((err as ManifestIntegrityError).code).toBe("MANIFEST_INTEGRITY_VIOLATION");
      expect((err as ManifestIntegrityError).pluginId).toBe("rogue-plugin");
      expect((err as ManifestIntegrityError).toolName).toBe("rogue-tool");
      expect((err as ManifestIntegrityError).attemptedMethod).toBe("writeFileSync");
    }
  });

  it("throws on every deny-list write method", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    const sample = ["unlinkSync", "mkdirSync", "rmSync", "renameSync", "chmodSync", "createWriteStream"];
    for (const method of sample) {
      const fn = (proxy as Record<string, unknown>)[method];
      expect(typeof fn).toBe("function");
      expect(() => (fn as () => void)()).toThrow(ManifestIntegrityError);
    }
  });

  it("captured property reference still throws when invoked later", () => {
    const proxy = createReadOnlyFsProxy(nodeFs as unknown as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    const captured = (proxy as { writeFileSync: () => void }).writeFileSync;
    expect(() => captured()).toThrow(ManifestIntegrityError);
  });
});

describe("Permission policy P4 createReadOnlyFsPromisesProxy", () => {
  it("passes through read methods (e.g. readFile)", () => {
    const proxy = createReadOnlyFsPromisesProxy({ readFile: () => "ok" } as Record<string, unknown>, {
      pluginId: "p",
      toolName: "t",
    });
    expect(typeof (proxy as { readFile: unknown }).readFile).toBe("function");
  });

  it("rejects async-thrown when calling writeFile", async () => {
    const proxy = createReadOnlyFsPromisesProxy({} as Record<string, unknown>, {
      pluginId: "rogue",
      toolName: "t1",
    });
    const writeFn = (proxy as { writeFile: () => Promise<void> }).writeFile;
    await expect(writeFn()).rejects.toThrow(ManifestIntegrityError);
  });
});

describe("Permission policy P4 ManifestIntegrityState", () => {
  it("recordViolation marks a plugin disabled", async () => {
    const state = new ManifestIntegrityState();
    expect(state.isDisabled("p")).toBe(false);
    await state.recordViolation("p", "t", "writeFileSync");
    expect(state.isDisabled("p")).toBe(true);
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("recordViolation is idempotent", async () => {
    const state = new ManifestIntegrityState();
    await state.recordViolation("p", "t", "writeFileSync");
    await state.recordViolation("p", "t", "writeFileSync");
    expect(state.listDisabled()).toEqual(["p"]);
  });

  it("onViolation listeners fire", async () => {
    const state = new ManifestIntegrityState();
    const fn = vi.fn();
    const dispose = state.onViolation(fn);
    await state.recordViolation("p", "t", "rmSync");
    expect(fn).toHaveBeenCalledWith("p", "t", "rmSync");
    dispose();
    await state.recordViolation("p2", "t2", "writeFileSync");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("manifest quarantine logging", () => {
  it("logs the operation and disables the plugin", async () => {
    const state = new ManifestIntegrityState();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      bindManifestIntegrityLogging(state);
      await state.recordViolation("p", "tool_x", "writeFileSync");
      expect(state.isDisabled("p")).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        event: "manifest_integrity_violation", pluginId: "p", tool: "tool_x",
        operation: "writeFileSync", trustOrigin: "plugin-emitted",
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps the plugin quarantined when its log sink throws", async () => {
    const state = new ManifestIntegrityState();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("sink unavailable"); });
    try {
      bindManifestIntegrityLogging(state);
      await state.recordViolation("p", "tool_x", "writeFileSync");
      expect(state.isDisabled("p")).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});

describe("Permission policy P4 deny-list completeness", () => {
  it("includes all sync write entry points", () => {
    expect(READ_ONLY_FS_DENY_METHODS.has("writeFileSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("appendFileSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("mkdirSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("rmSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("unlinkSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("renameSync")).toBe(true);
    expect(READ_ONLY_FS_DENY_METHODS.has("createWriteStream")).toBe(true);
  });

  it("does NOT include read methods (positive control)", () => {
    expect(READ_ONLY_FS_DENY_METHODS.has("readFileSync")).toBe(false);
    expect(READ_ONLY_FS_DENY_METHODS.has("readdirSync")).toBe(false);
    expect(READ_ONLY_FS_DENY_METHODS.has("statSync")).toBe(false);
  });
});
