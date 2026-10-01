/**
 * The per-principal sandbox temp directories: how a principal's id names its
 * directory, how the host creates it, and how boot empties the root.
 *
 * What a confined process can reach through them is measured against the real
 * sandbox in `confined-plugin-child.test.ts` ("the sandbox temp directories").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appOwnedSandboxTempRoot,
  ensureSandboxTempPrincipalDir,
  sandboxTempEnvLaunch,
  sandboxTempPrincipalDirName,
  type SandboxTempPrincipal,
} from "../asrt-sandbox.js";
import { sweepSandboxTempRoot } from "../../boot/steps/sandbox-init.js";
import { makeTestTreeWritable } from "../../plugins/__tests__/test-helpers.js";

let home: string;
let previousAveHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ave-temp-principal-"));
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(home, ".ave");
});

afterEach(async () => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  await makeTestTreeWritable(home);
  rmSync(home, { recursive: true, force: true });
});

describe("a principal's temp directory name", () => {
  it("is the kind and the lowercase hex of the id, one name per id whatever it holds", () => {
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "a/b" })).toBe("plugin-612f62");
    expect(sandboxTempPrincipalDirName({ kind: "mcp", id: ".." })).toBe("mcp-2e2e");
    // Case-insensitive filesystems: two ids that differ only in case keep two names.
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "A" }))
      .not.toBe(sandboxTempPrincipalDirName({ kind: "plugin", id: "a" }));
    // The kind keeps a plugin and an MCP server with the same id apart.
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "same" }))
      .not.toBe(sandboxTempPrincipalDirName({ kind: "mcp", id: "same" }));
    expect(sandboxTempPrincipalDirName({ kind: "mcp", id: "서버" })).toMatch(/^mcp-[0-9a-f]+$/);
  });

  it("refuses an id that cannot name one directory of its own", () => {
    for (const id of ["", "x".repeat(121), "lone\uD800surrogate"]) {
      expect(() => sandboxTempPrincipalDirName({ kind: "plugin", id }), JSON.stringify(id))
        .toThrow(/cannot name a temp directory/);
    }
    // `�` is what a lone surrogate would have encoded to: refusing the
    // surrogate is what keeps the two from sharing a directory.
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "lone�surrogate" })).toMatch(/^plugin-/);
    const longest = sandboxTempPrincipalDirName({ kind: "plugin", id: "x".repeat(120) });
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(255);
    expect(() => sandboxTempPrincipalDirName({ kind: "user" as SandboxTempPrincipal["kind"], id: "x" }))
      .toThrow(/unknown principal kind/);
  });
});

// Windows wraps confine through the sandbox HOME's own per-process TEMP and
// never create these directories; modes and links there are not this contract.
describe.skipIf(process.platform === "win32")("creating a principal's temp directory", () => {
  it("creates it 0o700 under the app-owned root, and gives it back on a second call", () => {
    const first = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" });
    expect(first.root).toBe(appOwnedSandboxTempRoot());
    expect(first.dir).toBe(join(first.root, "plugin-70"));
    expect(lstatSync(first.dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(first.dir, "kept"), "kept");
    expect(ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" })).toEqual(first);
    expect(readFileSync(join(first.dir, "kept"), "utf-8")).toBe("kept");
  });

  it("takes back a mode the principal narrowed", () => {
    const { dir } = ensureSandboxTempPrincipalDir({ kind: "mcp", id: "s" });
    chmodSync(dir, 0o500);
    ensureSandboxTempPrincipalDir({ kind: "mcp", id: "s" });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a link in the directory's place, and leaves its target alone", () => {
    const root = appOwnedSandboxTempRoot();
    mkdirSync(root, { recursive: true });
    const outside = mkdtempSync(join(home, "outside-"));
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(root, sandboxTempPrincipalDirName({ kind: "plugin", id: "p" })));
    expect(() => ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" })).toThrow(/not a directory the host created/);
    expect(lstatSync(outside).mode & 0o777).toBe(0o755);
  });

  it("refuses a file in the directory's place", () => {
    const root = appOwnedSandboxTempRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, sandboxTempPrincipalDirName({ kind: "plugin", id: "p" })), "not a dir");
    expect(() => ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" })).toThrow(/not a directory the host created/);
  });
});

describe("the launcher that sets a principal's temp directory", () => {
  it("assigns TMPDIR, TMP and TEMP ahead of the command, through env(1)", () => {
    expect(sandboxTempEnvLaunch("/t/plugin-70", "/bin/tool", ["a b"])).toEqual({
      command: "/usr/bin/env",
      args: ["TMPDIR=/t/plugin-70", "TMP=/t/plugin-70", "TEMP=/t/plugin-70", "/bin/tool", "a b"],
    });
  });

  it("refuses a command env(1) would read as an assignment", () => {
    expect(() => sandboxTempEnvLaunch("/t/plugin-70", "/opt/a=b/tool", [])).toThrow(/contains '='/);
  });
});

describe("emptying the sandbox temp root at boot", () => {
  it.skipIf(process.platform === "win32")("removes every principal's directory, whatever it made unreadable, and follows no link", async () => {
    const { dir, root } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" });
    const { dir: other } = ensureSandboxTempPrincipalDir({ kind: "mcp", id: "s" });
    const outside = mkdtempSync(join(home, "outside-"));
    writeFileSync(join(outside, "kept"), "kept");
    mkdirSync(join(dir, "locked", "deep"), { recursive: true });
    writeFileSync(join(dir, "locked", "deep", "file"), "x");
    chmodSync(join(dir, "locked"), 0o000);
    symlinkSync(outside, join(other, "link-out"));
    if (process.platform === "darwin") {
      writeFileSync(join(other, "immutable"), "x");
      execFileSync("/usr/bin/chflags", ["uchg", join(other, "immutable")]);
    }
    // A link left at the top of the root, by a version that still granted it.
    symlinkSync(outside, join(root, "plugin-6c696e6b"));

    await sweepSandboxTempRoot(root);
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(join(outside, "kept"), "utf-8")).toBe("kept");
  });

  it.skipIf(process.platform === "win32")("unlinks a root that is a link, and leaves its target alone", async () => {
    const outside = mkdtempSync(join(home, "outside-"));
    writeFileSync(join(outside, "kept"), "kept");
    const root = appOwnedSandboxTempRoot();
    mkdirSync(join(root, ".."), { recursive: true });
    symlinkSync(outside, root);
    await sweepSandboxTempRoot(root);
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(outside, "kept"), "utf-8")).toBe("kept");
  });

  it("does nothing when there is no root yet", async () => {
    await sweepSandboxTempRoot(appOwnedSandboxTempRoot());
    expect(existsSync(appOwnedSandboxTempRoot())).toBe(false);
  });
});
