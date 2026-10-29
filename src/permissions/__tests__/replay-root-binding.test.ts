import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureReplayRootDigest, checkReplayRootBinding, issueReplayRootBinding } from "../reviewer/replay-root-binding.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(async () => { await resources.cleanup(); });

describe("host replay root binding", () => {
  it("contains no serialized paths and rejects copied or invented tokens", () => {
    const root = resources.makeTmpDir("ave-replay-root-");
    const binding = issueReplayRootBinding(root, captureReplayRootDigest(root)!);
    expect(binding).toBeDefined();
    expect(checkReplayRootBinding(binding)).toEqual({ valid: true });
    expect(JSON.stringify(binding)).toBe("{}");
    expect(checkReplayRootBinding({ ...binding })).toMatchObject({ valid: false });
    expect(checkReplayRootBinding({ cwd: root, digest: captureReplayRootDigest(root) })).toMatchObject({ valid: false });
    expect(checkReplayRootBinding(undefined)).toMatchObject({ valid: false });
  });

  it("rejects a different or missing root at issue time", () => {
    const root = resources.makeTmpDir("ave-replay-root-");
    const other = resources.makeTmpDir("ave-replay-root-other-");
    expect(issueReplayRootBinding(other, captureReplayRootDigest(root)!)).toBeUndefined();
    expect(captureReplayRootDigest(join(root, "missing"))).toBeUndefined();
    expect(captureReplayRootDigest("relative")).toBeUndefined();
  });

  it("invalidates an issued token when a directory is replaced during an approval wait", () => {
    const root = resources.makeTmpDir("ave-replay-root-");
    const project = join(root, "project");
    mkdirSync(project);
    const binding = issueReplayRootBinding(project, captureReplayRootDigest(project)!);
    expect(checkReplayRootBinding(binding)).toEqual({ valid: true });
    renameSync(project, join(root, "original-project"));
    mkdirSync(project);
    expect(checkReplayRootBinding(binding)).toEqual({ valid: false, reason: "Replay root changed before execution" });
  });
});
