// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";
import { admittedWindowsEntry, expandWindowsAclDenyLists, expandWindowsFsPaths, isAdmittedWindowsEntry, rankWindowsFsAccess } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { windowsPathKindHelperIn } from "../../main/windows-path-kind-launcher.js";
import { hashHookCommandFiles } from "../../hooks/hook-config-trust.js";
import { capturePluginSandboxGrant } from "../../plugins/isolation/out-of-process-plugin.js";
import { isHostScriptReadPath } from "../../main/host-script-runtime.js";
import { sanitizeRuntimeAllowedDirectories } from "../../permissions/allowed-directories.js";
import { buildSandboxConfig } from "../../permissions/asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../../permissions/sandbox-write-policy.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { pinWindowsGrantTargets } from "../../permissions/windows-grant-targets.js";
import { admitObligations, ObligationRefusedError } from "../../permissions/admitted-obligation.js";
import { validateSandboxPath } from "../../sandbox/path-validator.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import { collectShellExecutableReadPaths } from "../../tools/shell-executable-read-paths.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";
import { readWindowsReadDenyEvidence, recheckWindowsReadDenyEvidence } from "../windows-read-deny-evidence.js";
import { readWindowsDacls } from "../windows-path-facts.js";
import { windowsSharePath, withLocalityDecision } from "../local-path-io.js";

// The shared setup answers every drive as local; this harness maps one drive to a share.
vi.unmock("../windows-drive-locality.js");

// Every path lookup and every native helper spawn is recorded; a fake link can route a real directory elsewhere. The
// builtins are patched in place and their ESM bindings resynchronized, so the installed sandbox runtime is observed too.
const probes = { calls: [] as string[], native: [] as string[], links: new Map<string, string>(), shareEntries: new Map<string, "dir" | "file">() };
const builtin = createRequire(import.meta.url);
const fsModule = builtin("node:fs") as Record<string, unknown> & typeof import("node:fs");
const childProcess = builtin("node:child_process") as Record<string, unknown>;
const originals: [Record<string, unknown>, string, unknown][] = [];
const replace = (owner: Record<string, unknown>, name: string, value: unknown) => {
  originals.push([owner, name, owner[name]]);
  owner[name] = value;
};
const linkKey = (path: unknown) => String(path).replaceAll("\\", "/").toLowerCase();
const localControlEntries = new Map<string, "dir" | "file">([
  ["m:/", "dir"],
  ["m:/profile", "dir"],
  ["m:/profile/.npmrc", "file"],
  ["m:/grant", "dir"],
]);

function installHarness(): void {
  const wrap = (operation: string, original: (...args: unknown[]) => unknown) => (...args: unknown[]): unknown => {
    probes.calls.push(String(args[0]));
    const key = linkKey(args[0]);
    const target = probes.links.get(key);
    if (target !== undefined && operation === "lstatSync") {
      return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    }
    if (target !== undefined && operation === "readlinkSync") return target;
    const localKind = mapped ? undefined : localControlEntries.get(key);
    if (localKind !== undefined) {
      if (operation === "lstatSync") {
        return { isSymbolicLink: () => false, isDirectory: () => localKind === "dir", isFile: () => localKind === "file" };
      }
      if (operation === "realpathSync" || operation === "realpathSync.native") return String(args[0]);
      if (operation === "existsSync") return true;
    }
    if (key.startsWith(linkKey(UNC))) {
      const kind = probes.shareEntries.get(key);
      if (kind !== undefined && operation === "lstatSync") {
        return { isSymbolicLink: () => false, isDirectory: () => kind === "dir", isFile: () => kind === "file" };
      }
      throw Object.assign(new Error("Unstubbed share lookup"), { code: "EUNSTUBBED" });
    }
    if (unproven(String(args[0]))) throw Object.assign(new Error("Unstubbed synthetic lookup"), { code: "EUNSTUBBED" });
    const result = original(...args);
    if (operation !== "opendirSync") return result;
    // A listing reports a fake link as a link, as it would a real one.
    const directory = result as import("node:fs").Dir;
    const readSync = directory.readSync.bind(directory);
    return Object.assign(directory, { readSync: () => {
      const entry = readSync();
      if (entry === null || !probes.links.has(linkKey(`${String(args[0])}\\${entry.name}`))) return entry;
      return Object.assign(Object.create(entry) as object, { isDirectory: () => false, isSymbolicLink: () => true });
    } });
  };
  for (const name of ["lstatSync", "statSync", "readlinkSync", "existsSync", "readdirSync", "openSync", "opendirSync", "accessSync", "readFileSync"]) {
    replace(fsModule, name, wrap(name, fsModule[name] as never));
  }
  const realpath = fsModule.realpathSync;
  replace(fsModule, "realpathSync", Object.assign(wrap("realpathSync", realpath as never), { native: wrap("realpathSync.native", realpath.native as never) }));
  const promises = fsModule.promises as unknown as Record<string, unknown>;
  for (const name of ["lstat", "stat", "readlink", "readdir", "open", "opendir", "access", "readFile", "realpath"]) {
    const original = promises[name] as (...args: unknown[]) => Promise<unknown>;
    replace(promises, name, async (...args: unknown[]) => {
      const path = String(args[0]);
      probes.calls.push(path);
      if (unproven(path)) throw Object.assign(new Error("Unstubbed synthetic lookup"), { code: "EUNSTUBBED" });
      return original(...args);
    });
  }
  // A spawn naming a harness spelling is recorded and refused; host helpers on local paths run as usual.
  for (const name of ["execFileSync", "spawnSync", "spawn", "execFile"]) {
    const original = childProcess[name] as (...args: unknown[]) => unknown;
    replace(childProcess, name, (...args: unknown[]) => {
      const input = (args[2] as { input?: unknown } | undefined)?.input;
      const line = `${name} ${JSON.stringify(args.slice(0, 2))} ${Buffer.isBuffer(input) ? input.toString("utf8") : ""}`;
      probes.native.push(line);
      if (nativeContainsUnproven(line)) throw Object.assign(new Error("Unstubbed synthetic native lookup"), { code: "EUNSTUBBED" });
      return original(...args);
    });
  }
  syncBuiltinESMExports();
}

function removeHarness(): void {
  for (const [owner, name, value] of originals.reverse()) owner[name] = value;
  originals.length = 0;
  syncBuiltinESMExports();
}

const SHARE = String.raw`\Device\Mup\;LanmanRedirector\;M:0000000000012345\files.example\share`;
const MAPPED = "M:\\";
const UNC = "\\\\fixture-server\\fixture-share";
let mapped = true;
const unproven = (spelling: string) => {
  const folded = spelling.replaceAll("/", "\\").toLowerCase().replace(/^\\\\\?\\(?:unc\\)?/u, "");
  return folded.startsWith("m:") || /^(?:\\\\)?(?:fixture-server|files\.example)\\/u.test(folded)
    || /globalroot|\\device\\|volume\{/u.test(folded);
};
const fsOnUnproven = () => probes.calls.filter(unproven);
const nativeContainsUnproven = (line: string) => /m:|fixture-server|files\.example/iu.test(line);
const nativeOnUnproven = () => probes.native.filter(nativeContainsUnproven);

describe.runIf(process.platform === "win32")("no decision path looks up a spelling before it is proven local", () => {
  let root: string;
  let cwd: string;

  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    installHarness();
  });

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "spy-boundary-")));
    cwd = join(root, "work");
    mkdirSync(cwd);
    mapped = true;
    setWindowsDriveQueryForTest(drive => drive.toUpperCase() === "M:" && mapped ? SHARE : String.raw`\Device\HarddiskVolume1`);
    probes.calls.length = 0;
    probes.native.length = 0;
    probes.shareEntries.clear();
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    probes.links.clear();
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    setWindowsDriveQueryForTest();
    removeHarness();
  });

  it("observes the installed sandbox runtime's own lookups", () => {
    const canary = join(root, "canary");
    mkdirSync(canary);
    probes.calls.length = 0;
    expandWindowsFsPaths([`${canary}\\*`]);
    expect(probes.calls.some(path => linkKey(path).startsWith(linkKey(canary)))).toBe(true);
  });

  it("hands admitted rows to the sandbox runtime, which takes them verbatim after a config clone", () => {
    const present = join(root, "present");
    mkdirSync(present);
    const absent = `${join(root, "absent")}\\`;
    // A cloned config keeps the admission; the runtime neither stats, resolves nor walks these rows.
    const [dir, missing] = structuredClone([
      admittedWindowsEntry(present, { kind: "dir", volumeSerial: "1", fileId: "2" }),
      admittedWindowsEntry(absent, { kind: "missing" }),
    ]);
    expect(isAdmittedWindowsEntry(dir) && isAdmittedWindowsEntry(missing)).toBe(true);
    probes.calls.length = 0;
    const lists = expandWindowsAclDenyLists([dir as FilesystemPathEntry], [missing as FilesystemPathEntry]);
    const ranked = rankWindowsFsAccess({ allowRead: [present], allowWrite: [], ...lists });
    expect(ranked).toMatchObject({ denyRead: [present], denyWrite: [absent] });
    expect(probes.calls).toEqual([]);
    // A control: the same paths as plain literals are looked up, and expand to the same rows.
    const plain = expandWindowsAclDenyLists([{ path: present, literal: true }], [{ path: absent, literal: true }]);
    expect(probes.calls.length).toBeGreaterThan(0);
    expect([plain.denyRead, plain.denyWrite]).toEqual([lists.denyRead, lists.denyWrite]);
    for (const refused of ["\\\\fixture-server\\fixture-share\\x", `${present}\\*`, "relative\\x"]) {
      expect(() => admittedWindowsEntry(refused, { kind: "file" })).toThrow(expect.objectContaining({ code: "unadmitted_fs_entry" }));
    }
  });

  it("brands every admitted deny row the config builder hands to the runtime", () => {
    const denied = join(root, "denied");
    mkdirSync(denied);
    const next = buildSandboxConfig({ denyRead: [denied], denyWrite: [denied] });
    const rows = [...next.filesystem.denyRead, ...next.filesystem.denyWrite].filter(entry => linkKey(typeof entry === "string" ? entry : entry.path).startsWith(linkKey(denied)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entry => isAdmittedWindowsEntry(entry))).toBe(true);
  });

  const admitDeny = (row: string) => admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox",
    rows: [{ spelling: row, polarity: { effect: "deny", access: "read" }, source: "settings" }] });

  // Each case runs the entry point on an unproven spelling and expects no lookup of it; its control proves the harness
  // sees the lookups the entry point makes once the same spelling is proven local.
  const cases: { name: string; run: (target: string) => unknown; target: () => string; native?: boolean }[] = [
    { name: "sandbox path validation", target: () => `${MAPPED}work\\file.txt`, run: target => validateSandboxPath(target, cwd) },
    {
      name: "executable read paths",
      target: () => `${MAPPED}bin`,
      run: target => collectShellExecutableReadPaths("probe", cwd, {
        dialect: "bash", environment: { PATH: target, HOME: root, PWD: cwd }, prefixAssignmentRhs: "incoming",
      }),
    },
    { name: "host script reads", target: () => `${MAPPED}runtime\\node.exe`, run: target => isHostScriptReadPath(target) },
    { name: "runtime allowed directories", target: () => `${MAPPED}project`, run: target => sanitizeRuntimeAllowedDirectories([target]) },
    { name: "Windows deny admission", target: () => `${MAPPED}secret`, run: target => admitDeny(target) },
    { name: "Windows deny glob admission", target: () => `${MAPPED}secret\\*.key`, run: target => admitDeny(target) },
    {
      name: "nested Git discovery under a write root",
      target: () => `${MAPPED}repo`,
      run: target => {
        const nested = join(root, "nested");
        mkdirSync(nested, { recursive: true });
        probes.links.set(nested.replaceAll("\\", "/").toLowerCase(), target);
        return buildMandatorySandboxWritePolicy([root]);
      },
    },
    { name: "read-deny evidence", target: () => `${MAPPED}profile\\.npmrc`, run: target => readWindowsReadDenyEvidence([target]), native: true },
    { name: "read-deny evidence recheck", target: () => `${MAPPED}profile\\.npmrc`, run: target => recheckWindowsReadDenyEvidence([target]) },
    {
      name: "grant target pins",
      target: () => `${MAPPED}grant`,
      run: target => pinWindowsGrantTargets([target], { allowMissing: true, validatePath: () => undefined }),
      native: true,
    },
  ];

  it.each(cases)("$name makes no lookup of a mapped-drive spelling", async ({ run, target }) => {
    try { await run(target()); } catch { /* A refusal is the expected outcome for several entry points. */ }
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it.each(cases)("$name is seen by the harness once the drive is local (control)", async ({ run, target, native }) => {
    mapped = false;
    try { await run(target()); } catch { /* Some controls deliberately stop after recording a lookup. */ }
    expect(native ? nativeOnUnproven() : fsOnUnproven()).not.toEqual([]);
  });

  it("refuses confinement for a share or mapped deny row instead of handing it to the sandbox runtime", () => {
    const local = join(root, "secret");
    writeFileSync(local, "x");
    expect(buildSandboxConfig({ denyRead: [local] }).filesystem.denyRead).toContainEqual(expect.objectContaining({ path: local }));
    for (const row of [`${MAPPED}secret`, `${UNC}\\secret`]) {
      expect(() => buildSandboxConfig({ denyRead: [row, local] })).toThrow(ObligationRefusedError);
    }
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("validates a UNC spelling by its text alone", () => {
    expect(validateSandboxPath(`${UNC}\\file.txt`, cwd).allowed).toBe(false);
    expect(fsOnUnproven()).toEqual([]);
  });

  it("ranks a local MXC grant and refuses an unresolved deny", () => {
    const policy = { allowRead: [], allowWrite: [cwd], denyWrite: [], protectedFloor: [] };
    expect(rankAdmittedMxcLists({ ...policy, denyRead: [] }).readwrite).toEqual([cwd]);
    expect(() => rankAdmittedMxcLists({ ...policy, denyRead: [`${MAPPED}secret`] })).toThrow(ObligationRefusedError);
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("admits a local hook file and refuses to look up a mapped operand", () => {
    const script = join(cwd, "script.ps1");
    writeFileSync(script, "exit 0");
    expect(hashHookCommandFiles([script], cwd)).toMatchObject({ files: [script], errors: [] });
    const refused = hashHookCommandFiles([script, `${MAPPED}work\\file.txt`], cwd);
    expect(refused.errors).toContain("file operand 1 cannot be resolved or read");
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("captures a local plugin grant and refuses a mapped grant before lookup", () => {
    expect(capturePluginSandboxGrant({ path: cwd, access: "read" })).toMatchObject({ path: cwd, identity: expect.any(Object) });
    expect(() => capturePluginSandboxGrant({ path: `${MAPPED}work`, access: "read" })).toThrow(/cannot be admitted/i);
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  // A directory beneath the fixture root that the walk reads as a link to the mapped drive.
  const linkTo = (name: string, target: string): string => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    probes.links.set(path.replaceAll("\\", "/").toLowerCase(), target);
    return path;
  };

  it("does not derive share authority from a local workspace link", () => {
    const routed = linkTo("workspace-link", `${UNC}\\workspace`);
    expect(validateSandboxPath(join(routed, "file.txt"), routed).allowed).toBe(false);
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("walks a registered share grant and refuses a link leaving it", () => {
    const grant = `${UNC}\\work`;
    const file = `${grant}\\file.txt`;
    probes.shareEntries.set(linkKey(grant), "dir");
    probes.shareEntries.set(linkKey(file), "file");
    expect(validateSandboxPath(file, cwd, [grant]).allowed).toBe(true);
    const link = `${grant}\\link.txt`;
    const elsewhere = `${UNC}\\other\\file.txt`;
    probes.links.set(linkKey(link), elsewhere);
    expect(validateSandboxPath(link, cwd, [grant]).allowed).toBe(false);
    expect(probes.calls.map(linkKey)).not.toContain(linkKey(elsewhere));
  });

  it("keeps the mounted subdirectory as the root of a mapped share", () => {
    setWindowsDriveQueryForTest(() => String.raw`\Device\Mup\fixture-server\fixture-share\mounted`);
    expect(withLocalityDecision(() => windowsSharePath("M:\\..\\file.txt")))
      .toBe(String.raw`\\fixture-server\fixture-share\mounted\file.txt`);
    expect(probes.calls).toEqual([]);
    expect(probes.native).toEqual([]);
  });

  it("rejects a preview outside lexical scope before resolving the file", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    expect(assertReadableFilePath(outside, cwd, [])).toEqual({ ok: false, error: "path-not-allowed" });
    expect(probes.calls.map(linkKey)).not.toContain(linkKey(outside));
    expect(assertReadableFilePath(`${MAPPED}work\\file.txt`, cwd, [])).toEqual({ ok: false, error: "path-not-allowed" });
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
    const local = join(cwd, "inside.txt");
    writeFileSync(local, "inside");
    expect(assertReadableFilePath(local, cwd, [])).toEqual({ ok: true, resolved: local });
    expect(probes.calls.map(linkKey)).toContain(linkKey(local));
  });
  const denyRows = (config: ReturnType<typeof buildSandboxConfig>) =>
    config.filesystem.denyRead.map(entry => typeof entry === "string" ? entry : entry.path);

  it("refuses confinement, rather than withholding grants, around a deny row routed to a mapped drive", () => {
    const grants = (config: ReturnType<typeof buildSandboxConfig>) =>
      (config.filesystem.allowRead ?? []).map(entry => typeof entry === "string" ? entry : entry.path);
    const local = join(root, "kept");
    mkdirSync(local);
    expect(grants(buildSandboxConfig({ allowRead: [root], denyRead: [join(local, "secret")] }))).toContain(root);
    const row = join(linkTo("routed", `${MAPPED}share`), "secret");
    expect(() => buildSandboxConfig({ allowRead: [root], denyRead: [row] })).toThrow(expect.objectContaining({
      code: "sandbox-obligation-unenforceable", rows: [{ row, reason: "link-to-remote" }] }));
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("proves a pattern's base under the literal reading of its brackets", () => {
    linkTo("[ab]", `${MAPPED}share`);
    const row = join(root, "[ab]", "*.key");
    // Under both readings the deny covers its static base, so the routed directory is never looked up.
    expect(denyRows(buildSandboxConfig({ denyRead: [row] }))).toContain(root);
    expect(fsOnUnproven()).toEqual([]);
  });

  it("follows no matched link of a pattern to a mapped drive", () => {
    linkTo("junction", `${MAPPED}share`);
    const row = join(root, "*", "secret");
    expect(denyRows(buildSandboxConfig({ denyRead: [row] }))).toContain(root);
    expect(fsOnUnproven()).toEqual([]);
  });

  it("probes no base of a UNC pattern", () => {
    const row = `${UNC}\\*.key`;
    expect(() => buildSandboxConfig({ denyRead: [row] })).toThrow(ObligationRefusedError);
    expect(fsOnUnproven()).toEqual([]);
    expect(nativeOnUnproven()).toEqual([]);
  });

  it("revokes a write root whose nested entry routes to a mapped drive", () => {
    linkTo("nested", `${MAPPED}repo`);
    const policy = buildMandatorySandboxWritePolicy([root]);
    expect(policy.allowWrite).not.toContain(root);
    expect(policy.narrowedWriteRoots).toContainEqual({ root, reason: "filesystem-access" });
  });
});

const FIXTURE_VOLUME = "W:\\";
const FIXTURE_WORK = win32.join(FIXTURE_VOLUME, "work");
const FIXTURE_FILE = win32.join(FIXTURE_WORK, "script.ps1");
const FIXTURE_LINK = win32.join(FIXTURE_WORK, "share-link");
const FIXTURE_SID = "S-1-5-21-100-200-300-1001";

function withStubbedWindowsLookups(run: (calls: {
  fs: { operation: string; path: string }[];
  native: { executable: string; args: string[]; input: Buffer | undefined; paths: string[] }[];
}) => void): void {
  const resources = resolve("resources");
  configureHostResources({ resourcePath: resources, isPackaged: false });
  const helper = windowsPathKindHelperIn(resources);
  const provided: [string, { kind: "dir" | "file" | "link"; contents?: string; target?: string }][] = [
    [FIXTURE_VOLUME, { kind: "dir" }],
    [FIXTURE_WORK, { kind: "dir" }],
    [FIXTURE_FILE, { kind: "file", contents: "Write-Output fixture" }],
    [FIXTURE_LINK, { kind: "link", target: MAPPED }],
    [helper, { kind: "file" }],
  ];
  const entries = new Map(provided.map(([path, entry], index) =>
    [linkKey(path), { ...entry, path, id: `0x${(index + 1).toString(16).padStart(32, "0")}` }]));
  const calls: Parameters<typeof run>[0] = { fs: [], native: [] };
  const unstubbed = (operation: string, path: string): never => {
    throw Object.assign(new Error(`Unstubbed ${operation}: ${path}`), { code: "EUNSTUBBED" });
  };
  const lookup = (operation: string, path: string) => entries.get(linkKey(win32.normalize(path))) ?? unstubbed(operation, path);
  const fsCall = (operation: string, path: string): unknown => {
    calls.fs.push({ operation, path });
    const entry = lookup(operation, path);
    switch (operation) {
      case "lstat": case "lstatSync":
        return { isDirectory: () => entry.kind === "dir", isSymbolicLink: () => entry.kind === "link", isFile: () => entry.kind === "file" };
      case "realpath": case "realpathSync": case "realpathSync.native":
        if (entry.kind !== "link") return entry.path;
        break;
      case "readlink": case "readlinkSync":
        if (entry.target !== undefined) return entry.target;
        break;
      case "existsSync":
        return true;
      case "readFile": case "readFileSync":
        if (entry.contents !== undefined) return Buffer.from(entry.contents);
        break;
    }
    return unstubbed(operation, path);
  };
  const component = (path: string) => {
    const entry = lookup("native path", path);
    if (entry.kind === "link") return unstubbed("native link path", path);
    const volume = "0x0000000000000001";
    const directory = entry.kind === "dir";
    return { exists: true, canonical: entry.path, directory, attributes: directory ? 16 : 0, volumeSerial: volume,
      volumeSerialNumber: volume, fileId: entry.id, fileIndex: volume, changeTime: volume,
      fileSystemName: "NTFS", reparseTag: 0, reparseTarget: null };
  };
  const descriptor = (entry: ReturnType<typeof component>) => ({
    identity: { volumeSerial: entry.volumeSerial, fileId: entry.fileId },
    owner: FIXTURE_SID, protected: true, nullDacl: false, aces: [],
  });
  const recordSpawn = (operation: string, executable: string, argv: unknown, opts?: { input?: unknown }) => {
    const input = Buffer.isBuffer(opts?.input) ? Buffer.from(opts.input) : undefined;
    const args: string[] = Array.isArray(argv) && argv.every(arg => typeof arg === "string") ? [...argv] : [];
    const request = { executable, args, input, paths: [] as string[] };
    calls.native.push(request);
    if (operation !== "execFileSync" || linkKey(executable) !== linkKey(helper)) return unstubbed(operation, executable);
    const [mode, ...operands] = args;
    const dacl = mode === "--dacl" && operands.join(" ") === "--parent --stdin" && input !== undefined;
    if (mode === "--pin" && input === undefined && operands.length > 0) request.paths.push(...operands);
    else if (dacl) {
      let offset = 8;
      if (input.length < 8 || input.readUInt32LE(0) !== input.length - 4) return unstubbed("native frame", executable);
      for (let i = 0, count = input.readUInt32LE(4); i < count; i++) {
        if (offset + 4 > input.length) return unstubbed("native frame", executable);
        const length = input.readUInt32LE(offset);
        offset += 4;
        request.paths.push(input.toString("utf8", offset, offset + length));
        offset += length;
      }
      if (offset !== input.length) return unstubbed("native frame", executable);
    } else return unstubbed("native request", executable);
    return Buffer.from(JSON.stringify(request.paths.map(path => {
      const row = component(path);
      const ancestors: ReturnType<typeof component>[] = [];
      for (let parent = win32.dirname(path); parent !== path; parent = win32.dirname(parent)) {
        ancestors.unshift(component(parent));
        if (parent === win32.dirname(parent)) break;
      }
      const base = { ...row, ancestors };
      if (!dacl) return base;
      const parent = ancestors.at(-1);
      return {
        ...base, ...descriptor(row), requestPath: path, currentUserSid: FIXTURE_SID, elevated: false,
        principals: {}, parent: parent === undefined ? null : descriptor(parent),
      };
    })));
  };
  try {
    for (const name of ["lstatSync", "statSync", "readlinkSync", "existsSync", "readdirSync", "openSync", "opendirSync", "accessSync", "readFileSync"]) {
      replace(fsModule, name, (path: string) => fsCall(name, path));
    }
    replace(fsModule, "realpathSync", Object.assign(
      (path: string) => fsCall("realpathSync", path),
      { native: (path: string) => fsCall("realpathSync.native", path) },
    ));
    for (const name of ["lstat", "stat", "readlink", "readdir", "open", "opendir", "access", "readFile", "realpath"]) {
      replace(fsModule.promises as unknown as Record<string, unknown>, name, async (path: string) => fsCall(name, path));
    }
    for (const name of ["execFileSync", "spawnSync", "spawn", "execFile"]) {
      replace(childProcess, name, (executable: string, args: unknown, opts?: { input?: unknown }) => recordSpawn(name, executable, args, opts));
    }
    syncBuiltinESMExports();
    setWindowsDriveQueryForTest(drive => {
      switch (drive) {
        case "W:": return String.raw`\Device\HarddiskVolume1`;
        case "M:": return SHARE;
        case "S:": return String.raw`\??\W:\work`;
        default: return null;
      }
    });
    run(calls);
  } finally {
    setWindowsDriveQueryForTest();
    removeHarness();
  }
}

describe.runIf(process.platform === "win32")("Windows admission with exact filesystem and helper replies", () => {
  const inspect = (path: string) => admitObligations({ purpose: "preview", principal: "host-lookup",
    rows: [{ spelling: { path, literal: true }, polarity: { effect: "allow", access: "lookup" }, source: "command-operand" }] });

  it("fails an unstubbed filesystem operation without using the host filesystem", () => {
    withStubbedWindowsLookups(calls => {
      const path = win32.join(FIXTURE_WORK, "unknown.txt");
      expect(() => fsModule.lstatSync(path)).toThrow(expect.objectContaining({ code: "EUNSTUBBED" }));
      expect(() => (childProcess.execFileSync as typeof import("node:child_process").execFileSync)(
        windowsPathKindHelperIn(resolve("resources")), ["--pin", path],
      )).toThrow(expect.objectContaining({ code: "EUNSTUBBED" }));
      expect(calls.fs).toEqual([{ operation: "lstatSync", path }]);
      expect(calls.native.map(row => row.paths)).toEqual([[path]]);
    });
  });

  it("admits a provided local file and captures both argv and framed native operands", () => {
    withStubbedWindowsLookups(calls => {
      expect(inspect(FIXTURE_FILE).admitted).toMatchObject([{ target: FIXTURE_FILE, kind: "file" }]);
      expect(calls.fs).toContainEqual({ operation: "lstatSync", path: FIXTURE_FILE });
      expect(calls.native).toMatchObject([{ args: ["--pin", FIXTURE_FILE], paths: [FIXTURE_FILE] }]);
      expect(readWindowsDacls([FIXTURE_FILE], { parent: true })).toMatchObject([{ canonical: FIXTURE_FILE }]);
      expect(calls.native[1]).toMatchObject({
        args: ["--dacl", "--parent", "--stdin"], paths: [FIXTURE_FILE], input: expect.any(Buffer),
      });
    });
  });

  it.each([
    [`${MAPPED}file.txt`, "mapped-drive"],
    ["S:\\file.txt", "subst"],
    ["Q:\\file.txt", "device"],
    ["W:file.txt", "drive-relative"],
    ["\\file.txt", "unbound-rooted"],
    ["relative\\file.txt", "relative"],
    [`${UNC}\\file.txt`, "share"],
    ["\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.txt", "device"],
    ["\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\file.txt", "device"],
    ["W:\\work\\file.txt:alternate", "device"],
  ])("refuses %s before any file or native operation", (path, reason) => {
    withStubbedWindowsLookups(calls => {
      expect(inspect(path)).toMatchObject({ admitted: [], unresolved: [{ reason }] });
      expect(calls).toEqual({ fs: [], native: [] });
    });
  });

  it("reads only the local entry of a link that reaches a refused drive", () => {
    withStubbedWindowsLookups(calls => {
      expect(inspect(win32.join(FIXTURE_LINK, "file.txt")))
        .toMatchObject({ admitted: [], unresolved: [{ reason: "link-to-remote" }] });
      expect(calls.fs).toContainEqual({ operation: "readlinkSync", path: FIXTURE_LINK });
      expect(calls.fs.filter(({ path }) => unproven(path))).toEqual([]);
      expect(calls.native).toEqual([]);
    });
  });
});
