import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../windows-drive-locality.js");

import { createPluginSurfacePermissionScope } from "../../boot/plugin-surface-permissions.js";
import type { PluginToolInvocationContext } from "../../plugins/runtime/index.js";
import { RoutineEngine } from "../../routines/routine-engine.js";
import { admitLocalPath, withLocalityDecision } from "../local-path-io.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

describe.runIf(process.platform === "win32")("revocation changes live state only after its whole judgment", () => {
  let root: string;
  let failingDrive: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-revocation-")));
    failingDrive = root.toUpperCase().startsWith("Y:") ? "X:" : "Y:";
    setWindowsDriveQueryForTest((drive) => {
      if (drive.toUpperCase() === failingDrive) throw new Error("drive query failed");
      return String.raw`\Device\HarddiskVolume1`;
    });
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps every plugin owner's session grants when a later owner's judgment fails", () => {
    const revoked = vi.fn();
    const scope = createPluginSurfacePermissionScope({ readPersistedDirectories: () => [], onSessionDirectoriesRevoked: revoked });
    const grant = (ownerPluginId: string, directory: string) => scope.createPermissionContext(
      { ownerPluginId } as PluginToolInvocationContext, {} as never,
    ).onSessionDirectoryGrant?.(directory);
    grant("first", join(root, "work"));
    grant("second", `${failingDrive}\\shared`);

    expect(() => scope.revokeWorkspaceRoot(root)).toThrow("drive query failed");
    expect(revoked).not.toHaveBeenCalled();
    setWindowsDriveQueryForTest(() => String.raw`\Device\HarddiskVolume1`);
    expect(scope.revokeWorkspaceRoot(root)).toMatchObject({ sessionDirectoriesRemoved: 1 });
    expect(revoked).toHaveBeenCalledOnce();
  });

  it("records no routine policy and revokes no loop when a later loop's judgment fails", () => {
    const applied: string[] = [];
    const judge = (name: string, path: string) => () => {
      withLocalityDecision(() => admitLocalPath(path));
      return () => {
        applied.push(name);
        return { sessionDirectoriesRemoved: 1, turnDirectoriesRemoved: 0, projectRebound: false };
      };
    };
    const loop = (name: string, path: string) => {
      const plan = judge(name, path);
      return { planWorkspaceRootRevocation: plan, revokeWorkspaceRoot: () => plan()() };
    };
    const engine = new RoutineEngine({} as never);
    const internals = engine as unknown as { activeLoops: Set<unknown>; workspaceRootPolicy: Map<string, unknown> };
    internals.activeLoops.add(loop("first", join(root, "work")));
    internals.activeLoops.add(loop("second", `${failingDrive}\\shared`));

    expect(() => engine.revokeWorkspaceRoot(root)).toThrow();
    expect(applied).toEqual([]);
    expect(internals.workspaceRootPolicy.size).toBe(0);
  });
});
