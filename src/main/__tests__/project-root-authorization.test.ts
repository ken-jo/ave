import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAveHomePrivate } from "../../shared/ave-home.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";

// The exclusive broker route is process state owned by the workload runtime; the resolver only asks it two questions, so those are all the fixture answers.
const broker = vi.hoisted(() => ({
  active: false,
  cwd: "/app",
}));

vi.mock("../../workload/runtime.js", () => ({
  isWorkloadBrokerActive: () => broker.active,
  getActiveWorkloadBrokerProjection: () => broker.active
    ? {
        version: "brokered-workload-capability/v1",
        workload: { cwd: broker.cwd },
        expiresAt: "2999-01-01T00:00:00.000Z",
        allowedOperations: [],
      }
    : undefined,
  isActiveWorkloadBrokerCwd: (cwd: string) => broker.active && cwd === broker.cwd,
}));

import { writePermissionSettings } from "../../permissions/permission-settings-store.js";
import {
  defaultWorkspaceProject,
  isAuthorizedWorkspaceProjectRoot,
  listAuthorizedWorkspaceProjects,
  resolveAuthorizedWorkspaceProject,
  sessionBoundProjectRootMatches,
} from "../project-root-authorization.js";
import { projectRootEquals } from "../../shared/project-identity.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let oldHome: string | undefined;
let oldCwd: string;
let root: string;
let workspace: string;

beforeEach(() => {
  oldHome = process.env.AVE_HOME;
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "ave-project-auth-"));
  setFixtureOwner(root);
  const home = join(root, ".ave");
  expect(ensureAveHomePrivate(home)).not.toMatchObject({ enforcement: "none" });
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  workspace = realpathSync(workspace);
  process.env.AVE_HOME = home;
  process.chdir(workspace);
});

afterEach(async () => {
  broker.active = false;
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = oldHome;
  await cleanupTmpDir(root);
});

describe("project root authorization", () => {
  it("resolves missing project selection to the app-managed default workspace", () => {
    expect(defaultWorkspaceProject()).toMatchObject({
      projectRoot: workspace,
      isDefault: true,
    });
    expect(resolveAuthorizedWorkspaceProject(undefined)).toMatchObject({
      authorized: true,
      project: {
        projectRoot: workspace,
        isDefault: true,
      },
    });
  });

  it("accepts only default or permission-approved workspace roots", async () => {
    const allowed = join(root, "allowed-project");
    const denied = join(root, "denied-project");
    mkdirSync(allowed);
    mkdirSync(denied);
    const allowedRoot = realpathSync(allowed);
    await writePermissionSettings({ additionalDirectories: [allowedRoot] });

    const allowedResolution = resolveAuthorizedWorkspaceProject(allowedRoot, "stale-label");
    expect(allowedResolution).toMatchObject({
      authorized: true,
      project: {
        projectName: "allowed-project",
      },
    });
    expect(allowedResolution.project).not.toBeNull();
    if (!allowedResolution.project) throw new Error("expected authorized project");
    expect(projectRootEquals(allowedResolution.project.projectRoot, allowedRoot)).toBe(true);
    expect(resolveAuthorizedWorkspaceProject(`${allowedRoot}/`, "another-stale-label")).toMatchObject({
      authorized: true,
      project: {
        projectName: "allowed-project",
      },
    });
    expect(resolveAuthorizedWorkspaceProject(denied, "denied")).toMatchObject({
      authorized: false,
      project: null,
    });
  });

  it("keeps same-basename roots distinct and resolves their current display labels", async () => {
    const left = join(root, "one", "shared");
    const right = join(root, "two", "shared");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const leftRoot = realpathSync(left);
    const rightRoot = realpathSync(right);
    await writePermissionSettings({ additionalDirectories: [leftRoot, rightRoot] });

    const additionalProjects = listAuthorizedWorkspaceProjects().filter((project) => !project.isDefault);
    expect(additionalProjects.map((project) => project.projectName)).toEqual([
      "shared \u2014 one",
      "shared \u2014 two",
    ]);
    const resolution = resolveAuthorizedWorkspaceProject(leftRoot, "stale-label");
    expect(resolution).toMatchObject({
      authorized: true,
      project: {
        projectName: "shared \u2014 one",
      },
    });
    expect(resolution.project).not.toBeNull();
    if (!resolution.project) throw new Error("expected authorized project");
    expect(projectRootEquals(resolution.project.projectRoot, leftRoot)).toBe(true);
  });
});

describe("project root authorization under the exclusive workload-broker route", () => {
  it("authorizes exactly the bound guest cwd and nothing on the controller host", async () => {
    const allowed = join(root, "allowed-project");
    mkdirSync(allowed);
    const allowedRoot = realpathSync(allowed);
    await writePermissionSettings({ additionalDirectories: [allowedRoot] });
    broker.active = true;

    // Byte-for-byte: the guest path is never canonicalized against this host.
    expect(isAuthorizedWorkspaceProjectRoot("/app")).toBe(true);
    expect(isAuthorizedWorkspaceProjectRoot("/app/")).toBe(false);
    expect(isAuthorizedWorkspaceProjectRoot(workspace)).toBe(false);
    expect(isAuthorizedWorkspaceProjectRoot(allowedRoot)).toBe(false);

    const brokered = { projectRoot: "/app", projectName: "app" };
    expect(listAuthorizedWorkspaceProjects()).toEqual([brokered]);
    expect(resolveAuthorizedWorkspaceProject("/app", "stale-label")).toEqual({
      authorized: true,
      project: brokered,
    });
    expect(resolveAuthorizedWorkspaceProject(undefined)).toEqual({
      authorized: true,
      project: brokered,
    });
    // The host default workspace is not a fallback while the broker is bound.
    expect(resolveAuthorizedWorkspaceProject(workspace)).toEqual({
      authorized: false,
      project: null,
    });
    expect(resolveAuthorizedWorkspaceProject(allowedRoot)).toEqual({
      authorized: false,
      project: null,
    });
    // The loop's fallback project is the guest cwd too, so an unauthorized or absent selection can never re-root a brokered session at the host.
    expect(defaultWorkspaceProject()).toEqual(brokered);
    expect(sessionBoundProjectRootMatches("/app", "/app")).toBe(true);
    expect(sessionBoundProjectRootMatches(workspace, "/app")).toBe(false);
    expect(sessionBoundProjectRootMatches(null, "/app")).toBe(false);
  });

  it.skipIf(!canCreateSymlinks())("matches a bound root byte-for-byte or as a default-workspace alias on the host", () => {
    const alias = join(root, "workspace-alias");
    symlinkSync(workspace, alias);
    expect(sessionBoundProjectRootMatches(workspace, workspace)).toBe(true);
    expect(sessionBoundProjectRootMatches(`${workspace}/`, workspace)).toBe(true);
    expect(sessionBoundProjectRootMatches(workspace, alias)).toBe(true);
    expect(sessionBoundProjectRootMatches(join(root, "elsewhere"), workspace)).toBe(false);
    expect(sessionBoundProjectRootMatches(null, workspace)).toBe(false);
  });

  it.skipIf(!canCreateSymlinks())("resolves a symlink alias of the default workspace to the default project, not a fallback", () => {
    const alias = join(root, "workspace-link");
    symlinkSync(workspace, alias);
    expect(isAuthorizedWorkspaceProjectRoot(alias)).toBe(true);
    expect(resolveAuthorizedWorkspaceProject(alias)).toMatchObject({
      authorized: true,
      project: { projectRoot: workspace, isDefault: true },
    });
  });

  it("leaves host workspace authorization unchanged when no broker is bound", () => {
    expect(isAuthorizedWorkspaceProjectRoot(workspace)).toBe(true);
    expect(isAuthorizedWorkspaceProjectRoot("/app")).toBe(false);
    expect(resolveAuthorizedWorkspaceProject("/app")).toEqual({
      authorized: false,
      project: null,
    });
  });
});
