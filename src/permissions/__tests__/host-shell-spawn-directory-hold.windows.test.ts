import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { holdHostShellSpawnDirectory, type HostShellSpawnDirectoryHold } from "../host-shell-execution-permit.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";

withSourceHostResources();

const refused = (action: () => void): string | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

describe.runIf(process.platform === "win32")("host shell spawn directory hold", () => {
  let root: string;
  let parent: string;
  let leaf: string;
  let hold: HostShellSpawnDirectoryHold | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-cwd-hold-")));
    parent = join(root, "parent");
    leaf = join(parent, "leaf");
    mkdirSync(leaf, { recursive: true });
    mkdirSync(join(root, "sibling"));
    hold = undefined;
  });
  afterEach(async () => {
    hold?.dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(parent, join(root, "released")))).toBeUndefined());
    await cleanupTmpDir(root);
  });

  const identityOf = (path: string) => {
    const identity = captureShellWorkingDirectoryIdentity(path);
    if (identity === undefined) throw new Error("directory identity unavailable");
    return identity;
  };
  const holdLeaf = async () => {
    const held = await holdHostShellSpawnDirectory({ cwdIdentity: identityOf(leaf) });
    if (held === undefined) throw new Error("directory not held");
    hold = held;
    return held;
  };

  it("refuses rename and delete of the directory and its ancestors while held, and leaves a sibling alone", async () => {
    await holdLeaf();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => rmdirSync(leaf))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => renameSync(parent, join(root, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(existsSync(leaf)).toBe(true);
    expect(refused(() => renameSync(join(root, "sibling"), join(root, "sibling-moved")))).toBeUndefined();
  });

  it("releases on dispose when no child was bound", async () => {
    (await holdLeaf()).dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("keeps a bound hold past dispose until the child closes", async () => {
    const held = await holdLeaf();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore", windowsHide: true });
    held.bind(child);
    held.dispose();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    await new Promise(resolve => child.once("close", resolve));
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("refuses a directory replaced at the approved path", async () => {
    const identity = identityOf(leaf);
    renameSync(leaf, join(parent, "original"));
    mkdirSync(leaf);
    expect(await holdHostShellSpawnDirectory({ cwdIdentity: identity })).toBeUndefined();
  });
});
