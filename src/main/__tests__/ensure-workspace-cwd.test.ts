import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceCwd } from "../ensure-workspace-cwd.js";

describe("ensureWorkspaceCwd", () => {
  let prevCwd: string;
  let prevAveHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevAveHome = process.env.AVE_HOME;
    // realpathSync normalizes macOS /var/folders → /private/var/folders so the
    // path matches process.cwd() after chdir (kernel resolves the symlink).
    tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "ave-workspace-cwd-")));
    process.env.AVE_HOME = tmpHome;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates ~/.ave/workspace and anchors process.cwd() to it", () => {
    const workspaceDir = ensureWorkspaceCwd();
    const expected = join(tmpHome, "workspace");
    expect(workspaceDir).toBe(expected);
    expect(process.cwd()).toBe(expected);
    expect(statSync(expected).isDirectory()).toBe(true);
  });

  it("is idempotent — second call succeeds when workspace already exists", () => {
    const first = ensureWorkspaceCwd();
    const second = ensureWorkspaceCwd();
    expect(first).toBe(second);
    expect(process.cwd()).toBe(first);
  });

  it("creates the directory with 0o700 permissions (POSIX)", () => {
    if (process.platform === "win32") return;
    const workspaceDir = ensureWorkspaceCwd();
    const mode = statSync(workspaceDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("honors AVE_HOME env override", () => {
    const customHome = mkdtempSync(join(tmpdir(), "ave-custom-home-"));
    process.env.AVE_HOME = customHome;
    try {
      const workspaceDir = ensureWorkspaceCwd();
      expect(workspaceDir).toBe(join(customHome, "workspace"));
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });
});
