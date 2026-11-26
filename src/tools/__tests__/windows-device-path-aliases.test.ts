import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";
configureTestOwner();
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { decidePermission, type PermissionDecisionRequest } from "../../permissions/decision-pipeline.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createSensitivePathCheck } from "../../permissions/sensitive-paths.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest } from "../../permissions/sandbox-capability.js";
import { __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import type { ExecutionMode } from "../../shared/permission-mode.js";
import { ToolExecutor } from "../executor.js";
import { EditFileTool, GlobFilesTool, GrepFilesTool, ListFilesTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";

vi.unmock("../../shared/windows-drive-locality.js");

// The filesystem boundary: a share, device or NT-prefixed spelling, and drive R:, which a share backs, are never opened
// (the call is recorded and fails; an extended or device path to another drive is local and passes). Links, and lookups
// that answer with a share, are modelled here, so no case depends on a live share or on the right to create links.
const boundary = vi.hoisted(() => ({ network: [] as string[], links: new Map<string, string>(), physical: new Map<string, string>() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const key = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const wrap = <T extends (...args: never[]) => unknown>(operation: string, original: T) => (...args: Parameters<T>): unknown => {
    let path = String(args[0]);
    const physical = boundary.physical.get(key(path));
    if (physical !== undefined && operation.startsWith("realpathSync")) return physical;
    for (const [link, target] of boundary.links) {
      const at = key(path);
      if (at === link && operation === "lstatSync") return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      if (at === link && operation === "readlinkSync") return target;
      if (at === link || at.startsWith(`${link}/`)) { path = target + path.slice(link.length); break; }
    }
    const localDrive = /^\\\\[?.]\\[a-z]:(?:\\|$)/iu.test(path) && !/\/|[. ](?:\\|$)/u.test(path.slice(4));
    if (/^(?:[\\/]{2}[?.][\\/])?r:/iu.test(path) || !localDrive && /^[\\/]{2}|^[\\/]\?\?[\\/]/u.test(path)) {
      boundary.network.push(`${operation} ${path}`);
      if (operation === "existsSync") return false;
      throw Object.assign(new Error("Network or device path intercepted"), { code: "ENOENT" });
    }
    return original(...[path, ...args.slice(1)] as Parameters<T>);
  };
  return {
    ...actual,
    realpathSync: Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) }),
    lstatSync: wrap("lstatSync", actual.lstatSync), statSync: wrap("statSync", actual.statSync),
    readlinkSync: wrap("readlinkSync", actual.readlinkSync), existsSync: wrap("existsSync", actual.existsSync),
    accessSync: wrap("accessSync", actual.accessSync), readdirSync: wrap("readdirSync", actual.readdirSync),
    openSync: wrap("openSync", actual.openSync), readFileSync: wrap("readFileSync", actual.readFileSync),
  };
});

// Device and loopback-share spellings of a local file get the drive path's evidence and opaque evidence together; spellings
// that cannot be proven to name a local drive get opaque evidence. Tool execution is stubbed: cases assert decisions.
const SENTINEL = "DEVICE_ALIAS_SENTINEL";
type Mode = ExecutionMode | "headless";
const MODES: readonly Mode[] = ["strict", "default", "auto", "allow", "headless"];
type Spelling = (plain: string) => string;
const share = (host: string): Spelling => plain => `\\\\${host}\\${plain[0]}$\\${plain.slice(3)}`;
const FORWARD_CASE: Spelling = plain => `//LocalHost/${plain.slice(0, 1).toLowerCase()}$/${plain.slice(3).replaceAll("\\", "/")}`;
const GLOBALROOT: Spelling = plain => `\\\\?\\GLOBALROOT\\??\\${plain}`;
const ALIASES: ReadonlyArray<[string, Spelling]> = [
  ["\\\\.\\X:", plain => `\\\\.\\${plain}`],
  ["\\\\localhost\\X$", share("localhost")],
  ["\\\\127.0.0.1\\X$", share("127.0.0.1")],
  ["\\\\?\\UNC\\localhost\\X$", share("?\\UNC\\localhost")],
  ["\\\\.\\UNC\\localhost\\X$", share(".\\UNC\\localhost")],
  ["//LocalHost/x$ (case, slashes)", FORWARD_CASE],
  ["\\\\<own host name>\\X$", plain => share(hostname())(plain)],
];
const UNPROVEN: ReadonlyArray<[string, Spelling]> = [
  ["\\\\?\\GLOBALROOT\\??\\X:", GLOBALROOT],
  ["\\\\?\\Volume{GUID}", plain => `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${plain.slice(3)}`],
  ["\\\\.\\X: with a trailing dot", plain => `\\\\.\\${plain}.`],
];
const NT_PREFIX: Spelling = plain => `\\??\\${plain}`;
const EXTENDED_SLASH: Spelling = plain => `\\\\?\\${plain.slice(0, 3)}${plain.slice(3).replaceAll("\\", "/")}`;
const WORKSPACE = "\\\\files.example\\share\\proj";
// Drive R: is mapped to a share; every other drive is a local volume.
const REMOTE_DRIVE = "R:";
const REMOTE_MAPPING = "\\Device\\Mup\\;LanmanRedirector\\;R:0000000000012345\\files.example\\share";

let root: string;
let project: string;
let home: string;
let settings: string;
let gitConfig: string;
let audit: AuditLogger;
let cache: VerdictCache;
let registry: ToolRegistry;
const key = (path: string) => path.replaceAll("\\", "/").toLowerCase();

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "device-alias-")));
  project = join(root, "project");
  home = join(root, "ave-home");
  settings = join(home, "config", "settings.json");
  gitConfig = join(project, ".git", "config");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(root, "hop"), { recursive: true });
  await writeFile(gitConfig, "[core]\n");
  await writeFile(settings, `{"fixture":"${SENTINEL}"}\n`);
  vi.stubEnv("AVE_HOME", home);
  setWindowsDriveQueryForTest(drive => drive === REMOTE_DRIVE ? REMOTE_MAPPING : "\\Device\\HarddiskVolume1");
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  audit = new AuditLogger(join(root, "audit"));
  cache = new VerdictCache(join(root, "review-cache.jsonl"));
  registry = new ToolRegistry();
  for (const tool of [new ReadFileTool(), new ListFilesTool(), new GlobFilesTool(), new GrepFilesTool(), new WriteFileTool(), new EditFileTool()]) registry.register(tool);
});
// Each case drains its own audit rows, so the backlog never builds up across the whole matrix.
afterEach(() => audit.flush());
afterAll(async () => {
  await cache.flush();
  await audit.close();
  vi.unstubAllEnvs();
  setWindowsDriveQueryForTest();
  await rm(root, { recursive: true, force: true });
});

type Checked = { decision?: string; reasonCode?: string; pipelineRequest?: { secretRead?: boolean; floor?: { code?: string }; pathFacts?: { secretPattern?: string; protectedEntry?: string } } };
function outcome(checked: Checked | undefined) {
  return {
    decision: `${checked?.decision}/${checked?.reasonCode}`, secretRead: checked?.pipelineRequest?.secretRead === true,
    floor: checked?.pipelineRequest?.floor?.code, secretPattern: checked?.pipelineRequest?.pathFacts?.secretPattern,
    protectedEntry: checked?.pipelineRequest?.pathFacts?.protectedEntry,
  };
}

function managerFor(mode: Mode): PermissionManager {
  const manager = new PermissionManager(join(root, `perm-${randomUUID()}.json`));
  manager.setMode(mode === "headless" ? "strict" : mode);
  expect(manager.getMode()).toBe(mode === "headless" ? "strict" : mode);
  if (mode === "auto") {
    setReviewerForTest(manager, {
      classifier: { classify: () => ({ level: "high", reason: "A human decides this target" }) },
      cache, recentlyDenied: makeRecentlyDeniedStore(join(root, `denied-${randomUUID()}.json`)),
    });
    expect(manager.getVerdictCache()).toBe(cache);
  }
  return manager;
}

async function runTool(mode: Mode, name: string, input: Record<string, unknown>, cwd = project, fenceReads = false, additionalDirectories: string[] = []) {
  const manager = managerFor(mode);
  manager.setBlockReadsOutsideWorkingDirectories(fenceReads);
  const gate = { requestAndWait: async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "deny-once" }) };
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate as never, undefined, audit);
  const tool = registry.findByName(name);
  if (tool === undefined) throw new Error(`unregistered tool ${name}`);
  const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "stubbed", isError: false });
  const check = vi.spyOn(manager, "checkDetailed");
  boundary.network.length = 0;
  try {
    const [result] = await executor.executeAll([{ id: randomUUID(), name, input }], {
      sessionId: randomUUID(), executionCwd: cwd,
      permissionContext: { trustOrigin: "user-keyboard", additionalDirectories, ...(mode === "headless" ? { headless: true } : {}) },
    } as never);
    const checked = check.mock.results.at(-1)?.value as Checked | undefined;
    return { ...outcome(checked), checked: checked !== undefined, executed: execute.mock.calls.length > 0, content: String(result?.content ?? ""), network: [...boundary.network] };
  } finally {
    execute.mockRestore();
    check.mockRestore();
  }
}

function shellChecked(dialect: "powershell" | "bash", command: string, runsSandboxed: boolean, headless: boolean, cwd: string, manager: PermissionManager) {
  boundary.network.length = 0;
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed, environmentSnapshot: {} },
    ...(headless ? { headless: true } : {}),
  }) as Checked;
}

function shellCheck(mode: Mode, dialect: "powershell" | "bash", command: string, runsSandboxed = false, headless = mode === "headless", cwd = project, manager = managerFor(mode)) {
  return { ...outcome(shellChecked(dialect, command, runsSandboxed, headless, cwd, manager)), network: [...boundary.network] };
}

const byMode = (ask: string, allow = ask): Record<Mode, string> =>
  ({ strict: ask, default: ask, auto: ask, allow, headless: "deny/no-approver" });
const SECRET_READ: Record<Mode, string> = { ...byMode("ask/secret-read", "allow/allow-mode"), auto: "ask/review-required" };
const ORDINARY_READ = "allow/ordinary-read";
const PROTECTED_WRITE = byMode("ask/protected-path");
// A one-shot human floor: no mode, reviewer or allow rule passes it, and without an approver it is a deny.
const PROJECT_ESCAPE = byMode("ask/project-escape");
const allowed = (decision: string) => decision.startsWith("allow/");
// Native tools refuse a credential store before the decision pipeline; shells carry the same denial as admission.
const admission = (row: { decision: string; checked?: boolean; content?: string }) =>
  row.decision === "deny/credential-store" || (row.checked === false && /\(rule: sensitive-paths\//u.test(row.content ?? "")) ? "credential-store" : row.decision;
type Kind = "plain" | "alias" | "unproven";
const SPELLINGS: ReadonlyArray<[string, Kind, Spelling]> = [
  ["plain", "plain", plain => plain],
  ...ALIASES.map(([label, spell]) => [label, "alias", spell] as [string, Kind, Spelling]),
  ...UNPROVEN.map(([label, spell]) => [label, "unproven", spell] as [string, Kind, Spelling]),
];
const CASES = MODES.flatMap(mode => SPELLINGS.map(([label, kind, spell]) => ({ mode, label, kind, spell })));
const shellRead = (dialect: "powershell" | "bash", path: string) =>
  dialect === "powershell" ? `Get-Content -LiteralPath '${path}'` : `cat '${path}'`;
const shellWrite = (dialect: "powershell" | "bash", path: string) =>
  dialect === "powershell" ? `Set-Content -LiteralPath '${path}' x` : `printf x > '${path}'`;

describe.runIf(process.platform === "win32")("Windows device and share aliases of local paths", () => {
  it.each(CASES)("$mode: $label ($kind)", async ({ mode, kind, spell }) => {
    const secretPattern = kind === "unproven" ? "network-or-device-path" : "ave-home:config";
    const homeEntry = kind === "unproven" ? "network-or-device-path" : "application-home";
    const config = join(home, "config");

    // Native reads of the secret, and listings whose root is its folder: an alias gets the drive path's decision and reason;
    // a spelling that names no local drive needs a person in every mode.
    const read = kind === "unproven" ? PROJECT_ESCAPE : SECRET_READ;
    for (const [name, input] of [
      ["read_file", { path: spell(settings) }],
      ["list_files", { path: spell(config) }],
      ["glob_files", { pattern: "*", path: spell(config) }],
      ["grep_files", { pattern: SENTINEL, path: spell(config) }],
      ["grep_files", { pattern: SENTINEL, path: spell(settings) }],
    ] as const) {
      expect({ name, ...await runTool(mode, name, input) }).toMatchObject({
        name, decision: read[mode], secretRead: true, secretPattern, executed: allowed(read[mode]), network: [],
        ...kind === "unproven" ? { floor: "project-escape" } : {},
      });
    }

    // Native writes to the application home and a protected control path. A device or share write target is refused
    // before any approval, as it is on main.
    for (const [target, entry] of [[settings, "application-home"], [gitConfig, ".git"]] as const) {
      const before = readFileSync(target, "utf8");
      for (const [name, input] of [
        ["write_file", { path: spell(target), content: "overwritten" }],
        ["edit_file", { path: spell(target), oldText: before.slice(0, 3), newText: "xyz" }],
      ] as const) {
        expect({ name, entry, ...await runTool(mode, name, input) }).toMatchObject({ name, entry, network: [], ...kind === "plain"
          ? { decision: PROTECTED_WRITE[mode], floor: "protected-path", protectedEntry: entry, executed: false }
          : { checked: false, executed: false, content: "Cannot resolve write target" } });
      }
    }

    // Shell operands. PowerShell judges an alias read as the drive path and sends a spelling that names no local drive to
    // the project-escape floor; bash sends every share or device operand there, with the same secret evidence.
    expect(shellCheck(mode, "powershell", shellRead("powershell", spell(settings)))).toMatchObject({
      decision: read[mode], secretRead: true, secretPattern, network: [], ...kind === "unproven" ? { floor: "project-escape" } : {},
    });
    expect(shellCheck(mode, "bash", shellRead("bash", spell(settings)))).toMatchObject(kind === "plain"
      ? { decision: SECRET_READ[mode], secretRead: true, secretPattern, network: [] }
      : { decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern, network: [] });
    for (const dialect of ["powershell", "bash"] as const) {
      expect({ dialect, ...shellCheck(mode, dialect, shellWrite(dialect, spell(settings))) }).toMatchObject(kind === "plain"
        ? { dialect, decision: PROTECTED_WRITE[mode], floor: "protected-path", protectedEntry: "application-home", network: [] }
        : { dialect, decision: PROJECT_ESCAPE[mode], floor: "project-escape", protectedEntry: homeEntry, network: [] });
    }

    // Listings of the application home itself: ordinary through the drive, and the opaque fallback through any other
    // spelling, because a share name is no proof of the drive.
    for (const [name, input] of [
      ["list_files", { path: spell(home), depth: 4 }],
      ["glob_files", { pattern: "**/*", path: spell(home) }],
      ["grep_files", { pattern: SENTINEL, path: spell(home) }],
    ] as const) {
      expect({ name, ...await runTool(mode, name, input) }).toMatchObject(kind === "plain"
        ? { name, decision: ORDINARY_READ, executed: true, network: [] }
        : { name, decision: read[mode], secretRead: true, secretPattern: "network-or-device-path", executed: allowed(read[mode]), network: [] });
    }
  });

  // Node folds slashes after `\\?\` and resolves `\??\` against the current drive, so the native tools open the drive
  // path and a path under `<drive>:\??`. Neither spelling names a local drive, so every read of it needs a person; the
  // folded slash spelling also carries the drive path's evidence.
  it.each(MODES)("%s: judges the NT prefix and a slash after the extended prefix by what each route opens", async mode => {
    for (const [spell, pattern, entry, powershellWrite] of [
      [EXTENDED_SLASH, "ave-home:config", "application-home", PROJECT_ESCAPE],
      [NT_PREFIX, "network-or-device-path", "network-or-device-path", PROTECTED_WRITE],
    ] as const) {
      const label = spell(settings);
      expect({ label, ...await runTool(mode, "read_file", { path: label }) }).toMatchObject({
        label, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: pattern, executed: false, network: [],
      });
      for (const [name, input] of [["write_file", { path: label, content: "overwritten" }], ["edit_file", { path: label, oldText: "{\"f", newText: "xyz" }]] as const) {
        expect({ label, name, ...await runTool(mode, name, input) }).toMatchObject({
          label, name, decision: PROJECT_ESCAPE[mode], floor: "project-escape", protectedEntry: entry, executed: false, network: [],
        });
      }
      for (const [dialect, write] of [["powershell", powershellWrite], ["bash", PROJECT_ESCAPE]] as const) {
        expect({ label, dialect, ...shellCheck(mode, dialect, shellRead(dialect, label)) }).toMatchObject({
          label, dialect, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: pattern, network: [],
        });
        expect({ label, dialect, ...shellCheck(mode, dialect, shellWrite(dialect, label)) }).toMatchObject({
          label, dialect, decision: write[mode], protectedEntry: entry, network: [],
        });
      }
    }
    expect(readFileSync(settings, "utf8")).toContain(SENTINEL);
  });

  // PowerShell opens the extended form of a drive path as that path, so a read of it, confined or not and with or without an
  // approver, is judged as the drive path.
  it.each(MODES)("%s: judges a PowerShell read of the extended form of a drive path as the drive path", async mode => {
    const notes = join(project, "notes.txt");
    await writeFile(notes, "notes\n");
    for (const [target, secretRead] of [[notes, false], [settings, true]] as const) {
      for (const sandboxed of [false, true]) for (const headless of new Set([true, mode === "headless"])) {
        const plain = shellCheck(mode, "powershell", shellRead("powershell", target), sandboxed, headless);
        expect(plain).toMatchObject({ secretRead, network: [] });
        expect({ target, sandboxed, headless, ...shellCheck(mode, "powershell", shellRead("powershell", `\\\\?\\${target}`), sandboxed, headless) })
          .toEqual({ target, sandboxed, headless, ...plain });
      }
    }
  });

  // Credential stores keep their admission deny through a mapped spelling and with a stream suffix; a store named only by
  // its place in the Ave home falls back to the human floor through a spelling that cannot be mapped.
  const STORES: ReadonlyArray<[string, Kind, Spelling]> = [
    ["plain", "plain", plain => plain],
    ["\\\\localhost\\X$", "alias", share("localhost")],
    ["\\\\?\\UNC\\127.0.0.1\\X$", "alias", share("?\\UNC\\127.0.0.1")],
    ["\\\\.\\X:", "alias", plain => `\\\\.\\${plain}`],
    ["\\\\?\\GLOBALROOT\\??\\X:", "unproven", plain => `\\\\?\\GLOBALROOT\\??\\${plain}`],
  ];
  it.each(MODES.flatMap(mode => STORES.map(([label, kind, spell]) => ({ mode, label, kind, spell }))))("$mode: credential stores through $label", async ({ mode, kind, spell }) => {
    for (const [store, named] of [[join(home, "ave-secrets.json"), true], [join(home, "secrets", "token"), false]] as const) {
      for (const suffix of ["", "::$DATA", ":backup:$DATA"]) {
        const path = spell(store) + suffix;
        const denied = kind !== "unproven" || named;
        const native = await runTool(mode, "read_file", { path });
        expect({ path, admission: admission(native), ...native }).toMatchObject(denied
          ? { path, admission: "credential-store", executed: false, network: [] }
          : { path, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "network-or-device-path", executed: false, network: [] });
        for (const dialect of ["powershell", "bash"] as const) {
          const shell = shellCheck(mode, dialect, shellRead(dialect, path));
          expect({ dialect, path, ...shell }).toMatchObject(denied
            ? { dialect, path, decision: "deny/credential-store", network: [] }
            : { dialect, path, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "network-or-device-path", network: [] });
        }
      }
    }
  });

  it.each(MODES)("%s: judges a link to a share by the spelling it reaches, without opening the share", async mode => {
    boundary.links.set(key(join(project, "home-link")), share("localhost")(home));
    boundary.links.set(key(join(project, "outer-link")), join(root, "hop"));
    boundary.links.set(key(join(root, "hop", "to-home")), share("127.0.0.1")(home));
    boundary.links.set(key(join(project, "remote-link")), String.raw`\\files.example\share\x`);
    try {
      for (const file of [join(project, "home-link", "config", "settings.json"), join(project, "outer-link", "to-home", "config", "settings.json")]) {
        expect({ file, ...await runTool(mode, "read_file", { path: file }) }).toMatchObject({
          file, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "ave-home:config", executed: false, network: [],
        });
        for (const dialect of ["powershell", "bash"] as const) {
          expect({ dialect, file, ...shellCheck(mode, dialect, shellRead(dialect, file)) }).toMatchObject({
            dialect, file, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "ave-home:config", network: [],
          });
        }
      }
      for (const [name, input] of [
        ["list_files", { path: join(project, "home-link"), depth: 3 }],
        ["grep_files", { pattern: SENTINEL, path: join(project, "home-link") }],
        ["read_file", { path: join(project, "remote-link", "notes.txt") }],
        ["read_file", { path: join(project, "remote-link", "id.key") }],
      ] as const) {
        expect({ name, input, ...await runTool(mode, name, input) }).toMatchObject({
          name, input, decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, executed: false, network: [],
        });
      }
    } finally { boundary.links.clear(); }
  });

  // The session's own setup reads the workspace root: whether it exists, the `.git` markers that locate project rules, and
  // the root identity a reviewer replay binds to. Judging a target inside it opens nothing.
  const targetCalls = (calls: readonly string[]) => calls.filter(call =>
    !/^[\w.]+ (?:(?:\\\\|\/\/)files\.example[\\/]share[\\/]proj|\\\\files\.example\\share(?:\\proj)?\\\.git)$/u.test(call));
  it.each(MODES)("%s: treats paths inside an authorized share workspace as ordinary project access", async mode => {
    for (const [name, input] of [
      ["read_file", { path: `${WORKSPACE}\\notes.txt` }],
      ["read_file", { path: "notes.txt" }],
      ["list_files", { path: WORKSPACE }],
      ["glob_files", { pattern: "*", path: WORKSPACE }],
      ["glob_files", { pattern: "*" }],
      ["grep_files", { pattern: SENTINEL, path: WORKSPACE }],
      ["grep_files", { pattern: SENTINEL }],
    ] as const) {
      const row = await runTool(mode, name, input, WORKSPACE);
      expect({ name, input, ...row, network: targetCalls(row.network) }).toMatchObject({
        name, input, decision: ORDINARY_READ, secretRead: false, executed: true, network: [],
      });
    }
    for (const path of [`${WORKSPACE}\\notes.txt`, "notes.txt"]) {
      const row = shellCheck(mode, "powershell", shellRead("powershell", path), false, mode === "headless", WORKSPACE);
      expect({ path, ...row, network: targetCalls(row.network) }).toMatchObject({ path, floor: undefined, secretRead: false, network: [] });
    }
    // Outside that workspace the same share path is an opaque target that needs a person, also in PowerShell.
    expect(await runTool(mode, "read_file", { path: `${WORKSPACE}\\notes.txt` })).toMatchObject({
      decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "network-or-device-path", executed: false, network: [],
    });
    expect(shellCheck(mode, "powershell", shellRead("powershell", `${WORKSPACE}\\notes.txt`))).toMatchObject({
      decision: PROJECT_ESCAPE[mode], floor: "project-escape", secretRead: true, secretPattern: "network-or-device-path", network: [],
    });
    // A loopback share still names the drive path inside the workspace.
    const loopback = await runTool(mode, "read_file", { path: share("localhost")(settings) }, WORKSPACE);
    expect({ ...loopback, network: targetCalls(loopback.network) }).toMatchObject({
      decision: SECRET_READ[mode], secretRead: true, secretPattern: "ave-home:config", executed: allowed(SECRET_READ[mode]), network: [],
    });
  });

  // Only a canonical share spelling is project access: a spelling Windows may read as another object, or an extended one,
  // keeps the human floor beside its ordinary siblings in the same workspace.
  it.each(MODES)("%s: keeps ambiguous and extended spellings inside an authorized share workspace on the floor", mode => {
    const sibling = shellCheck(mode, "powershell", shellRead("powershell", `${WORKSPACE}\\notes.txt`), false, mode === "headless", WORKSPACE);
    expect({ ...sibling, network: targetCalls(sibling.network) }).toMatchObject({ floor: undefined, network: [] });
    for (const path of [
      `${WORKSPACE}\\notes.txt.`, `${WORKSPACE}\\notes.txt `, `${WORKSPACE}\\sub.\\notes.txt`,
      `\\\\?\\UNC\\files.example\\share\\proj\\notes.txt`,
    ]) {
      const row = shellCheck(mode, "powershell", shellRead("powershell", path), false, mode === "headless", WORKSPACE);
      expect({ path, ...row, network: targetCalls(row.network) }).toMatchObject({
        path, decision: PROJECT_ESCAPE[mode], floor: "project-escape", network: [],
      });
    }
  });

  // A loopback share names a local drive, so a project root spelled through one is no share workspace: an ordinary name
  // under it keeps the opaque fact.
  it.each(MODES)("%s: keeps the opaque fact under a project root spelled through a loopback share", async mode => {
    const root = share("localhost")(project);
    await writeFile(join(project, "notes.txt"), "notes\n");
    const rootCalls = (calls: readonly string[]) => calls.filter(call => !call.toLowerCase().includes(root.toLowerCase()));
    const native = await runTool(mode, "read_file", { path: `${root}\\notes.txt` }, root);
    expect({ ...native, network: rootCalls(native.network) }).toMatchObject({
      decision: SECRET_READ[mode], secretRead: true, secretPattern: "network-or-device-path", executed: allowed(SECRET_READ[mode]), network: [],
    });
    for (const path of [`${root}\\notes.txt`, "notes.txt"]) {
      const shell = shellCheck(mode, "powershell", shellRead("powershell", path), false, mode === "headless", root);
      expect({ path, ...shell, network: rootCalls(shell.network) }).toMatchObject({
        path, decision: SECRET_READ[mode], secretRead: true, secretPattern: "network-or-device-path", network: [],
      });
    }
  });

  // Directory authority is granted to a spelling, never inherited from the drive a loopback share names: with reads
  // fenced, the project directory admits its drive path only, and a directory granted through the share admits that share.
  it.each(MODES)("%s: keeps a loopback spelling outside the directory its drive path is granted", async mode => {
    const notes = join(project, "notes.txt"); await writeFile(notes, "notes\n");
    const reads = (spell: Spelling) => [
      ["read_file", { path: spell(notes) }],
      ["grep_files", { pattern: SENTINEL, path: spell(notes) }],
      ["list_files", { path: spell(project) }],
    ] as const;
    for (const [name, input] of reads(plain => plain)) {
      expect({ name, ...await runTool(mode, name, input, project, true) }).toMatchObject({ name, decision: ORDINARY_READ, executed: true, network: [] });
    }
    for (const spell of [share("localhost"), FORWARD_CASE]) {
      for (const [name, input] of reads(spell)) {
        expect({ name, ...input, ...await runTool(mode, name, input, project, true) }).toMatchObject({
          name, decision: "deny/read-boundary", executed: false, network: [],
        });
      }
    }
    // Granting the root as spelled reads it like any loopback path; only the grant's own root check touches the share.
    const spelled = share("localhost")(project);
    const granted = await runTool(mode, "read_file", { path: `${spelled}\\notes.txt` }, project, true, [spelled]);
    expect({ ...granted, network: granted.network.filter(call => !call.toLowerCase().endsWith(spelled.toLowerCase())) }).toMatchObject({
      decision: SECRET_READ[mode], secretRead: true, executed: allowed(SECRET_READ[mode]), network: [],
    });
  });

  // A drive letter the OS maps to a share is that share: classification reads the mapping and opens nothing on the drive.
  it.each(MODES)("%s: judges a drive mapped to a share without opening it", async mode => {
    const file = `${REMOTE_DRIVE}\\data\\notes.txt`;
    for (const path of [file, share("localhost")(file)]) {
      expect({ path, ...await runTool(mode, "read_file", { path }) }).toMatchObject({
        path, decision: PROJECT_ESCAPE[mode], floor: "project-escape", executed: false, network: [],
      });
      for (const dialect of ["powershell", "bash"] as const) {
        expect({ path, dialect, ...shellCheck(mode, dialect, shellRead(dialect, path)) }).toMatchObject({
          path, dialect, decision: PROJECT_ESCAPE[mode], floor: "project-escape", network: [],
        });
      }
    }
    expect(await runTool(mode, "write_file", { path: file, content: "x" })).toMatchObject({ executed: false, network: [] });
    expect(shellCheck(mode, "powershell", shellWrite("powershell", file))).toMatchObject({ decision: PROJECT_ESCAPE[mode], network: [] });
  });

  // A folder listing checks each row against policy roots it resolves once and then revalidates; a root on that drive,
  // such as an Ave home there, is never opened for either.
  it("checks folder rows against an Ave home on a drive mapped to a share without opening the drive", () => {
    vi.stubEnv("AVE_HOME", `${REMOTE_DRIVE}\\ave-home`);
    try {
      boundary.network.length = 0;
      for (const effect of ["read", "write"] as const) {
        const check = createSensitivePathCheck(effect);
        for (const row of [join(project, "notes.txt"), join(project, "notes.txt")]) expect(check(row)).toBeNull();
        for (let pass = 0; pass < 2; pass++) check(`${REMOTE_DRIVE}\\ave-home\\config\\settings.json`);
      }
      expect(boundary.network).toEqual([]);
    } finally {
      vi.stubEnv("AVE_HOME", home);
    }
    const check = createSensitivePathCheck("read");
    for (let pass = 0; pass < 2; pass++) expect(check(settings)).not.toBeNull();
  });

  // A project on that drive is a share workspace: inside it, judging a target opens nothing beyond the session's own setup.
  it.each(MODES)("%s: treats paths inside a project on a mapped drive as share workspace access", async mode => {
    const workspace = `${REMOTE_DRIVE}\\proj`;
    const judged = (calls: readonly string[]) => targetCalls(calls).filter(call => call !== `existsSync ${workspace}`);
    for (const [name, input] of [["read_file", { path: `${workspace}\\notes.txt` }], ["read_file", { path: "notes.txt" }]] as const) {
      const row = await runTool(mode, name, input, workspace);
      expect({ name, input, ...row, network: judged(row.network) }).toMatchObject({
        name, input, decision: ORDINARY_READ, secretRead: false, executed: true, network: [],
      });
    }
    for (const path of [`${workspace}\\notes.txt`, "notes.txt"]) {
      const row = shellCheck(mode, "powershell", shellRead("powershell", path), false, mode === "headless", workspace);
      expect({ path, ...row, network: judged(row.network) }).toMatchObject({ path, floor: undefined, secretRead: false, network: [] });
    }
  });

  it.each(MODES)("%s: does not open below a lookup that answers with a share", async mode => {
    const link = join(project, "odd-link");
    boundary.links.set(key(link), join(root, "hop"));
    boundary.physical.set(key(link), String.raw`\\files.example\share\odd`);
    try {
      expect(await runTool(mode, "read_file", { path: join(link, "notes.txt") })).toMatchObject({
        decision: PROJECT_ESCAPE[mode], floor: "project-escape", executed: false, network: [],
      });
      expect(shellCheck(mode, "powershell", shellRead("powershell", join(link, "notes.txt")))).toMatchObject({
        decision: PROJECT_ESCAPE[mode], floor: "project-escape", network: [],
      });
    } finally {
      boundary.links.clear();
      boundary.physical.clear();
    }
  });

  // The floor comes before every allow: a rule that admits the drive path's read leaves the unmapped spelling to a person.
  it.each(MODES)("%s: keeps an unmapped shell read on the floor past an applicable allow rule", async mode => {
    const manager = managerFor(mode);
    await manager.addRulePersist({ pattern: "Bash(cat *)", action: "allow" }, { kind: "user" });
    const notes = join(project, "notes.txt");
    await writeFile(notes, "notes\n");
    expect(shellCheck(mode, "bash", shellRead("bash", notes), false, mode === "headless", project, manager).decision).toBe("allow/rule-allow");
    for (const [, spell] of UNPROVEN) {
      const label = spell(notes);
      expect({ label, ...shellCheck(mode, "bash", shellRead("bash", label), false, mode === "headless", project, manager) }).toMatchObject({
        label, decision: PROJECT_ESCAPE[mode], floor: "project-escape", network: [],
      });
    }
  });

  // On Windows a PowerShell allow rule or remembered approval applies only on a pinned sandboxed launch, which a plain
  // check is not (isPowerShellStartupPinned). The unmapped read's request keeps its floor past both, and past a low review.
  it.each(MODES)("%s: keeps an unmapped PowerShell read on the floor past allows and a low review", async mode => {
    const notes = join(project, "notes.txt");
    await writeFile(notes, "notes\n");
    for (const [label, spell] of UNPROVEN) {
      const request = shellChecked("powershell", shellRead("powershell", spell(notes)), false, mode === "headless", project, managerFor(mode))
        .pipelineRequest as PermissionDecisionRequest;
      const passing = { ...request, rules: { ...request.rules, allow: "PowerShell(Get-Content *)", remembered: "PowerShell(Get-Content *)" },
        reviewer: { status: "success", level: "low", breakerOpen: false } } satisfies PermissionDecisionRequest;
      expect({ label, ...decidePermission(passing) }).toMatchObject(mode === "headless"
        ? { label, outcome: "deny", reasonCode: "no-approver" } : { label, outcome: "ask-forced", reasonCode: "project-escape" });
      expect({ label, ...decidePermission({ ...passing, floor: undefined }) }).toMatchObject({ label, outcome: "allow", reasonCode: "rule-allow" });
    }
  });

  // The base refused these rows before approval because its identity check compared mismatched spellings. A mapped share
  // is judged by name as the drive path, which never clears key material; a spelling that names no local drive is on the
  // human floor in every mode.
  it.each(MODES)("%s: judges project key material through a share or device spelling", async mode => {
    const pem = join(project, "server.pem");
    await writeFile(pem, "not a key\n");
    expect(await runTool(mode, "read_file", { path: pem })).toMatchObject({ decision: SECRET_READ[mode], secretRead: true, network: [] });
    expect(shellCheck(mode, "powershell", shellRead("powershell", pem))).toMatchObject({ decision: SECRET_READ[mode], secretRead: true, network: [] });
    const forwardCase = FORWARD_CASE(pem);
    for (const [name, input] of [["read_file", { path: forwardCase }], ["grep_files", { pattern: SENTINEL, path: forwardCase }]] as const) {
      expect({ name, ...await runTool(mode, name, input) }).toMatchObject({
        name, decision: SECRET_READ[mode], secretRead: true, executed: allowed(SECRET_READ[mode]), network: [],
      });
    }
    for (const [label, spell] of ALIASES) {
      expect({ label, ...shellCheck(mode, "powershell", shellRead("powershell", spell(pem))) }).toMatchObject({
        label, decision: SECRET_READ[mode], secretRead: true, network: [],
      });
    }
    for (const runsSandboxed of [false, true]) {
      for (const command of [shellWrite("powershell", EXTENDED_SLASH(pem)), shellRead("powershell", GLOBALROOT(pem))]) {
        expect({ command, runsSandboxed, ...shellCheck(mode, "powershell", command, runsSandboxed) }).toMatchObject({
          command, runsSandboxed, decision: PROJECT_ESCAPE[mode], floor: "project-escape", network: [],
        });
      }
    }
  });

  it.each(MODES)("%s: judges an omitted search root as the working directory it searches", async mode => {
    const config = join(home, "config");
    for (const [name, input] of [
      ["glob_files", { pattern: "*" }], ["glob_files", { pattern: "*", path: "." }],
      ["grep_files", { pattern: SENTINEL }], ["grep_files", { pattern: SENTINEL, path: "." }],
    ] as const) {
      expect({ name, input, ...await runTool(mode, name, input, config) }).toMatchObject({
        name, input, decision: SECRET_READ[mode], secretRead: true, secretPattern: "ave-home:config", executed: allowed(SECRET_READ[mode]),
      });
    }
  });
});
