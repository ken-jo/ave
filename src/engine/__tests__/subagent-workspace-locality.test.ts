import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizePathForMatch } from "../../permissions/sensitive-paths.js";
import { isLocalityFailure } from "../../shared/local-path-io.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { SubAgentRunner } from "../subagent-runner.js";

vi.unmock("../../shared/windows-drive-locality.js");

describe.runIf(process.platform === "win32")("sub-agent workspace removal locality", () => {
  const root = join(tmpdir(), "removed-project");
  const other = root.toUpperCase().startsWith("Z:") ? "Y:" : "Z:";
  const failure = new Error("child drive query failed");
  const query = vi.fn((drive: string) => {
    if (drive.toUpperCase() === other) throw failure;
    return String.raw`\Device\HarddiskVolume1`;
  });

  beforeEach(() => { query.mockClear(); setWindowsDriveQueryForTest(query); });
  afterEach(() => { setWindowsDriveQueryForTest(); });

  it("cancels no wire child and changes no live scope if a later child cannot be judged", () => {
    const runner = new SubAgentRunner({} as never);
    const children = (runner as unknown as { activeChildren: Map<string, unknown> }).activeChildren;
    const abort = vi.fn();
    const commit = vi.fn(() => ({ sessionDirectoriesRemoved: 1, turnDirectoriesRemoved: 0, projectRebound: false }));
    const fail = () => canonicalizePathForMatch(`${other}\\unproven`);
    const later = vi.fn(() => commit);
    children.set("first", {
      childSessionId: "first", wireProjectRoot: root,
      loop: { abortCurrentTurn: abort, planWorkspaceRootRevocation: () => commit, revokeWorkspaceRoot: commit },
    });
    children.set("failing", {
      childSessionId: "failing",
      loop: { planWorkspaceRootRevocation: fail, revokeWorkspaceRoot: fail },
    });
    children.set("later", {
      childSessionId: "later",
      loop: { planWorkspaceRootRevocation: later, revokeWorkspaceRoot: later },
    });
    let thrown: unknown;
    try { runner.revokeWorkspaceRoot(root); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(isLocalityFailure(thrown)).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("surfaces the failed root judgment in preview and after durable detach", async () => {
    const detach = vi.fn(async () => 1);
    const runner = new SubAgentRunner({
      subAgentMemoryManager: { sessions: { detachSessionsFromProject: detach } },
    } as never);
    const failedRoot = `${other}\\removed`;
    expect(() => runner.countTurnsAbortedByWorkspaceRootRemoval(failedRoot)).toThrow(failure);
    await expect(runner.detachSessionsFromProject(failedRoot)).rejects.toBe(failure);
    expect(detach).toHaveBeenCalledOnce();
  });
});
