import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { criticalDeleteTargetFor } from "../sensitive-paths.js";
import { PermissionTestResources } from "./test-resources.js";

vi.mock("../../workload/runtime.js", async original => ({
  ...await original<typeof import("../../workload/runtime.js")>(),
  getActiveWorkloadBrokerProjection: () => ({ workload: { id: "a".repeat(64), home: "/home/alice" } }),
}));

const resources = new PermissionTestResources();
afterEach(async () => { vi.restoreAllMocks(); await resources.cleanup(); });

describe("guest deletion roots", () => {
  it.each([".", "/app", "/home/alice", "/"])("forces consent for deletion of an issued guest root: %s", operand => {
    const controller = realpathSync.native(resources.makeTmpDir("ave-guest-delete-"));
    const manager = new PermissionManager(join(controller, "permissions.json"));
    manager.setMode("allow");
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command: `rm -rf ${operand}`, cwd: controller },
      shellExecution: { runsSandboxed: true }, guestCwd: "/app",
      disposableSubstrate: { authority: "workload-broker", id: "a".repeat(64) },
    })).toMatchObject({ decision: "ask", reasonCode: "critical-delete", forceModal: true });
  });

  it("does not apply the controller project root to a guest namesake", () => {
    const controller = realpathSync.native(resources.makeTmpDir("ave-guest-delete-"));
    const manager = new PermissionManager(join(controller, "permissions.json"));
    manager.setMode("allow");
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command: `rm -rf '${controller.replaceAll("\\", "/")}'`, cwd: controller },
      shellExecution: { runsSandboxed: true }, guestCwd: "/app",
      disposableSubstrate: { authority: "workload-broker", id: "a".repeat(64) },
    })).toMatchObject({ decision: "allow" });
  });

  it("compares opaque guest roots without resolving the controller home", () => {
    const resolveNative = vi.spyOn(realpathSync, "native");
    expect(criticalDeleteTargetFor({ lexical: "/app", canonical: "/app" }, ["/app"], { inspectHostFiles: false })).toBe("/app");
    expect(criticalDeleteTargetFor({ lexical: "/logs/result", canonical: "/logs/result" }, ["/app"], { inspectHostFiles: false })).toBeUndefined();
    expect(resolveNative).not.toHaveBeenCalled();
  });
});
