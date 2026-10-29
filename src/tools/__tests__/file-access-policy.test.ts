import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admissionDeniedFilePattern, ensureFileAccess, sensitiveFilePattern } from "../file-access-policy.js";
import * as hostScriptRuntime from "../../main/host-script-runtime.js";
import { findResolvedShellPathViolation } from "../shell-path-policy.js";
import type { ToolExecutionContext } from "../types.js";

let root: string;
let context: ToolExecutionContext;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "file-access-policy-")));
  await mkdir(join(root, "workspace"));
  context = { cwd: join(root, "workspace"), extraAllowedDirectories: [], metadata: {} };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("shared execute-time file gate", () => {
  it("preserves read asymmetry, write confinement, and admitted extra roots", async () => {
    const outside = join(root, "outside.bin");
    await writeFile(outside, "sample");
    expect(ensureFileAccess(outside, context, "read")).toBeNull();
    expect(ensureFileAccess(outside, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(outside, { ...context, blockReadsOutsideWorkingDirectories: true }, "read")).toMatchObject({ isError: true });
    expect(ensureFileAccess(outside, { ...context, extraAllowedDirectories: [root] }, "write")).toBeNull();
    expect(ensureFileAccess(join(context.cwd, "new.bin"), context, "write")).toBeNull();
  });

  it("executes admitted ordinary secret reads and writes while retaining directory confinement", async () => {
    const path = join(context.cwd, ".env");
    await writeFile(path, "synthetic-only");
    expect(sensitiveFilePattern(path)).not.toBeNull();
    expect(admissionDeniedFilePattern(path)).toBeNull();
    expect(ensureFileAccess(path, context, "read")).toBeNull();
    expect(ensureFileAccess(path, context, "write")).toBeNull();
    expect(ensureFileAccess(join(root, ".env"), context, "write")).toMatchObject({ isError: true });
  });

  it("retains live execution-resource write admission for native files and shells", () => {
    const path = join(context.cwd, "staged-command.cjs");
    vi.spyOn(hostScriptRuntime, "hostScriptWriteDenyPaths").mockReturnValue([path]);
    expect(admissionDeniedFilePattern(path, "write")).toBe("host-script-resources");
    expect(ensureFileAccess(path, context, "write")).toMatchObject({ isError: true });
    expect(findResolvedShellPathViolation(path, path, context.cwd, [], "write", false)).toMatchObject({ kind: "sensitive-path" });
    expect(ensureFileAccess(path, context, "read")).toBeNull();
  });

  it("denies host credential stores even with an admitted directory", async () => {
    const path = join(context.cwd, ".ave", "secrets", "key");
    const sensitive = admissionDeniedFilePattern(path);
    expect(sensitive).not.toBeNull();
    for (const effect of ["read", "write"] as const) {
      expect(ensureFileAccess(path, context, effect)).toEqual({ output: `Sensitive path: ${path} matches ${sensitive}`, isError: true });
    }
  });

  it.skipIf(!canCreateSymlinks())("reuses canonical ancestor and sensitive-target policy", async () => {
    const alias = join(root, "alias");
    await symlink(context.cwd, alias);
    expect(ensureFileAccess(join(alias, "new.bin"), context, "write")).toBeNull();
    const sensitive = join(context.cwd, "ave-secrets.json");
    await writeFile(sensitive, "synthetic-only");
    await symlink(sensitive, join(context.cwd, "ordinary"));
    expect(ensureFileAccess(join(context.cwd, "ordinary"), context, "read")?.output).toContain("Sensitive path:");
  });
});
