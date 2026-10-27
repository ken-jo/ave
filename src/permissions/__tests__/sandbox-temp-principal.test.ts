import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
// Native sandbox temp isolation is covered in confined-plugin-child.test.ts; this suite checks principal naming, creation and boot cleanup.
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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  appOwnedSandboxHomeRoot,
  appOwnedSandboxPrivateRoots,
  appOwnedSandboxTempRoot,
  appOwnedTerminalHandoffRoot,
  buildPerCommandSandboxCustomConfig,
  ensureSandboxPrivateRoot,
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  getBuiltinShellReadPolicy,
  getBuiltinShellSessionReadPolicy,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapWorkerCommand,
  sandboxTempPrincipalDirsInUse,
  sandboxTempEnvLaunch,
  sandboxTempPrincipalDirName,
  type SandboxTempPrincipal,
} from "../asrt-sandbox.js";
import { sweepSandboxPrivateRoot } from "../../boot/steps/sandbox-init.js";
import { makeTestTreeWritable } from "../../plugins/__tests__/test-helpers.js";
import { createSandboxProcessHome } from "../sandbox-process-home.js";
import { asrtCanInitialize } from "./test-helpers.js";

let home: string;
let previousAveHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ave-temp-principal-"));
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(home, ".ave");
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  await makeTestTreeWritable(home);
  rmSync(home, { recursive: true, force: true });
});

describe("a principal's temp directory name", () => {
  it("is the kind and the lowercase hex of the id, one name per id whatever it holds", () => {
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "a/b" })).toBe("plugin-612f62");
    expect(sandboxTempPrincipalDirName({ kind: "mcp", id: ".." })).toBe("mcp-2e2e");
    expect(sandboxTempPrincipalDirName({ kind: "hook", id: "same" })).toBe("hook-73616d65");
    expect(sandboxTempPrincipalDirName({ kind: "hook", id: "same" }))
      .not.toBe(sandboxTempPrincipalDirName({ kind: "plugin", id: "same" }));
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
    // `�` is what a lone surrogate would have encoded to: refusing the surrogate is what keeps the two from sharing a directory.
    expect(sandboxTempPrincipalDirName({ kind: "plugin", id: "lone�surrogate" })).toMatch(/^plugin-/);
    const longest = sandboxTempPrincipalDirName({ kind: "plugin", id: "x".repeat(120) });
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(255);
    expect(() => sandboxTempPrincipalDirName({ kind: "user" as SandboxTempPrincipal["kind"], id: "x" }))
      .toThrow(/unknown principal kind/);
  });
});

// Windows wraps confine through the sandbox HOME's own per-process TEMP and never create these directories; modes and links there are not this contract.
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

describe("emptying a sandbox private root at boot", () => {
  it.skipIf(process.platform === "win32")("keeps what this process created, by either spelling of the root", async () => {
    const { dir: kept, root } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "kept" });
    const { dir: stale } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "stale" });
    // The production set: every directory this process handed to a wrap.
    expect(sandboxTempPrincipalDirsInUse().has(kept)).toBe(true);
    await sweepSandboxPrivateRoot(root, new Set([kept]));
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    // A HOME is recorded by its canonical path, which differs from the lexical one wherever the root sits under a link (macOS `/var` → `/private/var`).
    const canonicalKept = join(realpathSync(root), sandboxTempPrincipalDirName({ kind: "plugin", id: "kept" }));
    await sweepSandboxPrivateRoot(root, new Set([canonicalKept]));
    expect(existsSync(kept)).toBe(true);
  });

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

    await sweepSandboxPrivateRoot(root, new Set());
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(join(outside, "kept"), "utf-8")).toBe("kept");
  });

  it.skipIf(process.platform === "win32")("unlinks a root that is a link, and leaves its target alone", async () => {
    const outside = mkdtempSync(join(home, "outside-"));
    writeFileSync(join(outside, "kept"), "kept");
    const root = appOwnedSandboxTempRoot();
    mkdirSync(join(root, ".."), { recursive: true });
    symlinkSync(outside, root);
    await sweepSandboxPrivateRoot(root, new Set());
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(outside, "kept"), "utf-8")).toBe("kept");
  });

  it("does nothing when there is no root yet", async () => {
    await sweepSandboxPrivateRoot(appOwnedSandboxTempRoot(), new Set());
    expect(existsSync(appOwnedSandboxTempRoot())).toBe(false);
  });
});

describe("the private roots in a sandbox read deny", () => {
  it.runIf(process.platform === "darwin")(
    "names each root exactly, as a glob, at its real path, and leaves every other deny as written",
    () => {
      for (const root of appOwnedSandboxPrivateRoots()) ensureSandboxPrivateRoot(root);
      const floor = getDefaultSensitiveReadDenyPaths();
      const denyRead = buildPerCommandSandboxCustomConfig({ denyRead: floor })!.filesystem!.denyRead.map((entry) => {
        if (typeof entry !== "string") throw new Error("Expected plain host path entries");
        return entry;
      });
      const tempRoot = realpathSync(appOwnedSandboxTempRoot());
      const homeRoot = realpathSync(appOwnedSandboxHomeRoot());
      const handoffRoot = realpathSync(appOwnedTerminalHandoffRoot());
      // A one-character class: the same path, which ASRT re-emits after its allows minus the ones inside it, rather than a literal re-emitted bare.
      expect(denyRead).toContain(`${tempRoot.slice(0, -1)}[p]`);
      expect(denyRead).toContain(`${homeRoot.slice(0, -1)}[e]`);
      expect(denyRead).toContain(`${handoffRoot.slice(0, -1)}[f]`);
      expect(denyRead).not.toContain(appOwnedSandboxTempRoot());
      expect(denyRead).not.toContain(appOwnedSandboxHomeRoot());
      expect(denyRead).not.toContain(appOwnedTerminalHandoffRoot());
      const others = floor.filter((path) => !appOwnedSandboxPrivateRoots().includes(path));
      // A marked `{ path, literal: true }` entry (ASRT 0.0.79) is kept, so it fails the equality.
      expect(denyRead.filter((path) => typeof path !== "string" || !/\[[pef]\]$/.test(path))).toEqual(others);
    },
  );

  it.runIf(process.platform === "linux")("keeps each root literal on Linux, where a deny is a tmpfs mask", () => {
    const floor = getDefaultSensitiveReadDenyPaths();
    expect(buildPerCommandSandboxCustomConfig({ denyRead: floor })!.filesystem!.denyRead).toEqual(floor);
  });

  it.runIf(process.platform === "darwin")("maps canonical private-root denies when the feature home uses a system alias", () => {
    const alias = mkdtempSync(join("/tmp", "ave-private-root-alias-"));
    try {
      process.env.AVE_HOME = join(alias, ".ave");
      for (const root of appOwnedSandboxPrivateRoots()) ensureSandboxPrivateRoot(root);
      const roots = appOwnedSandboxPrivateRoots();
      const denyRead = buildPerCommandSandboxCustomConfig({ denyRead: getDefaultSensitiveReadDenyPaths() })!.filesystem!.denyRead;
      for (const root of roots) {
        const canonical = realpathSync(root);
        expect(canonical).not.toBe(root);
        expect(denyRead).toContain(`${canonical.slice(0, -1)}[${canonical.slice(-1)}]`);
        expect(denyRead).not.toContain(canonical);
        expect(denyRead).not.toContain(root);
      }
    } finally { rmSync(alias, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux").each(
    process.platform === "darwin" ? [[false, false], [true, false], [false, true], [true, true]] : [[false, false], [true, false]],
  )(
    "keeps its own HOME readable under an ancestor grant with session access refused=%s and alias=%s",
    async (sessionRefused, aliased) => {
      if (aliased && process.platform === "darwin" && home.startsWith("/private/")) {
        process.env.AVE_HOME = join(home.slice("/private".length), ".ave");
      }
      if (!(await asrtCanInitialize())) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
        return;
      }
      const sessionRoot = getBuiltinShellSessionReadPolicy().allowRead[0]!;
      const protectedPath = join(home, "protected", "secret");
      mkdirSync(join(home, "protected"));
      writeFileSync(protectedPath, "protected");
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true,
        denyRead: [protectedPath, ...(sessionRefused ? [sessionRoot] : [])] });
      const own = createSandboxProcessHome();
      const other = createSandboxProcessHome();
      try {
        writeFileSync(join(own.path, "own"), "own");
        writeFileSync(join(other.path, "other"), "other");
        const journal = own.env.AVE_DOCUMENT_JOURNAL!;
        writeFileSync(journal, "before");
        const policy = getBuiltinShellReadPolicy([home, own.path, other.path], homedir(), own.path);
        expect(policy.allowRead).toContain(own.path);
        expect(policy.allowRead).not.toContain(other.path);
        // `home` holds AVE_HOME, as a workspace at the user's HOME holds `~/.ave`: an ancestor of both private roots.
        const { argv, env } = await wrapWorkerCommand(
          `/bin/cat '${join(own.path, "own")}'; echo; printf '%s' '-after' >> '${journal}'; /bin/cat '${journal}'; echo; /bin/cat '${join(other.path, "other")}' 2>/dev/null || echo refused; /bin/cat '${protectedPath}' 2>/dev/null || echo protected-refused`,
          { commandId: TEST_COMMAND_ID,
            filesystem: {
              ...policy,
              allowWrite: [own.path],
              denyWrite: getDefaultSensitiveWriteDenyPaths(),
            },
          },
        );
        const out = execFileSync(argv[0]!, argv.slice(1), { env: { ...env }, encoding: "utf-8" });
        expect(out.trim().split("\n")).toEqual(["own", "before-after", "refused", "protected-refused"]);
        expect(readFileSync(journal, "utf8")).toBe("before-after");
      } finally {
        own.cleanup();
        other.cleanup();
      }
    },
    60_000,
  );
});

describe("the sandbox private roots in a test process", () => {
  const realAve = join(homedir(), ".ave");

  it("resolve under this run's directory in test-tmp when the test sets no AVE_HOME", () => {
    delete process.env.AVE_HOME;
    const base = process.env.AVE_TEST_SANDBOX_BASE;
    expect(base, "vitest.globalSetup.ts sets the per-run base").toBeDefined();
    expect(base!.startsWith(join(realAve, "test-tmp") + sep)).toBe(true);
    expect(appOwnedSandboxTempRoot()).toBe(join(base!, "tmp"));
    expect(appOwnedSandboxHomeRoot()).toBe(join(base!, "home"));
  });

  it("are refused, not defaulted to the real home, when the per-run directory is missing", () => {
    delete process.env.AVE_HOME;
    const base = process.env.AVE_TEST_SANDBOX_BASE;
    delete process.env.AVE_TEST_SANDBOX_BASE;
    try {
      expect(() => appOwnedSandboxHomeRoot()).toThrow(/needs AVE_TEST_SANDBOX_BASE/);
      expect(() => appOwnedSandboxTempRoot()).toThrow(/needs AVE_TEST_SANDBOX_BASE/);
    } finally {
      process.env.AVE_TEST_SANDBOX_BASE = base;
    }
  });

  it("sweeps a root under test-tmp, which is the tests' own", async () => {
    const root = join(process.env.AVE_TEST_SANDBOX_BASE!, "guard-case");
    mkdirSync(join(root, "stale"), { recursive: true });
    await sweepSandboxPrivateRoot(root, new Set());
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
