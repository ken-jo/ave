// Verify the postinstall repair makes the native spawn helper executable.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSpawnHelpers,
  nonExecutableSpawnHelpers,
  restoreSpawnHelperExecBit,
} from "../../scripts/restore-node-pty-exec-bit.mjs";

const REPO_ROOT = process.cwd();
const SCRIPT = resolve(REPO_ROOT, "scripts/restore-node-pty-exec-bit.mjs");
const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];

function fixturePty(): string {
  const root = mkdtempSync(join(tmpdir(), "ave-node-pty-"));
  roots.push(root);
  for (const dir of ["prebuilds/darwin-arm64", "prebuilds/darwin-x64", "build/Release"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "spawn-helper"), "#!/bin/sh\n");
    chmodSync(join(root, dir, "spawn-helper"), 0o644);
  }
  mkdirSync(join(root, "prebuilds/win32-x64"), { recursive: true });
  writeFileSync(join(root, "prebuilds/win32-x64/pty.node"), "");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("restore-node-pty-exec-bit", () => {
  it.runIf(process.platform !== "win32")("adds the execute bits to every shipped or built helper", () => {
    const root = fixturePty();
    expect(findSpawnHelpers(root)).toHaveLength(3);
    expect(nonExecutableSpawnHelpers(root)).toHaveLength(3);
    expect(restoreSpawnHelperExecBit(root)).toHaveLength(3);
    for (const helper of findSpawnHelpers(root)) expect(statSync(helper).mode & 0o777).toBe(0o755);
    expect(restoreSpawnHelperExecBit(root)).toEqual([]);
  });

  it("does nothing on Windows, where the helper is never used", () => {
    const root = fixturePty();
    expect(restoreSpawnHelperExecBit(root, { platform: "win32" })).toEqual([]);
  });

  // Check the installed helper without repairing it, so skipped postinstall work remains visible.
  it.runIf(process.platform !== "win32")("finds every installed node-pty helper executable", () => {
    const ptyRoot = join(REPO_ROOT, "node_modules", "node-pty");
    if (process.platform === "darwin") expect(findSpawnHelpers(ptyRoot).length).toBeGreaterThan(0);
    expect(nonExecutableSpawnHelpers(ptyRoot)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("runs as a command and exits cleanly on the installed tree", () => {
    const result = spawnSync(nodeCommand, [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
