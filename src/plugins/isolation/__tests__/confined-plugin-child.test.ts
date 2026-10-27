import { writePermissionSettingsFixture } from "../../../__tests__/support/permission-settings-fixture.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";
import { canCreateSymlinks } from "../../../__tests__/support/symlink-capability.js";
/** Exercise real confined spawns: secret denial, outside-write refusal, usable own data, private temp storage, mandatory wrapping, and unavailable desktop APIs.
 * Read isolation needs a covering deny; allowed writes include the principal temp directory, and offline probes do not prove egress enforcement.
 * Native cases may opt out locally when unavailable, but required CI backends must fail rather than skip. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_RUNTIME_DIR_NAMES,
  resolvePluginHostStorageDir,
  resolvePluginSocketDir,
  writeGrantsReachingHostStorage,
  resolvePluginWorkerRunRoot,
} from "../../plugin-storage-layout.js";
import { aveHome, ensureAveHomePrivate } from "../../../shared/ave-home.js";
// Global setup builds this entry once with the shipped bundle boundary. Every confinement case still spawns that real bundle through the real wrap.
import { repositoryRoot } from "./child-entry-bundle.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import type { DelegatedWorkerConfinement } from "../host-api-dispatcher.js";
import {
  createOutOfProcessPluginFactory,
  derivePluginChildEnvelope,
  PluginSandboxGrantError,
  type ObservedPluginChild,
} from "../out-of-process-plugin.js";
import {
  appOwnedSandboxHomeRoot,
  appOwnedSandboxTempRoot,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  isGrantPathWithin,
  outermostContainingRoots,
  resetAsrtSandbox,
  sandboxTempPrincipalDirName,
  type SandboxTempPrincipal,
} from "../../../permissions/asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../../../permissions/sandbox-write-policy.js";
import { sandboxCasesRun } from "./sandbox-cases.js";
import {
  __resetSandboxRequestedAtBootForTest,
  isPluginChildConfined,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../../../permissions/sandbox-capability.js";
import { connect } from "node:net";
import { createServer } from "node:http";
import { spawnConfinedPluginChild } from "../out-of-process-plugin.js";
import { spawnWorker } from "../../../permissions/worker-spawn.js";
import { runOneHookScript } from "../../../hooks/script-hook-runner.js";
import { flattenAgentPluginsManifest } from "../../public-contract.js";
import { createValidationHost } from "../../validate/validation-host.js";
import { createRecordingHost } from "./host-protocol-recording-host.js";
import { useVerifiedAveHomePrivacy } from "../../../__tests__/support/ave-home-privacy.js";
import { assertProcessEntryAdmitted, resolveProcessLaunch } from "../../process-entry.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import { bundledWrappedEnv, wrapBundledCommand } from "../../../sandbox/wrap-bundled-command.js";
import { createSandboxProcessHome } from "../../../permissions/sandbox-process-home.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import { FRAME_BYTES_MAX } from "../host-api-wire.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import {
  buildGitInstallReceipt,
  listFilesRecursive,
  writeInstallReceipt,
} from "../../plugin-install-receipt.js";
import { verifyPluginIntegrity } from "../../runtime/index.js";
import { installPythonSmoke, reportSmoke } from "./python-smoke-harness.js";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";

useVerifiedAveHomePrivacy();

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "sampleassistant";
const WIDENED_PLUGIN_ID = "local-indexer";
const WIDENED_SANDBOX: NonNullable<PluginManifest["sandbox"]> = {
  read: [
    { kind: "hostDirectory", segments: ["runtime"], why: "Read host runtime" },
    { kind: "hostDirectory", segments: ["certs"], why: "Read trust anchors" },
  ],
  write: [
    { kind: "userChosenDirectory", configKey: "indexStorageRoot", why: "Store index data" },
    { kind: "userChosenDirectory", configKey: "workspace", why: "Use the approved workspace" },
  ],
};
const CANDIDATE_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Sample Assistant",
  version: "1.0.0",
  entry: "index.js",
  requires: { hostProtocol: "4" },
  description: "Exercises declared filesystem authority",
  tools: [],
  sandbox: {
    read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read the trust anchor" }],
    write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }],
  },
  configSchema: { properties: { workspace: { type: "string" } } },
};
const SECRET_TEXT = "the-host-secret-the-child-must-not-read";
/** The bytes the host-owned trust-anchor file holds, so "the child read it" is checkable. */
const CA_TEXT = "-----BEGIN CERTIFICATE-----\nthe-corporate-trust-anchor\n";
/** The bytes an un-migrated session file holds, so "nothing moved" is checkable. */
const LEGACY_SESSION_BYTES = "the session that predates pluginDataDir";
/** Stands in for the plugin's own code: readable out of `pluginRoot`, never writable back into it. */
const PLUGIN_CODE_BYTES = "the plugin's own code, which it may read and may not rewrite";
/** What the host stored for the plugin, which the child may not touch. */
const HOST_STORED_TEXT = '{"stored":"by the host"}';
/** What one child leaves in its own temp directory, so the host reading it back shows the write landed and lasted. */
const OWN_TEMP_BYTES = "bytes one confined child left in its own temp directory";

/** A former implicit write grant, now governed by the ordinary write jail. */
const LEGACY_SHARED_TEMP_ROOT = "/tmp/claude";
const SHARED_TEMP_BYTES = "the host's unchanged shared-temp bytes";

interface Fixture {
  readonly root: string;
  readonly aveHome: string;
  readonly secretFile: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly outsideFile: string;
  /** Stands in for what production passes as `context.hostRoot`: the app root, which is NOT the plugin's data directory and NOT inside its write
   * jail. A case that passed the repository root here would assert the same denial against a directory the developer's own machine happens to own. */
  readonly hostRoot: string;
  /** The basename a child writes into its plugin's temp directory, which the host then reads back and a second plugin's child is refused. */
  readonly ownTempName: string;
  readonly ungrantedTempDir: string;
  readonly ungrantedTempFile: string;
  /** `<AVE_HOME>/certs/corp-ca.pem`; host-owned AND on the read-deny floor. */
  readonly caFile: string;
  /** A directory the user approved, standing in for a chosen index root. */
  readonly userRoot: string;
  /** Its name-prefix sibling, which no grant covers. */
  readonly userRootSibling: string;
  /** A chosen directory INSIDE the approved root that does not exist yet; the case that decides what "the declared path is not there" means. */
  readonly pendingWorkspace: string;
  /** `<AVE_HOME>/runtime`; where the `hostDirectory` row of the widened plugin's grant resolves. Host-owned,
   * granted READ, and NOT on the deny floor, so nothing else in the derivation refuses a value naming it. */
  readonly hostRuntimeDir: string;
  /** A SECOND plugin's bundle directory, under the same install root as the first. It is the neighbour's equivalent of `<pluginRoot>/dist`:
   * the module the next load imports into the main process on that plugin's behalf, and the bytes its own install receipt is taken over. */
  readonly neighbourBundleDir: string;
}

let fixture: Fixture | undefined;
let retainedSandbox = false;
let previousAveHome: string | undefined;
/** ASRT reads this out of the HOST env when it builds the wrap and writes it as `TMPDIR` ahead of the command, where the in-wrap assignment of the
 * principal's directory overrides it. One case points it at an absent path to show the child never sees it, so it is restored the same way `AVE_HOME` is. */
let previousSandboxTmpdir: string | undefined;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "confined-plugin-"));
  const aveHome = join(root, ".ave");
  setFixtureOwner(root);
  expect(ensureAveHomePrivate(aveHome).enforcement).not.toBe("none");
  const ungrantedTempDir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "ave-ungranted-"));
  const ungrantedTempFile = join(ungrantedTempDir, "host-owned.txt");
  chmodSync(ungrantedTempDir, 0o777);
  writeFileSync(ungrantedTempFile, SHARED_TEMP_BYTES, { mode: 0o666 });
  chmodSync(ungrantedTempFile, 0o666);
  const secretsDir = join(aveHome, "secrets");
  const certsDir = join(aveHome, "certs");
  const pluginRoot = join(aveHome, "plugins", PLUGIN_ID);
  const pluginDataDir = join(pluginRoot, "data");
  const userRoot = join(root, "chosen-index-root");
  const userRootSibling = `${userRoot}-elsewhere`;
  // Deliberately NOT created: the spawn is what materialises a granted root.
  const pendingWorkspace = join(userRoot, "pending-workspace");
  const hostRuntimeDir = join(aveHome, "runtime");
  const neighbourBundleDir = join(aveHome, "plugins", "another-plugin", "dist");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  mkdirSync(userRootSibling, { recursive: true, mode: 0o700 });
  mkdirSync(hostRuntimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(neighbourBundleDir, { recursive: true, mode: 0o700 });
  const secretFile = join(secretsDir, "api-key.txt");
  const caFile = join(certsDir, "corp-ca.pem");
  writeFileSync(secretFile, SECRET_TEXT, "utf-8");
  writeFileSync(caFile, CA_TEXT, "utf-8");
  writeFileSync(join(pluginDataDir, "own-data.txt"), "the plugin's own bytes", "utf-8");
  writeFileSync(join(pluginRoot, "own-code.js"), PLUGIN_CODE_BYTES, "utf-8");
  // The host-only directory the HostApi `storage` surface operates in.
  mkdirSync(resolvePluginHostStorageDir(pluginDataDir), { mode: 0o700 });
  writeFileSync(join(resolvePluginHostStorageDir(pluginDataDir), "stored.json"), HOST_STORED_TEXT, "utf-8");
  const hostRoot = join(root, "app-root");
  mkdirSync(hostRoot, { recursive: true });
  // The user's own workspace-root approvals, read back by the envelope derivation through `readPermissionSettings()`. Written as a file
  // rather than stubbed because the ceiling on a user-chosen directory is exactly this list, and a stub would prove the test's copy of the rule.
  writePermissionSettingsFixture(aveHome,
    JSON.stringify({ permissions: { additionalDirectories: [userRoot] } }, null, 2),
    "utf-8",
  );
  return {
    root,
    aveHome,
    secretFile,
    pluginRoot,
    pluginDataDir,
    outsideFile: join(root, "outside-the-jail.txt"),
    hostRoot,
    ownTempName: `${basename(root)}.txt`,
    ungrantedTempDir,
    ungrantedTempFile,
    caFile,
    userRoot,
    userRootSibling,
    pendingWorkspace,
    hostRuntimeDir,
    neighbourBundleDir,
  };
}

/** Where a second plugin's code and data live under the same fixture home. */
interface InstalledPlugin {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
}

/** Install another plugin beside the pilot, in the same fixture home. The fixture is shared rather than copied because everything that makes it a fixture is plugin-independent: the deny floor is derived from `AVE_HOME`, the secret it protects is one file,
 * and the write-jail escape target is one path outside it. What varies per plugin is two directories, which is what this returns. A second `makeFixture` would be a second copy of the deny floor's own premise, and the two would only have to disagree once. */
function installPlugin(fx: Fixture, pluginId: string): InstalledPlugin {
  const pluginRoot = join(fx.aveHome, "plugins", pluginId);
  const pluginDataDir = join(pluginRoot, "data");
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  return { pluginId, pluginRoot, pluginDataDir };
}

/**
 * Approve one directory as a workspace root, replacing whatever
 * {@link makeFixture} wrote.
 *
 * The ceiling's approval half reads this file through
 * `readPermissionSettings()`, so a case that needs a BROADER approval than the
 * default has to move the real file rather than stub the reader.
 */
function approveWorkspaceRoot(fx: Fixture, directory: string): void {
  writePermissionSettingsFixture(fx.aveHome,
    JSON.stringify({ permissions: { additionalDirectories: [directory] } }, null, 2),
    "utf-8",
  );
}

/** A child that reports what the sandbox let it do, as one JSON line on stdout. Written as the child's ENTRY MODULE and spawned by the production `spawnConfinedPluginChild`, so the argv wrap, the allow paths, the deny floor and the environment are the ones a real plugin child gets. Only the
 * module it runs differs; because the question here is what the confinement permits, not what the protocol says. It reports on stdout, which is free here precisely because this probe is not the protocol module: `plugin-child-main.ts` claims stdout for framing, and this one does not run it. */
function writeProbeModule(fx: Fixture): string {
  const probePath = join(fx.root, "probe.mjs");
  // The `electron` npm package's entry, in the shape that matters: it exports the PATH of the binary as a string. Planted from the host, inside the child's read carve-out,
  // because the child could not create it and because the question it answers; "what if the plugin ships the package?"; is about what the entry EXPORTS, not about module resolution.
  const vendoredDir = join(fx.pluginRoot, "vendored-electron");
  mkdirSync(vendoredDir, { recursive: true });
  writeFileSync(
    join(vendoredDir, "index.js"),
    "module.exports = '/path/to/an/Electron/binary';\n",
    "utf-8",
  );
  // A module whose only content is the form an ESM plugin writes. Planted as a FILE rather than evaluated inline
  // because a named import is resolved when the module is LINKED, and linking is the step whose failure is the answer.
  const namedImportPath = join(fx.pluginRoot, "named-electron-import.mjs");
  writeFileSync(
    namedImportPath,
    "import { BrowserWindow } from \"electron\";\nexport const browserWindow = typeof BrowserWindow;\n",
    "utf-8",
  );
  writeFileSync(
    probePath,
    `import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
/** What \`typeof\` says about a resolved module's \`BrowserWindow\`, or the kind of the module itself. */
const describeModule = (value) => (value && typeof value === "object")
  ? { kind: "object", browserWindow: typeof value.BrowserWindow }
  : { kind: typeof value, browserWindow: "undefined" };
const report = {
  readSecret: attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
  readOwnData: attempt(() => readFileSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, "utf-8")),
  writeOwnData: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pluginDataDir, "written-by-child.txt"))}, "hello"); return "written"; }),
  writeOutside: attempt(() => { writeFileSync(${JSON.stringify(fx.outsideFile)}, "escaped"); return "written"; }),
  writeSecrets: attempt(() => { writeFileSync(${JSON.stringify(join(fx.aveHome, "secrets", "planted.txt"))}, "escaped"); return "written"; }),
  // \`pluginRoot\` is the asymmetric one: the child READS it — that is where
  // its own code lives — and cannot WRITE it, because those are the bytes the
  // integrity check hashed. Read and write are separate grants and only one of
  // them names this path.
  readOwnCode: attempt(() => readFileSync(${JSON.stringify(join(fx.pluginRoot, "own-code.js"))}, "utf-8")),
  writeOwnCode: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pluginRoot, "smuggled.js"))}, "escaped"); return "written"; }),
  // The host-only storage directory beside \`pluginDataDir\`: the host reads
  // and writes it on the plugin's behalf, so the child must not be able to
  // create, replace or re-point ANY component of a path there — that is what
  // lets the host's syscall land where its containment check looked.
  hostStorage: {
    write: attempt(() => { writeFileSync(${JSON.stringify(join(resolvePluginHostStorageDir(fx.pluginDataDir), "planted.txt"))}, "escaped"); return "written"; }),
    overwrite: attempt(() => { writeFileSync(${JSON.stringify(join(resolvePluginHostStorageDir(fx.pluginDataDir), "stored.json"))}, "tampered"); return "written"; }),
    mkdir: attempt(() => { mkdirSync(${JSON.stringify(join(resolvePluginHostStorageDir(fx.pluginDataDir), "sub"))}); return "made"; }),
    link: attempt(() => { symlinkSync(${JSON.stringify(fx.root)}, ${JSON.stringify(join(resolvePluginHostStorageDir(fx.pluginDataDir), "link"))}); return "linked"; }),
    moveIn: attempt(() => { renameSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, ${JSON.stringify(join(resolvePluginHostStorageDir(fx.pluginDataDir), "moved.txt"))}); return "moved"; }),
    replace: attempt(() => { renameSync(${JSON.stringify(resolvePluginHostStorageDir(fx.pluginDataDir))}, ${JSON.stringify(`${resolvePluginHostStorageDir(fx.pluginDataDir)}-moved`)}); return "moved"; }),
    replaceWithLink: attempt(() => { symlinkSync(${JSON.stringify(fx.root)}, ${JSON.stringify(join(fx.pluginRoot, "storage-link"))}); return "linked"; }),
  },
  // The third answer this axis gives, and the only one that looks like
  // success. HOME is SUBSTITUTED with a throwaway the spawn grants and
  // \`createSandboxProcessHome\` removes when the child exits, so a plugin that
  // roots its state at \`homedir()\` is neither denied nor durable: the write
  // returns \`written\` and the bytes are gone by the next start.
  childHome: homedir(),
  writeChildHome: attempt(() => { writeFileSync(join(homedir(), "state.json"), "state"); return "written"; }),
  // The FOURTH answer, and the one that falsifies "the jail is what the spawn
  // granted": the temp directory, granted by the confinement primitive rather
  // than by the spawn — outside \`pluginDataDir\`, outside the substituted HOME,
  // and DURABLE. The host reads the bytes back to show the last part.
  childTmpdir: tmpdir(),
  writeChildTmpdir: attempt(() => { mkdirSync(tmpdir(), { recursive: true }); writeFileSync(join(tmpdir(), ${JSON.stringify(fx.ownTempName)}), ${JSON.stringify(OWN_TEMP_BYTES)}); return "written"; }),
  writeUngrantedTemp: attempt(() => { writeFileSync(${JSON.stringify(fx.ungrantedTempFile)}, "escaped"); return "written"; }),
  writeLegacySharedTemp: process.platform === "win32" ? { ok: false, code: "platform-unsupported" } : attempt(() => { writeFileSync(${JSON.stringify(join(LEGACY_SHARED_TEMP_ROOT, fx.ownTempName))}, "escaped", { flag: "wx" }); return "written"; }),
  readCa: attempt(() => readFileSync(${JSON.stringify(fx.caFile)}, "utf-8")),
  writeCa: attempt(() => { writeFileSync(${JSON.stringify(fx.caFile)}, "rewritten"); return "written"; }),
  writeUserRoot: attempt(() => { writeFileSync(${JSON.stringify(join(fx.userRoot, "index.bin"))}, "index"); return "written"; }),
  writeUserRootSibling: attempt(() => { writeFileSync(${JSON.stringify(join(fx.userRootSibling, "index.bin"))}, "escaped"); return "written"; }),
  writePendingWorkspace: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pendingWorkspace, "state.json"))}, "{}"); return "written"; }),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  // The process IS Electron — this is the binary the host runs as — and the
  // next two lines are what it can do with that.
  electronVersion: process.versions.electron ?? null,
  requireElectron: (() => { const r = attempt(() => require("electron")); return r.ok ? { ok: true, module: describeModule(r.value) } : r; })(),
  // The package, resolved by absolute path so the answer is about what the
  // ENTRY exports rather than about where resolution happened to look.
  requirePackagedElectron: (() => { const r = attempt(() => require(${JSON.stringify(join(fx.pluginRoot, "vendored-electron", "index.js"))})); return r.ok ? { ok: true, module: describeModule(r.value) } : r; })(),
  // The two ESM forms. \`require\` is not the whole answer: the CJS registry and
  // the ESM resolver disagree about \`electron\` in this child, so a plugin's
  // module system decides WHERE it breaks.
  //
  // The namespace's OWN \`BrowserWindow\` is not the whole answer either. A CJS
  // module reached through the ESM resolver hangs its exports off \`default\`, so
  // the question "did the API come back" has to be asked of \`default\` — an
  // assertion that only read the namespace would stay green if \`default\` were
  // the real \`electron\`.
  importElectron: await (async () => { try { const ns = await import("electron"); const d = ns.default; return { ok: true, module: describeModule(ns), defaultKeys: (d && typeof d === "object") ? Object.keys(d) : null, defaultBrowserWindow: d ? typeof d.BrowserWindow : "no-default" }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } })(),
  namedImportElectron: await (async () => { try { const m = await import(${JSON.stringify(namedImportPath)}); return { ok: true, module: { kind: "namespace", browserWindow: String(m.browserWindow) } }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } })(),
};
process.stdout.write("PROBE:" + JSON.stringify(report) + "\\n");
`,
    "utf-8",
  );
  return probePath;
}

interface ProbeAttempt {
  readonly ok: boolean;
  readonly value?: string;
  readonly code?: string;
}

/** What a resolved module turned out to be, from inside the child. */
interface ProbeModule {
  readonly kind: string;
  readonly browserWindow: string;
}

interface ProbeModuleAttempt {
  readonly ok: boolean;
  readonly module?: ProbeModule;
  readonly code?: string;
}

/** A namespace produced by the ESM resolver, which is not the same object shape a `require` returns: a CJS module
 * reached this way carries its exports on `default`, so the namespace and its `default` are reported separately. */
interface ProbeNamespaceAttempt extends ProbeModuleAttempt {
  readonly defaultKeys?: readonly string[] | null;
  readonly defaultBrowserWindow?: string;
}

interface ProbeReport {
  readonly readSecret: ProbeAttempt;
  readonly readOwnData: ProbeAttempt;
  readonly writeOwnData: ProbeAttempt;
  readonly writeOutside: ProbeAttempt;
  readonly writeSecrets: ProbeAttempt;
  readonly readOwnCode: ProbeAttempt;
  readonly writeOwnCode: ProbeAttempt;
  readonly hostStorage: Readonly<Record<"write" | "overwrite" | "mkdir" | "link" | "moveIn" | "replace" | "replaceWithLink", ProbeAttempt>>;
  readonly childHome: string;
  readonly writeChildHome: ProbeAttempt;
  readonly childTmpdir: string;
  readonly writeChildTmpdir: ProbeAttempt;
  readonly writeUngrantedTemp: ProbeAttempt;
  readonly writeLegacySharedTemp: ProbeAttempt;
  readonly readCa: ProbeAttempt;
  readonly writeCa: ProbeAttempt;
  readonly writeUserRoot: ProbeAttempt;
  readonly writeUserRootSibling: ProbeAttempt;
  readonly writePendingWorkspace: ProbeAttempt;
  readonly electronRunAsNode: string | null;
  readonly electronVersion: string | null;
  readonly requireElectron: ProbeModuleAttempt;
  readonly requirePackagedElectron: ProbeModuleAttempt;
  readonly importElectron: ProbeNamespaceAttempt;
  readonly namedImportElectron: ProbeModuleAttempt;
}

/** The envelope an UNWIDENED plugin gets: its own two directories and nothing else, as `derivePluginChildEnvelope` produces without declared grants. The socket directory every confined child gets, in the BASE envelope. Named here so the expectations below say
 * WHICH directory the extra entry is rather than growing an unexplained third path. It carries no reach; it is inside the plugin's own storage namespace, beside `data`; and it exists in every envelope so the spawn can register it with the sandbox unconditionally. */
function socketDirOf(fx: Fixture): string {
  return resolvePluginSocketDir(fx.pluginDataDir);
}

/** The other half of the same boundary: `run/` is where the HOST binds a control socket for a worker this
 * plugin asked for, and the child is the client. READ only; the child connects, it does not create anything there. */
function workerRunRootOf(fx: Fixture): string {
  return resolvePluginWorkerRunRoot(fx.pluginDataDir);
}

function baseEnvelope(fx: Fixture): DelegatedWorkerConfinement {
  return derivePluginChildEnvelope({
    pluginId: PLUGIN_ID,
    pluginRoot: fx.pluginRoot,
    pluginDataDir: fx.pluginDataDir,
    configValue: () => undefined,
  });
}

async function runProbe(
  fx: Fixture,
  envelope: DelegatedWorkerConfinement = baseEnvelope(fx),
): Promise<ProbeReport> {
  const child = await spawnConfinedPluginChild({
    pluginId: PLUGIN_ID,
    socketDir: resolvePluginSocketDir(fx.pluginDataDir),
    workerRunRoot: resolvePluginWorkerRunRoot(fx.pluginDataDir),
    envelope,
    launch: { kind: "entry", childEntryPath: writeProbeModule(fx) },
  });
  return await new Promise<ProbeReport>((resolve, reject) => {
    let stdout = "";
    child.link.input.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.link.input.on("end", () => {
      const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
      if (!line) {
        reject(new Error(`the probe produced no report; stdout was: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice("PROBE:".length)) as ProbeReport);
    });
    child.link.input.on("error", reject);
  });
}

/** A SECOND confined child, from a second plugin, reading one absolute path. Spawned through the same production spawn, and through the same production derivation, with a different `pluginRoot` and `pluginDataDir`; so the only thing the two children share is what ASRT gives every wrap. The second plugin has no declared filesystem
 * grants, so its envelope is its own two directories and the difference between the two children is exactly those directories. That is the whole question: the routing SOT's write jail is per-plugin, but the default write paths ASRT merges are not, so a path on that list is reachable by both. This returns what the second child got. */
async function runCrossPluginReadProbe(
  fx: Fixture,
  reader: InstalledPlugin,
  absolutePath: string,
): Promise<ProbeAttempt> {
  const probePath = join(fx.root, "cross-plugin-probe.mjs");
  writeFileSync(
    probePath,
    `import { readFileSync } from "node:fs";
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
process.stdout.write("PROBE:" + JSON.stringify(attempt(() => readFileSync(${JSON.stringify(absolutePath)}, "utf-8"))) + "\\n");
`,
    "utf-8",
  );
  const child = await spawnConfinedPluginChild({
    pluginId: reader.pluginId,
    socketDir: resolvePluginSocketDir(reader.pluginDataDir),
    workerRunRoot: resolvePluginWorkerRunRoot(reader.pluginDataDir),
    envelope: derivePluginChildEnvelope({
      pluginId: reader.pluginId,
      pluginRoot: reader.pluginRoot,
      pluginDataDir: reader.pluginDataDir,
      configValue: () => undefined,
    }),
    launch: { kind: "entry", childEntryPath: probePath },
  });
  return await new Promise<ProbeAttempt>((resolve, reject) => {
    let stdout = "";
    child.link.input.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.link.input.on("end", () => {
      const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
      if (!line) {
        reject(new Error(`the cross-plugin probe produced no report; stdout was: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice("PROBE:".length)) as ProbeAttempt);
    });
    child.link.input.on("error", reject);
  });
}

/** Check both child bind and host connect: macOS denies loopback binding, while Linux may bind inside an unreachable network namespace.
 * Resolve on the live probe response, not process exit, so a successful listener can still be tested. */
async function runLoopbackBindProbe(
  fx: Fixture,
): Promise<{ child: { ok: boolean; port?: number; code?: string }; hostReach?: string }> {
  const probePath = join(fx.root, "loopback-bind-probe.mjs");
  writeFileSync(
    probePath,
    `import { createServer } from "node:http";
const server = createServer((_req, res) => res.end("reached"));
const report = (value) => process.stdout.write("PROBE:" + JSON.stringify(value) + "\\n");
server.on("error", (error) => report({ ok: false, code: error.code ?? error.name }));
server.listen(0, "127.0.0.1", () => report({ ok: true, port: server.address().port }));
// Stay up long enough for the host to try the port, then leave on our own so a
// refused bind and a successful one both end without the runner reaping us.
setTimeout(() => process.exit(0), 4000).unref?.();
`,
    "utf-8",
  );
  const child = await spawnConfinedPluginChild({
    pluginId: PLUGIN_ID,
    socketDir: resolvePluginSocketDir(fx.pluginDataDir),
    workerRunRoot: resolvePluginWorkerRunRoot(fx.pluginDataDir),
    envelope: baseEnvelope(fx),
    launch: { kind: "entry", childEntryPath: probePath },
  });
  try {
    const report = await new Promise<{ ok: boolean; port?: number; code?: string }>(
      (resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error(`the loopback probe never reported; stdout was: ${stdout}`)),
          15_000,
        );
        child.link.input.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
          const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
          if (!line) return;
          clearTimeout(timer);
          resolve(JSON.parse(line.slice("PROBE:".length)));
        });
        child.link.input.on("end", () => {
          clearTimeout(timer);
          reject(new Error(`the loopback probe exited without reporting; stdout was: ${stdout}`));
        });
        child.link.input.on("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    if (!report.ok || report.port === undefined) return { child: report };
    // The child says it is listening. Ask from OUT here, which is the only vantage point that can tell a bind apart from a reachable bind.
    const hostReach = await new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: report.port!, timeout: 2000 });
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve("ETIMEDOUT");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? error.name);
      });
    });
    return { child: report, hostReach };
  } finally {
    child.link.terminate("loopback bind probe finished");
  }
}


beforeEach(() => {
  fixture = makeFixture();
  previousAveHome = process.env.AVE_HOME;
  previousSandboxTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  // The deny floor is derived from `aveHome()`, so pointing it at the fixture is what makes `<AVE_HOME>/secrets`
  // a real denied path with a real file in it rather than an assertion about the developer's own home directory.
  process.env.AVE_HOME = fixture.aveHome;
  // Every child here is a plugin child: it is wrapped only while plugin-worker confinement was requested at boot and ASRT is active.
  setPluginWorkerConfinementRequestedAtBoot(true);
});

afterEach(async () => {
  if (!retainedSandbox && isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  if (previousSandboxTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = previousSandboxTmpdir;
  if (fixture) {
    rmSync(fixture.ungrantedTempDir, { recursive: true, force: true });
    if (process.platform !== "win32") {
      const legacyProbe = join(LEGACY_SHARED_TEMP_ROOT, fixture.ownTempName);
      if (existsSync(legacyProbe)) rmSync(legacyProbe, { force: true });
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
  fixture = undefined;
});

/** What the host decided, before any of it reaches a kernel. These drive `derivePluginChildEnvelope` directly because the interesting cases are REFUSALS, and a refusal has no child to probe. The approved-root
 * ceiling is read from the fixture's real `settings.json` through `readPermissionSettings()`, so what is under test is the host's own notion of "the user authorised this directory" rather than a copy of it. */
describe("the host decides how far a plugin child reaches", () => {
  it("keeps empty and undeclared sandbox authority at the base envelope", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: {},
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: () => fx.userRoot,
    });
    expect(envelope.read).toEqual(baseEnvelope(fx).read);
    expect(envelope.write).toEqual(baseEnvelope(fx).write);
    const undeclared = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: () => fx.userRoot,
    });
    expect(undeclared).toEqual(baseEnvelope(fx));
  });

  it("derives a new candidate from its declared authority and live approved root", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: CANDIDATE_MANIFEST.id,
      sandbox: CANDIDATE_MANIFEST.sandbox,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => key === "workspace" ? fx.userRoot : undefined,
    });
    expect(envelope.read).toEqual([...baseEnvelope(fx).read, join(fx.aveHome, "certs"), fx.userRoot]);
    expect(envelope.write).toEqual([...baseEnvelope(fx).write, fx.userRoot]);
    const rejected = () => derivePluginChildEnvelope({
      pluginId: CANDIDATE_MANIFEST.id,
      sandbox: CANDIDATE_MANIFEST.sandbox,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => key === "workspace" ? fx.userRootSibling : undefined,
    });
    expect(rejected).toThrow(PluginSandboxGrantError);
    expect(rejected).toThrow(/no workspace root the user approved covers it/);
  });

  it("keeps a declared read-only chosen directory out of the write jail", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: CANDIDATE_MANIFEST.id,
      sandbox: { read: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Read project data" }] },
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => key === "workspace" ? fx.userRoot : undefined,
    });
    expect(envelope.read).toContain(fx.userRoot);
    expect(envelope.write).not.toContain(fx.userRoot);
  });

  /** `PLUGIN_ID` declares no filesystem grants, so it gets the base envelope. */
  it("gives a plugin with no host decision exactly its own two directories", () => {
    const fx = fixture!;
    expect(
      derivePluginChildEnvelope({
        pluginId: PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: () => undefined,
      }),
    ).toEqual({
      read: [fx.pluginRoot, fx.pluginDataDir, socketDirOf(fx), workerRunRootOf(fx)],
      write: [fx.pluginDataDir, socketDirOf(fx)],
    });
  });

  it("adds declared host directories to READ only", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: () => undefined,
    });
    expect(envelope.read).toEqual([
      fx.pluginRoot,
      fx.pluginDataDir,
      socketDirOf(fx),
      workerRunRootOf(fx),
      join(fx.aveHome, "runtime"),
      join(fx.aveHome, "certs"),
    ]);
    // Host directories contribute to READ only. Its config key is unset here; the case below also checks that another grant cannot turn it writable.
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
  });

  it("admits a chosen directory the user approved, as read AND write", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? fx.userRoot : undefined),
    });
    expect(envelope.read).toContain(fx.userRoot);
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx), fx.userRoot]);
  });

  it("refuses a chosen directory no approved workspace root covers", () => {
    // THE ESCALATION THIS EXISTS TO STOP. `config.set` is a member the plugin holds, so a widening that trusted the
    // config value would let the plugin name its own envelope. The host names the KEY; the user names the ceiling.
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? fx.userRootSibling : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it("refuses the filesystem root, which no approval can cover", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? "/" : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it("refuses a sensitive path even when an approved root contains it", () => {
    // `~/.ave` is not itself a sensitive path, so the approval flow accepts it as a workspace root; and `~/.ave/secrets` is on the read-deny
    // floor that `allowRead` re-opens. Without this refusal the config key would be a way to hand the floor's own contents to a plugin child.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.aveHome);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) =>
          key === "indexStorageRoot" ? join(fx.aveHome, "secrets") : undefined,
      }),
    ).toThrow(/matches the sensitive-path rule/);
  });

  it("admits a chosen directory inside the plugin's own data dir with no approval", () => {
    // It adds nothing the child did not already hold, so requiring an approval would refuse the plugin's own default location.
    const fx = fixture!;
    const inside = join(fx.pluginDataDir, "index");
    const chosen: string[] = [];
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? inside : undefined),
      onUserChosenDirectory: (path) => chosen.push(path),
    });
    // Folded into the data directory the envelope already grants: no reach is added, and no root is left below `data/` for the plugin to re-point.
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
    expect(envelope.read).not.toContain(inside);
    expect(chosen).toEqual([]);
  });

  // Case folding follows `caseFoldForMatch`, which keys on the platform and not on a probe of the volume: macOS and Windows fold, Linux
  // compares exactly. So on Linux `DATA/` is a sibling of `data/`; still under the bundles directory; and the host must refuse it rather than fold it.
  const pathsFoldCase = process.platform === "darwin" || process.platform === "win32";

  it.runIf(pathsFoldCase)("folds a case-variant spelling of a directory inside data/ into data/, not into a root of its own", () => {
    // The spelling the config holds was decided "inside" on the case-folded canonical form and used to
    // reach the envelope verbatim, where a case-sensitive containment check took it for an independent root.
    const fx = fixture!;
    mkdirSync(join(fx.pluginDataDir, "work"), { recursive: true });
    const variant = join(dirname(fx.pluginDataDir), "DATA", "work");
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? variant : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
    expect(envelope.read).not.toContain(variant);
  });

  it.runIf(!pathsFoldCase)("refuses a case-variant sibling of data/ where paths compare exactly, since it sits in the bundles directory", () => {
    // Without folding, `DATA/work` is not inside `data/`; taking it as its own root would open a write grant inside the plugin bundles directory.
    const fx = fixture!;
    mkdirSync(join(fx.pluginDataDir, "work"), { recursive: true });
    const variant = join(dirname(fx.pluginDataDir), "DATA", "work");
    const derive = () =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? variant : undefined),
      });
    expect(derive).toThrow(PluginSandboxGrantError);
    expect(derive).toThrow(/resolves inside the directory that holds every installed plugin's bundle/);
  });

  it.runIf(process.platform === "win32")(
    "folds an 8.3 short spelling of a directory inside data/ into data/",
    (context) => {
      const base = mkdtempSync(join(tmpdir(), "ave-eight-dot-three-"));
      try {
        const pluginRoot = join(base, "plugins", "acme-plugin-with-a-long-name");
        const pluginDataDir = join(pluginRoot, "data");
        const longWork = join(pluginDataDir, "workspace-directory-long-name");
        mkdirSync(longWork, { recursive: true });
        // Verbatim: Node's argument quoting would hand cmd `\"` and the loop would echo its input untouched.
        const result = spawnSync("cmd.exe", [`/d /s /c "for %I in ("${longWork}") do @echo %~sI"`], {
          encoding: "utf8",
          windowsVerbatimArguments: true,
        });
        expect(result.status, result.stderr).toBe(0);
        const short = result.stdout.trim();
        if (short === longWork) context.skip("8.3 short names are unavailable on the fixture volume");
        const envelope = derivePluginChildEnvelope({
          pluginId: WIDENED_PLUGIN_ID,
          sandbox: WIDENED_SANDBOX,
          pluginRoot,
          pluginDataDir,
          configValue: (key) => (key === "indexStorageRoot" ? short : undefined),
        });
        expect(envelope.write).toEqual([pluginDataDir, resolvePluginSocketDir(pluginDataDir)]);
        // The grant half asks the same question: the short spelling of a root below `data\` is `data\`, so a grant on it names `data\`.
        expect(isGrantPathWithin(pluginDataDir, short)).toBe(true);
        expect(outermostContainingRoots([join(short, "segments"), short], [pluginDataDir, short])).toEqual([pluginDataDir]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("never grants writing on the host-only storage directory, on any platform", () => {
    // The Windows ACL holder is granted exactly `envelope.write` (plus the throwaway HOME), and an ACL
    // grant inherits; so this is the grant scope there as much as the Seatbelt/bwrap allow-list elsewhere.
    const fx = fixture!;
    const storage = resolvePluginHostStorageDir(fx.pluginDataDir);
    const derive = (chosen: string | undefined) => derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? chosen : undefined),
    });
    for (const chosen of [undefined, join(fx.pluginDataDir, "index"), fx.userRoot]) {
      expect(writeGrantsReachingHostStorage(fx.pluginDataDir, derive(chosen).write)).toEqual([]);
    }
    // Naming it, a path inside it, or the plugin root that holds it is refused.
    for (const chosen of [storage, join(storage, "auth"), fx.pluginRoot]) {
      expect(() => derive(chosen), chosen).toThrow();
    }
  });

  it("refuses a chosen directory under the plugin's own immutable runtime root", () => {
    // A `userChosenDirectory` grant carries WRITE. `pluginRoot` holds the bundle the next load imports and the bytes the install receipt is taken over, so admitting a value under it would hand the child a kernel-level write over its own code; the primitive the jail exists to remove rather than
    // detect. The plugin reaches this with one `config.set` call: the runtime root is a member of the context it is handed. The refusal names the install root because that is the granularity the subtraction has: every plugin's bundle is excluded on the same argument, not just this plugin's own.
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? join(fx.pluginRoot, "dist") : undefined),
      }),
    ).toThrow(/resolves inside the directory that holds every installed plugin's bundle/);
  });

  it("refuses that runtime root even when an approved workspace root covers it", () => {
    // THE ARM THE TEST ABOVE DOES NOT REACH. That one leaves the runtime root outside every approved root, so the refusal it observes could come from the approval half alone. In the production layout `pluginDataDir` is a CHILD of `pluginRoot` (`~/.ave/plugins/<id>/data`), so a
    // user who approves any workspace root at or above the install location pulls the runtime root back inside their own approvals; and an exclusion that lives only on the own-root half is then not an exclusion at all. The ceiling has two halves and the bundle has to be out of both.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.root);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? join(fx.pluginRoot, "dist") : undefined),
      }),
    ).toThrow(/resolves inside the directory that holds every installed plugin's bundle/);
  });

  it("refuses a chosen directory naming a declared read-only host root", () => {
    // THE HALF THE OWN-ROOT SUBTRACTION DOES NOT REACH. A `hostDirectory` grant resolves under `~/.ave` and carries READ; a `userChosenDirectory` value carries WRITE. Both land in the SAME envelope, so a value naming the host root the declaration
    // already granted turns the host's own READ decision into a write grant; and `~/.ave/runtime` is not on the deny floor, so nothing earlier in the derivation refuses it. What is under it is the interpreter this plugin's own worker is about to execute.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.root);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) =>
          key === "indexStorageRoot" ? join(fx.hostRuntimeDir, "python-envs") : undefined,
      }),
    ).toThrow(/resolves inside the host's own storage namespace/);
  });

  it.skipIf(!canCreateSymlinks())("refuses a declared host root even when it links out of the host's home", () => {
    // WHAT THE `~/.ave` SUBTRACTION ALONE DOES NOT REACH, and the reason the declared host directories are enumerated. A `hostDirectory` grant is a LEXICAL join onto `aveHome()`; the value it is compared against is canonical. Point the granted directory at another volume; the ordinary operational reason being that a
    // multi-gigabyte interpreter tree does not belong on the boot disk; and the two forms stop agreeing, so a home-shaped subtraction stops covering the grant. Both spellings are asked because the plugin can write either: the target's own path, and the link's, which is the one that is byte-identical to what the declaration itself joins.
    const fx = fixture!;
    const volume = join(fx.root, "volume");
    const movedRuntime = join(volume, "ave-runtime");
    mkdirSync(join(movedRuntime, "python-envs"), { recursive: true, mode: 0o700 });
    rmSync(fx.hostRuntimeDir, { recursive: true, force: true });
    symlinkSync(movedRuntime, fx.hostRuntimeDir);
    approveWorkspaceRoot(fx, volume);
    for (const spelling of [
      join(movedRuntime, "python-envs"),
      join(fx.hostRuntimeDir, "python-envs"),
    ]) {
      expect(() =>
        derivePluginChildEnvelope({
          pluginId: WIDENED_PLUGIN_ID,
          sandbox: WIDENED_SANDBOX,
          pluginRoot: fx.pluginRoot,
          pluginDataDir: fx.pluginDataDir,
          configValue: (key) => (key === "indexStorageRoot" ? spelling : undefined),
        }),
      ).toThrow(/host-owned catalog directory/);
    }
  });

  it.skipIf(!canCreateSymlinks())("refuses a chosen directory under a bundle root that is itself a symlink", () => {
    // The same divergence, on the other subtraction. The install-root entry is the LEXICAL parent of this plugin's bundle, which is the right way to name the directory every install lives in and the wrong way to
    // name a bundle that resolves somewhere else; so the bundle root is named on its own line too. Without that line an approved root covering the real bundle admits a write over the module the next load imports.
    const fx = fixture!;
    const elsewhere = join(fx.root, "bundles", WIDENED_PLUGIN_ID);
    mkdirSync(join(elsewhere, "dist"), { recursive: true, mode: 0o700 });
    const linkedRoot = join(fx.aveHome, "plugins", WIDENED_PLUGIN_ID);
    symlinkSync(elsewhere, linkedRoot);
    const linkedDataDir = join(linkedRoot, "data");
    mkdirSync(linkedDataDir, { recursive: true, mode: 0o700 });
    approveWorkspaceRoot(fx, fx.root);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: linkedRoot,
        pluginDataDir: linkedDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? join(elsewhere, "dist") : undefined),
      }),
    ).toThrow(/resolves inside the plugin's own bundle root/);
  });

  it("refuses a chosen directory inside ANOTHER plugin's bundle", () => {
    // The same argument the own-root subtraction rests on, applied to the party it was never applied to: a neighbour's `dist/` is the module the next load imports into the main process on that plugin's behalf, and the bytes its
    // install receipt is taken over. One approval broad enough to cover this plugin's own data directory covers every sibling under the same install root, so the approval half admits it unless the install root is subtracted as a whole.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.root);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? fx.neighbourBundleDir : undefined),
      }),
    ).toThrow(/resolves inside the directory that holds every installed plugin's bundle/);
  });

  it("still admits the plugin's own data dir when an approved root covers the host's home", () => {
    // The over-refusal pin for the two subtractions above. `pluginDataDir` is under BOTH of them; under the install root and under `~/.ave`; so a
    // subtraction asked before the data directory is admitted would refuse the plugin's own default index location and present that as containment.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.aveHome);
    const inside = join(fx.pluginDataDir, "index");
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? inside : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
  });

  it("still admits the plugin's own data dir when an approved root covers the runtime root", () => {
    // The refusal above must not swallow the data directory, which is itself under `pluginRoot`. If
    // it did, the fix would be a plugin that cannot write anywhere dressed as a containment result.
    const fx = fixture!;
    approveWorkspaceRoot(fx, fx.root);
    const inside = join(fx.pluginDataDir, "index");
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? inside : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
  });

  it.skipIf(!canCreateSymlinks())("refuses a chosen directory that reaches out of the data dir through a symlink", () => {
    // THE OTHER HALF OF THE SAME ESCALATION. The plugin writes its own data directory, so a containment test on spellings alone is one it can satisfy by planting the link and then
    // naming it: the value reads as inside the ceiling and denotes a directory the user never approved. The comparison is canonical, so the link resolves before containment is asked.
    const fx = fixture!;
    const link = join(fx.pluginDataDir, "reaches-elsewhere");
    symlinkSync(fx.userRootSibling, link);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? link : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it.skipIf(!canCreateSymlinks())("still admits a symlink that stays inside the plugin's own data dir", () => {
    // The canonical comparison must not refuse the legitimate case, or the fix would be a narrowing dressed as a containment result. Admitted means
    // folded into `data/`: the envelope already grants it, and a root of its own below `data/` would be one the plugin can re-point after admission.
    const fx = fixture!;
    const real = join(fx.pluginDataDir, "index-store");
    const link = join(fx.pluginDataDir, "index-link");
    mkdirSync(real, { recursive: true, mode: 0o700 });
    symlinkSync(real, link);
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? link : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
  });

  it("refuses a relative value rather than resolving it against the host's cwd", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? "index" : undefined),
      }),
    ).toThrow(/is not an absolute path/);
  });

  it("refuses a value that is not a string", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? 7 : undefined),
      }),
    ).toThrow(/expected a string, got number/);
  });

  it("treats an unset and an empty key as no widening, not as the host's cwd", () => {
    // `""` is the default several plugin config schemas ship for an unset string key, and `resolve("")` is the process working directory.
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      sandbox: WIDENED_SANDBOX,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? "" : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, socketDirOf(fx)]);
  });
});

describe("a plugin child is confined exactly as much as the host is", () => {
  it("starts unwrapped, and unmarked, while the host is not sandboxed", async () => {
    // The host runs without the OS sandbox on every platform by default, and its own tools run plain there. A plugin child follows the same setting: it is spawned as given, and because nothing wrapped it nothing
    // marks it confined; so the permission reviewer, which reads that marker, grants it no sandbox-based relaxation. The old rule here was to throw instead, which on Windows and Linux meant no plugin could start at all.
    const fx = fixture!;
    expect(isAsrtSandboxActive()).toBe(false);
    const probePath = join(fx.root, "unsandboxed-start-probe.mjs");
    writeFileSync(
      probePath,
      `process.stdout.write("PROBE:" + JSON.stringify({ started: true }) + "\\n");
setTimeout(() => process.exit(0), 2000).unref?.();
`,
      "utf-8",
    );
    const child = await spawnConfinedPluginChild({
      pluginId: PLUGIN_ID,
      socketDir: resolvePluginSocketDir(fx.pluginDataDir),
      workerRunRoot: resolvePluginWorkerRunRoot(fx.pluginDataDir),
      envelope: baseEnvelope(fx),
      launch: { kind: "entry", childEntryPath: probePath },
    });
    try {
      const report = await new Promise<{ started: boolean }>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error(`the probe never reported; stdout was: ${stdout}`)),
          15_000,
        );
        child.link.input.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
          const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
          if (!line) return;
          clearTimeout(timer);
          resolve(JSON.parse(line.slice("PROBE:".length)));
        });
        child.link.input.on("end", () => {
          clearTimeout(timer);
          reject(new Error(`the probe exited without reporting; stdout was: ${stdout}`));
        });
      });
      expect(report).toEqual({ started: true });
      expect(isPluginChildConfined(PLUGIN_ID)).toBe(false);
    } finally {
      child.link.terminate("unsandboxed start probe finished");
    }
  });

  it.skipIf(!canCreateSymlinks())("throws rather than granting a root that is a dangling symlink", async () => {
    // The containment answer for a path that does not resolve is the nearest existing ancestor plus the missing tail, which for a link planted inside the data dir is a path INSIDE the ceiling; correct, because that is where a write through it would land today. Where
    // the link would point once its target exists is unknowable, so the grant must not be handed to a kernel: materialisation refuses it and the plugin does not load. Note what fails here is the spawn, ahead of the wrap; an ASRT-inactive harness reaches this first.
    const fx = fixture!;
    const dangling = join(fx.pluginDataDir, "dangling");
    symlinkSync(join(fx.root, "target-that-does-not-exist"), dangling);
    await expect(
      spawnConfinedPluginChild({
        pluginId: PLUGIN_ID,
        socketDir: resolvePluginSocketDir(fx.pluginDataDir),
        workerRunRoot: resolvePluginWorkerRunRoot(fx.pluginDataDir),
        envelope: { read: [fx.pluginRoot, fx.pluginDataDir, dangling], write: [dangling] },
        launch: { kind: "entry", childEntryPath: writeProbeModule(fx) },
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(!canCreateSymlinks())("releases the throwaway sandbox HOME when a granted root cannot be created", async () => {
    // The refusal above is the DOCUMENTED fail-closed path, so it is the one that must not leave anything behind. `createSandboxProcessHome()` runs first and only `releaseSandboxState()` removes what it made, so a materialisation pass placed ahead of the `try` leaked one `mkdtemp`
    // directory per failed load; and `config.set` restarts the plugin, so a setting that keeps failing kept adding to the pile. Counted inside a private `TMPDIR` rather than against the machine's, so the assertion is about this spawn and not about whatever else the run has left in /tmp.
    const fx = fixture!;
    const dangling = join(fx.pluginDataDir, "dangling");
    symlinkSync(join(fx.root, "target-that-does-not-exist"), dangling);
    const previousTmpDir = process.env.TMPDIR;
    const privateTmpDir = mkdtempSync(join(tmpdir(), "sandbox-home-probe-"));
    process.env.TMPDIR = privateTmpDir;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          spawnConfinedPluginChild({
            pluginId: PLUGIN_ID,
            socketDir: resolvePluginSocketDir(fx.pluginDataDir),
            workerRunRoot: resolvePluginWorkerRunRoot(fx.pluginDataDir),
            envelope: { read: [fx.pluginRoot, fx.pluginDataDir, dangling], write: [dangling] },
            launch: { kind: "entry", childEntryPath: writeProbeModule(fx) },
          }),
        ).rejects.toThrow(/ENOENT/);
      }
      expect(readdirSync(privateTmpDir)).toEqual([]);
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
      rmSync(privateTmpDir, { recursive: true, force: true });
    }
  });
});

describe("the confined child, against the real sandbox", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "is denied the host's secrets and the paths outside its write jail, and keeps its own",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const report = await runProbe(fx);

      // The assertion the whole exercise exists for. Not "we called spawnConfinedChild"; an actual `readFileSync` of an actual secret file that actually failed.
      expect(report.readSecret.ok, JSON.stringify(report.readSecret)).toBe(false);
      expect(report.readSecret.value).toBeUndefined();

      // The write jail, in both directions.
      expect(report.writeOutside.ok, JSON.stringify(report.writeOutside)).toBe(false);
      expect(report.writeSecrets.ok, JSON.stringify(report.writeSecrets)).toBe(false);
      // …and it stops at `pluginDataDir` rather than covering everything the child can reach: `pluginRoot` is READABLE, because the child loads its own code out of it, and NOT writable, because a plugin that
      // could rewrite its runtime root could rewrite the bytes its own manifest hash was taken over. Read and write are separate grants; asserting only the paths that are denied to both would not show that.
      expect(report.readOwnCode.ok, JSON.stringify(report.readOwnCode)).toBe(true);
      expect(report.readOwnCode.value).toBe(PLUGIN_CODE_BYTES);
      expect(report.writeOwnCode.ok, JSON.stringify(report.writeOwnCode)).toBe(false);
      expect(existsSync(join(fx.pluginRoot, "smuggled.js"))).toBe(false);
      // The host-only storage directory: no write, no new name, no link, no move in, and no replacing the directory itself (or
      // putting a link beside it); so no component of a storage path can be re-pointed between the host's check and its syscall.
      for (const [op, attempt] of Object.entries(report.hostStorage)) {
        expect(attempt.ok, `${op}: ${JSON.stringify(attempt)}`).toBe(false);
      }
      const hostStorageDir = resolvePluginHostStorageDir(fx.pluginDataDir);
      expect(readdirSync(hostStorageDir)).toEqual(["stored.json"]);
      expect(readFileSync(join(hostStorageDir, "stored.json"), "utf-8")).toBe(HOST_STORED_TEXT);
      expect(existsSync(`${hostStorageDir}-moved`)).toBe(false);
      expect(existsSync(join(fx.pluginRoot, "storage-link"))).toBe(false);
      expect(readFileSync(join(fx.pluginDataDir, "own-data.txt"), "utf-8")).toBe("the plugin's own bytes");
      // The third answer, and the one a source census reads as success: HOME is SUBSTITUTED, so a plugin that roots its state at `homedir()` is neither denied nor durable. The write SUCCEEDS; and it lands in a throwaway that is neither
      // the user's home nor any granted path of this plugin's, which `createSandboxProcessHome` removes when the child exits. Asserted because "it worked" is the reading that admits a plugin whose state silently resets on every start.
      expect(report.childHome).not.toBe(homedir());
      expect(report.childHome.startsWith(fx.pluginRoot)).toBe(false);
      expect(report.childHome.startsWith(fx.pluginDataDir)).toBe(false);
      expect(report.writeChildHome.ok, JSON.stringify(report.writeChildHome)).toBe(true);

      // The confinement primitive adds a durable per-plugin temp write root beyond the spawn's explicit envelope.
      // Read-deny the shared parent so another plugin cannot read those bytes.
      const ownTemp = join(report.childTmpdir, fx.ownTempName);
      const ownTempDir = join(appOwnedSandboxTempRoot(), sandboxTempPrincipalDirName({ kind: "plugin", id: PLUGIN_ID }));
      expect(realpathSync(report.childTmpdir), "the child's TMPDIR is not its plugin's temp directory")
        .toBe(realpathSync(ownTempDir));
      expect(report.childTmpdir).not.toBe(report.childHome);
      expect(report.childTmpdir.startsWith(fx.pluginDataDir)).toBe(false);
      expect(report.childTmpdir.startsWith(report.childHome)).toBe(false);
      expect(report.writeChildTmpdir.ok, JSON.stringify(report.writeChildTmpdir)).toBe(true);
      // Durable, which is what separates this outcome from the `homedir()` one: the bytes are still there, read from the unconfined host.
      expect(readFileSync(ownTemp, "utf-8")).toBe(OWN_TEMP_BYTES);

      // …and that path is NOT shared. A second confined child, from a second plugin with its own
      // `pluginRoot` and `pluginDataDir`, cannot read the first one's bytes, which the host just read above.
      const crossPluginRead = await runCrossPluginReadProbe(
        fx,
        installPlugin(fx, "a-second-confined-plugin"),
        ownTemp,
      );
      expect(crossPluginRead.ok, JSON.stringify(crossPluginRead)).toBe(false);
      expect(crossPluginRead.value).toBeUndefined();

      // An ordinary shared-temp path is not an implicit write grant. The host created both directory and file
      // with writable permissions, so refusal cannot be explained by a missing parent or filesystem ownership.
      const deniedWriteCode = process.platform === "linux" ? "EROFS" : "EPERM";
      expect(report.writeUngrantedTemp.ok, JSON.stringify(report.writeUngrantedTemp)).toBe(false);
      expect(report.writeUngrantedTemp.code).toBe(deniedWriteCode);
      expect(readFileSync(fx.ungrantedTempFile, "utf-8")).toBe(SHARED_TEMP_BYTES);
      const sharedTempRead = await runCrossPluginReadProbe(
        fx,
        installPlugin(fx, "a-shared-temp-reader"),
        fx.ungrantedTempFile,
      );
      expect(sharedTempRead.ok, JSON.stringify(sharedTempRead)).toBe(true);
      expect(sharedTempRead.value).toBe(SHARED_TEMP_BYTES);

      // Do not create, reserve or replace a shared global path on the host. Probe its literal name with a unique file; a writable existing parent
      // gives a policy-error control. Missing or inaccessible parents cannot establish that control; the independent ordinary-temp case above can.
      expect(report.writeLegacySharedTemp.ok, JSON.stringify(report.writeLegacySharedTemp)).toBe(false);
      let legacyParentWritable = false;
      try {
        if (statSync(LEGACY_SHARED_TEMP_ROOT).isDirectory()) {
          accessSync(LEGACY_SHARED_TEMP_ROOT, constants.W_OK);
          legacyParentWritable = true;
        }
      } catch { /* The global entry may be missing or belong to another user. */ }
      if (legacyParentWritable) expect(report.writeLegacySharedTemp.code).toBe(deniedWriteCode);
      expect(existsSync(join(LEGACY_SHARED_TEMP_ROOT, fx.ownTempName))).toBe(false);

      // Nothing the host DID NOT widen this plugin with is reachable; the corporate CA the deny floor covers, and a directory the user
      // approved for the host's own tools. Asserted on the unwidened plugin so the widened case below is a difference rather than a claim.
      expect(report.readCa.ok, JSON.stringify(report.readCa)).toBe(false);
      expect(report.writeUserRoot.ok, JSON.stringify(report.writeUserRoot)).toBe(false);

      // …and the plugin still works, which is the other half of the claim.
      expect(report.readOwnData.ok, JSON.stringify(report.readOwnData)).toBe(true);
      expect(report.readOwnData.value).toBe("the plugin's own bytes");
      expect(report.writeOwnData.ok, JSON.stringify(report.writeOwnData)).toBe(true);
      expect(readFileSync(join(fx.pluginDataDir, "written-by-child.txt"), "utf-8")).toBe(
        "hello",
      );

      // This used to assert the environment variable alone, under a comment saying `electron` was unreachable — a
      // control claimed in prose beside code that never checked it. The variable is the MECHANISM; these are the answers.
      expect(report.electronRunAsNode).toBe("1");
      // The process is Electron: `process.execPath` is the Electron binary in production and, because this repository runs its own tests under that binary, here too. So this is not a
      // Node-versus-Electron artifact of the runner; and the version being present while the API is not is the trap: a plugin gating on `process.versions.electron` gets YES and walks into the call below.
      expect(report.electronVersion).not.toBeNull();
      expect(report.requireElectron, JSON.stringify(report.requireElectron)).toMatchObject({
        ok: false,
        code: "MODULE_NOT_FOUND",
      });
      // And shipping the package does not answer it: its entry exports the binary's PATH as a string, so `BrowserWindow` is
      // `undefined` and any guard on it throws. Both halves are asserted because a plugin author hitting the first will try the second.
      expect(
        report.requirePackagedElectron,
        JSON.stringify(report.requirePackagedElectron),
      ).toMatchObject({ ok: true, module: { kind: "string", browserWindow: "undefined" } });
      // And the two ESM forms, which do NOT answer the way `require` does. Asserted separately rather than left to the require case, because the three differ in WHERE the plugin breaks and a note claiming one
      // denial for all three would be describing something untrue: `import()` RESOLVES, to a namespace whose `BrowserWindow` is `undefined`, so an ESM plugin reading it off the namespace fails only when it calls…
      expect(report.importElectron, JSON.stringify(report.importElectron)).toMatchObject({
        ok: true,
        module: { kind: "object", browserWindow: "undefined" },
        // …and the namespace's `default`, which is where a CJS module reached through the ESM resolver would carry the API, is an EMPTY object. This
        // is the arm that would go red if the ESM path ever started handing back the real `electron`, which the namespace's own keys would not show.
        defaultKeys: [],
        defaultBrowserWindow: "undefined",
      });
      // …while a NAMED import of the same specifier never links at all.
      expect(
        report.namedImportElectron,
        JSON.stringify(report.namedImportElectron),
      ).toMatchObject({ ok: false, code: "SyntaxError" });
    },
    60_000,
  );
});

/** The widening, end to end: the declared authority decides, the derivation resolves, the wrap grants, and the kernel is asked. The point of running the WHOLE chain rather than handing the spawn a hand-built envelope is that the interesting claims are about the derivation's output;
 * that a `hostDirectory` row re-opens a path the deny floor closed, that a `userChosenDirectory` row admits the user's directory and only it, and that neither one turns a read grant into a write. A fixture envelope would prove the wrap works and say nothing about what the host decided. */
describe("a child the host widened reaches exactly what the host widened it with", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "confines a new candidate to its declared trust anchor and approved directory",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const envelope = derivePluginChildEnvelope({
        pluginId: CANDIDATE_MANIFEST.id,
        sandbox: CANDIDATE_MANIFEST.sandbox,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => key === "workspace" ? fx.userRoot : undefined,
      });
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const report = await runProbe(fx, envelope);
      expect(report.readCa).toMatchObject({ ok: true, value: CA_TEXT });
      expect(report.writeUserRoot.ok).toBe(true);
      expect(report.writeCa.ok).toBe(false);
      expect(report.writeUserRootSibling.ok).toBe(false);
      expect(report.readSecret.ok).toBe(false);
      expect(report.writeOutside.ok).toBe(false);
    },
    60_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps a declared indexer's grants without opening adjacent paths",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const envelope = derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        sandbox: WIDENED_SANDBOX,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        // The value is admitted because the fixture's settings file lists it as a user-approved workspace root.
        configValue: (key) =>
          key === "indexStorageRoot"
            ? fx.userRoot
            : key === "workspace"
              ? fx.pendingWorkspace
              : undefined,
      });
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const report = await runProbe(fx, envelope);

      // The two widenings, proven by the syscalls they exist for.
      expect(report.readCa.ok, JSON.stringify(report.readCa)).toBe(true);
      expect(report.readCa.value).toBe(CA_TEXT);
      expect(report.writeUserRoot.ok, JSON.stringify(report.writeUserRoot)).toBe(true);
      expect(readFileSync(join(fx.userRoot, "index.bin"), "utf-8")).toBe("index");

      // …and nothing beside them. The CA stays UNWRITABLE, and the honest attribution is that the write-deny floor takes precedence over `allowWrite`; so this holds even for a grant that mistakenly
      // asked for write, which is why it is asserted here rather than assumed. That a `hostDirectory` grant is read-only is a property of the derivation and is proven above, against the envelope it returns.
      expect(report.writeCa.ok, JSON.stringify(report.writeCa)).toBe(false);
      // The sibling shares the user root's name as a string prefix and is not inside it, which is the case a `startsWith` containment check admits.
      expect(
        report.writeUserRootSibling.ok,
        JSON.stringify(report.writeUserRootSibling),
      ).toBe(false);
      // A granted root that did not exist is CREATED by the spawn rather than dropped from the grant. Without that the child gets an envelope smaller than the host decided and is told nothing about it:
      // here that surfaces as this `ENOENT`, and on Linux as an allow path ASRT skips out of the bwrap argv with a debug line. Neither raises, which is why the materialisation is asserted rather than assumed.
      expect(
        report.writePendingWorkspace.ok,
        JSON.stringify(report.writePendingWorkspace),
      ).toBe(true);

      // The floor the widening pierced for `certs` is otherwise untouched.
      expect(report.readSecret.ok, JSON.stringify(report.readSecret)).toBe(false);
      expect(report.writeOutside.ok, JSON.stringify(report.writeOutside)).toBe(false);
      expect(report.writeSecrets.ok, JSON.stringify(report.writeSecrets)).toBe(false);
    },
    60_000,
  );
});

/** The pilot's own tool, invoked out of process AND confined, through the production factory. This is the claim the two stages make together, and neither of the other suites makes it: `out-of-process-plugin.test.ts` runs the real protocol over fake pipes, the probe above
 * runs a real sandbox around a fake protocol, and only here are both real at once. It is also the only test that exercises the BUNDLED child entry; the stdout claim, the entry-module guard, and the ESM bundle boundary are all things the TypeScript source cannot prove. */
describe("the pilot's tools, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "invokes a declared tool in a sandboxed child and returns the plugin's own value",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const repoRoot = repositoryRoot();
      const childEntryPath = pluginChildEntryPath();

      // The plugin lives inside the child's own read carve-out, which is where an installed plugin lives in production.
      const entryPath = join(fx.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { readFileSync } from "node:fs";
export const createPlugin = async (context) => ({
  handlers: {
    pilot_probe: async () => ({
      ownData: readFileSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, "utf-8"),
      secretRead: (() => { try { return readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8"); } catch (error) { return "DENIED:" + (error.code ?? error.name); } })(),
      fromHost: await context.hostApi.callLlm("ping"),
      installed: context.hostApi.getInstalledPluginIds(),
    }),
  },
});
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: PLUGIN_ID,
          name: "Sample Assistant",
          version: "0.10.14",
          entry: "plugin.mjs",
          requires: { hostProtocol: "4" },
          description: "the pilot, confined",
          tools: [
            {
              name: "pilot_probe",
              description: "report what the confined child could reach",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        } as PluginManifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
      });
      const hostApi = {
        callLlm: async () => "the host answered",
        getInstalledPluginIds: () => ["sampleassistant"],
        onPluginsChanged: () => () => undefined,
        config: { get: () => undefined, set: async () => undefined, onChange: () => () => undefined },
      } as unknown as PluginHostApi;
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginSocketDir: resolvePluginSocketDir(fx.pluginDataDir),
        pluginRoot: fx.pluginRoot,
        hostRoot: repoRoot,
        pluginDataDir: fx.pluginDataDir,
        userHome: homedir(),
        aveHome: aveHome(),
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        const result = (await instance.handlers.pilot_probe!()) as Record<string, unknown>;
        // The plugin's own structured value, out of a different process.
        expect(result.ownData).toBe("the plugin's own bytes");
        expect(result.fromHost).toBe("the host answered");
        expect(result.installed).toEqual(["sampleassistant"]);
        // …and the same process could not read the host's secrets while doing it.
        expect(String(result.secretRead)).toMatch(/^DENIED:/);
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );
});

/** The host protocol's process rules, and one golden conversation, against a REAL confined child (plugin-hostapi-protocol.md §2.5, §9.4). `host-protocol-golden.test.ts` pins the frames over paired streams, which proves nothing about the
 * process: that the child leaves when the host does, that nothing but protocol reaches its stdout, and that the bundle which ships speaks the same conversation the in-memory runtime recorded. Those three need the bundled entry running in its sandbox. */
describe("the host protocol, spoken by a real confined child", () => {
  /** A complete plugin: its manifest, its entry and its recorded transcript. */
  const MEETING_GOLDEN = fileURLToPath(
    new URL("./fixtures/host-protocol/4/plugins/meeting/", import.meta.url),
  );

  /** The plugin's own tool results in a recorded transcript, by tool name. */
  function recordedToolResults(transcript: string): Record<string, unknown> {
    const calls = new Map<unknown, string>();
    const results: Record<string, unknown> = {};
    for (const line of transcript.trim().split("\n")) {
      const { from, frame } = JSON.parse(line) as {
        from: string;
        frame: { id?: unknown; method?: string; params?: { name?: string }; result?: { _meta?: Record<string, unknown> } };
      };
      if (from === "host" && frame.method === "tools/call") calls.set(frame.id, frame.params!.name!);
      else if (from === "child" && calls.has(frame.id) && frame.result) {
        results[calls.get(frame.id)!] = frame.result._meta?.["ave/rawResult"];
      }
    }
    return results;
  }

  function contextFor(fx: Fixture, plugin: InstalledPlugin, hostApi: PluginHostApi): PluginRuntimeContext {
    return {
      pluginId: plugin.pluginId,
      pluginSocketDir: resolvePluginSocketDir(plugin.pluginDataDir),
      pluginRoot: plugin.pluginRoot,
      hostRoot: fx.hostRoot,
      pluginDataDir: plugin.pluginDataDir,
      userHome: homedir(),
      aveHome: aveHome(),
      config: {},
      log: () => undefined,
      hostApi,
    };
  }

  /** A one-tool plugin whose code is `body`, installed where a real one lives. */
  function installOneToolPlugin(fx: Fixture, pluginId: string, body: string): {
    readonly plugin: InstalledPlugin;
    readonly entryPath: string;
    readonly manifest: PluginManifest;
  } {
    const plugin = installPlugin(fx, pluginId);
    const entryPath = join(plugin.pluginRoot, "entry.mjs");
    writeFileSync(entryPath, body, "utf-8");
    return {
      plugin,
      entryPath,
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        requires: { hostProtocol: "4" },
        description: "a child the protocol's process rules are measured on",
        tools: [{ name: "speak", description: "speak", inputSchema: { type: "object", properties: {} } }],
      },
    };
  }

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "runs the meeting golden fixture and answers exactly as its recorded transcript does",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const plugin = installPlugin(fx, "meeting");
      const childEntryPath = pluginChildEntryPath();
      // Copied into the plugin's own root, which is where an installed entry lives and what the child's read grant covers.
      const entryPath = join(plugin.pluginRoot, "entry.mjs");
      copyFileSync(join(MEETING_GOLDEN, "entry.mjs"), entryPath);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(MEETING_GOLDEN, "plugin.json"), "utf-8")),
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      // The host the transcript was recorded against, neighbourhood included.
      const host = createRecordingHost();
      // Observed for the resource record only (decision 41): the reference runtime's cost beside the Python smoke's.
      let spawnedAt = 0;
      let tree: Promise<TreeMeasurement> | undefined;
      const factory = createOutOfProcessPluginFactory({
        manifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
        observeChild: (child) => {
          spawnedAt = performance.now();
          tree = sampleProcessTree(child.pid!, child.exited);
        },
      });
      const instance = await factory(contextFor(fx, plugin, host.api));
      const spawnToConstructMs = Math.round(performance.now() - spawnedAt);
      try {
        const exercised = await instance.handlers.exercise_host!();
        // Pushed down the same pipe the next call travels, so the child has delivered every one of them before it runs `report_host`.
        host.fireAll();
        const reported = await instance.handlers.report_host!();
        expect({ exercise_host: exercised, report_host: reported }).toEqual(
          recordedToolResults(readFileSync(join(MEETING_GOLDEN, "expected.jsonl"), "utf-8")),
        );
      } finally {
        await instance.stop?.();
      }
      const measured = await tree!;
      reportSmoke("confined measurement", {
        platform: process.platform,
        fixture: "meeting",
        spawnToConstructMs,
        treePeakRssBytes: measured.peakRssBytes,
        treeSamples: measured.samples,
      });
      expect(measured.samples).toBeGreaterThan(0);
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "exits within five seconds of its stdin closing, with no request from the host",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const childEntryPath = pluginChildEntryPath();
      const { plugin, entryPath, manifest } = installOneToolPlugin(
        fx,
        "stdinprobe",
        // A timer, as a plugin with a watcher or a poll loop holds one: without it the event loop drains when stdin
        // ends and the child leaves whether or not it implements the rule, which would make this case prove nothing.
        `export const createPlugin = async () => {
  setInterval(() => undefined, 1_000);
  return { handlers: { speak: async () => "spoke" } };
};
`,
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      let observed: ObservedPluginChild | undefined;
      // The production factory's own spawn, observed after the wrap: the case ends the child's stdin and watches it exit, and touches nothing else.
      const factory = createOutOfProcessPluginFactory({
        manifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
        observeChild: (child) => {
          observed = child;
        },
      });
      const instance = await factory(contextFor(fx, plugin, createValidationHost().api));
      try {
        await expect(instance.handlers.speak!()).resolves.toBe("spoke");
        expect(observed!.pid).toEqual(expect.any(Number));
        // The host dying looks like this from the child: its stdin ends. No `stop`, no signal; a host that crashed sends neither.
        observed!.endInput();
        const outcome = await Promise.race([
          observed!.exited.then(() => "exited"),
          new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 5_000)),
        ]);
        expect(outcome).toBe("exited");
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "puts nothing on stdout but protocol frames, whatever the plugin prints",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const childEntryPath = pluginChildEntryPath();
      // Both ways a plugin reaches stdout, at import, in the factory and in a tool: a stray line anywhere joins the next frame's line and takes that frame with it.
      const { plugin, entryPath, manifest } = installOneToolPlugin(
        fx,
        "stdoutprobe",
        `console.log("printed at import");
process.stdout.write("written at import\\n");
export const createPlugin = async () => {
  console.log("printed in the factory");
  return {
    handlers: {
      speak: async () => {
        console.log("printed in a tool");
        process.stdout.write("written in a tool, with no newline");
        return "spoke";
      },
    },
  };
};
`,
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      let stdout = "";
      // The production factory's own spawn, observed after the wrap and before the protocol starts, so every byte the child writes is collected.
      const factory = createOutOfProcessPluginFactory({
        manifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
        observeChild: (child) => {
          child.onStdout((chunk) => {
            stdout += chunk.toString("utf-8");
          });
        },
      });
      const instance = await factory(contextFor(fx, plugin, createValidationHost().api));
      try {
        // Bounded: a stray line that swallowed the reply would otherwise hang the call until the case times out, and say nothing about why.
        const spoke = await Promise.race([
          instance.handlers.speak!(),
          new Promise((resolve) => setTimeout(() => resolve("no reply: a frame was lost"), 10_000)),
        ]);
        expect(spoke).toBe("spoke");
      } finally {
        await instance.stop?.();
      }
      const lines = stdout.split("\n");
      // The stream ends on a newline, so the last element is the empty tail.
      expect(lines.at(-1)).toBe("");
      const frames = lines.slice(0, -1);
      expect(frames.length).toBeGreaterThan(0);
      for (const line of frames) {
        expect(JSON.parse(line), line).toMatchObject({ jsonrpc: "2.0" });
      }
    },
    120_000,
  );
});

/** The members §3.2 calls lossy or stateful, exercised by a REAL confined child. `host-api-service-members.test.ts` drives the same members across a real dispatcher and a real child runtime over an in-memory channel, which proves the marshalling and
 * proves nothing about the jail. This proves both at once, and it is the only place that can: the question "can the plugin reach the secret it was not handed" has two answers; one from the gate and one from the sandbox; and only a real process has both. */
describe("the lossy and stateful members, across a real confined boundary", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "hands over what the gate grants, refuses what it does not, and cannot be reached around",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const repoRoot = repositoryRoot();
      const childEntryPath = pluginChildEntryPath();

      const entryPath = join(fx.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { readFileSync } from "node:fs";
const attempt = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, code: error.code ?? error.name, message: String(error.message ?? "") }; }
};
export const createPlugin = async (context) => {
  const api = context.hostApi;
  return {
    handlers: {
      // What the gate hands over, versus what the filesystem does.
      probe_credentials: async () => ({
        granted: await api.getSecret("granted"),
        denied: await api.getSecret("denied"),
        directRead: await attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
      }),
      // A lease: only the opaque handle crosses into the child.
      probe_lease: async () => {
        const lease = await api.resolveApiKey({ purpose: "llm" });
        const response = await api.hostFetch("https://example.invalid/lease", { auth: { lease: lease.leaseId } });
        await lease.release();
        return { ok: lease.ok, vendor: lease.vendor, exposure: lease.exposure, leaseId: lease.leaseId, status: response.status };
      },
      // A Response with a streaming body and bytes no text codec survives.
      probe_fetch: async () => {
        const response = await api.hostFetch("https://example.invalid/bytes");
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, header: response.headers.get("x-ave"), bytes: [...bytes] };
      },
      // Delegation: the plugin asks the host to spawn something that can reach
      // further than the plugin process may.
      probe_worker_escape: async () => await attempt(() => api.spawnWorker({
        workerId: "escape",
        command: "/bin/sh",
        allowWritePaths: ["/"],
      })),
      probe_worker_allowed: async () => {
        const worker = await api.spawnWorker({
          workerId: "indexer",
          command: "/usr/bin/true",
          allowReadPaths: [context.pluginRoot],
          allowWritePaths: [context.pluginDataDir],
        });
        return {
          socketPath: worker.socketPath,
          pid: worker.pid,
          // A live handle would carry these. An id carries none of them.
          fields: Object.keys(worker).sort(),
        };
      },
      probe_worker_chosen: async () => {
        const worker = await api.spawnWorker({
          workerId: "chosen",
          command: "/usr/bin/true",
          allowWritePaths: [api.config.get("workspace")],
        });
        return { pid: worker.pid };
      },
      probe_worker_sibling: async () => await attempt(() => api.spawnWorker({
        workerId: "sibling",
        command: "/usr/bin/true",
        allowWritePaths: [${JSON.stringify(fx.userRootSibling)}],
      })),
      probe_config: async () => api.config.get("watched") ?? null,
    },
  };
};
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const release = vi.fn();
      const spawnWorker = vi.fn(async () => ({
        socketPath: "/run/indexer.sock",
        pid: 31337,
        stop: () => undefined,
        onStdout: () => undefined,
        onStderr: () => undefined,
        onExit: () => undefined,
      }));
      const configValues = new Map<string, unknown>([["watched", "before"], ["workspace", fx.userRoot]]);
      const configListeners = new Set<(value: unknown) => void>();
      const hostApi = {
        // The four-tier gate, standing in for its verdict: one key granted, one refused. The boundary's job is to carry the verdict, not to make it.
        getSecret: async (key: string) => (key === "granted" ? SECRET_TEXT : null),
        resolveApiKey: async () => ({
          ok: true as const,
          vendor: "openai" as const,
          exposure: "lease" as const,
          leaseId: "lease_confined_probe",
          onClosed: () => () => undefined,
          release,
        }),
        hostFetch: async () =>
          new Response(new Uint8Array([0x00, 0x80, 0xff, 0x41]), {
            status: 207,
            headers: { "x-ave": "from-the-host" },
          }),
        spawnWorker,
        getInstalledPluginIds: () => ["sampleassistant"],
        onPluginsChanged: () => () => undefined,
        config: {
          get: (key: string) => configValues.get(key),
          set: async () => undefined,
          onChange: (_key: string, callback: (value: unknown) => void) => {
            configListeners.add(callback);
            return () => configListeners.delete(callback);
          },
        },
      } as unknown as PluginHostApi;

      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: PLUGIN_ID,
          name: "Sample Assistant",
          version: "0.10.14",
          entry: "plugin.mjs",
          requires: { hostProtocol: "4" },
          description: "the lossy members, confined",
          configSchema: { type: "object", properties: { watched: { type: "string" }, workspace: { type: "string" } } },
          sandbox: CANDIDATE_MANIFEST.sandbox,
          tools: [
            "probe_credentials",
            "probe_lease",
            "probe_fetch",
            "probe_worker_escape",
            "probe_worker_allowed",
            "probe_worker_chosen",
            "probe_worker_sibling",
            "probe_config",
          ].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        } as PluginManifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginSocketDir: resolvePluginSocketDir(fx.pluginDataDir),
        pluginRoot: fx.pluginRoot,
        hostRoot: repoRoot,
        pluginDataDir: fx.pluginDataDir,
        userHome: homedir(),
        aveHome: aveHome(),
        config: { watched: "before", workspace: fx.userRoot },
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      try {
        // ── getSecret ──────────────────────────────────────────────────────
        const credentials = (await instance.handlers.probe_credentials!()) as {
          granted: string | null;
          denied: string | null;
          directRead: { ok: boolean; value?: string };
        };
        // The value DOES cross. The gate is the control, and a plugin the gate granted holds the same string it would hold in-process.
        expect(credentials.granted).toBe(SECRET_TEXT);
        // …and one it did not is `null`, not a throw and not a stale value.
        expect(credentials.denied).toBeNull();
        // The half isolation adds: the same process cannot reach around the gate to the file, so the gate's verdict is the ONLY way in.
        expect(credentials.directRead.ok).toBe(false);
        expect(credentials.directRead.value).toBeUndefined();

        // ── resolveApiKey ──────────────────────────────────────────────────
        const lease = (await instance.handlers.probe_lease!()) as {
          ok: boolean;
          vendor: string;
          exposure: string;
          leaseId: string;
          status: number;
        };
        expect(lease).toMatchObject({ ok: true, vendor: "openai", exposure: "lease", leaseId: "lease_confined_probe", status: 207 });
        expect(JSON.stringify(lease)).not.toContain("sk-lease-credential");
        expect(release).toHaveBeenCalledTimes(1);

        // ── hostFetch ──────────────────────────────────────────────────────
        const fetched = (await instance.handlers.probe_fetch!()) as {
          status: number;
          header: string;
          bytes: number[];
        };
        expect(fetched.status).toBe(207);
        expect(fetched.header).toBe("from-the-host");
        // A NUL, a lone continuation byte and a 0xFF. A text codec replaces all three with U+FFFD and reports success.
        expect(fetched.bytes).toEqual([0x00, 0x80, 0xff, 0x41]);

        // ── spawnWorker ────────────────────────────────────────────────────
        const escape = (await instance.handlers.probe_worker_escape!()) as {
          ok: boolean;
          message: string;
        };
        expect(escape.ok).toBe(false);
        expect(escape.message).toMatch(/outside the plugin's own confinement/);
        // Refused at the boundary, so the supervisor never saw it. A refusal that still spawned would be no refusal.
        expect(spawnWorker).not.toHaveBeenCalled();

        const spawned = (await instance.handlers.probe_worker_allowed!()) as {
          socketPath: string;
          pid: number;
          fields: string[];
        };
        expect(spawnWorker).toHaveBeenCalledTimes(1);
        expect(spawned.socketPath).toBe("/run/indexer.sock");
        expect(spawned.pid).toBe(31337);
        // The plugin holds an id and two scalars behind four local methods; nothing that could be a `ChildProcess`.
        expect(spawned.fields).toEqual([
          "onExit",
          "onStderr",
          "onStdout",
          "pid",
          "socketPath",
          "stop",
        ]);

        const chosen = (await instance.handlers.probe_worker_chosen!()) as { pid: number };
        expect(chosen.pid).toBe(31337);
        expect(spawnWorker).toHaveBeenCalledTimes(2);
        expect(spawnWorker).toHaveBeenLastCalledWith(expect.objectContaining({
          allowWritePaths: [fx.userRoot],
        }));
        const sibling = (await instance.handlers.probe_worker_sibling!()) as { ok: boolean; message: string };
        expect(sibling.ok).toBe(false);
        expect(sibling.message).toMatch(/outside the plugin's own confinement/);
        expect(spawnWorker).toHaveBeenCalledTimes(2);

        // ── config.get, re-pushed ──────────────────────────────────────────
        await expect(instance.handlers.probe_config!()).resolves.toBe("before");
        configValues.set("watched", "after");
        for (const listener of configListeners) listener("after");
        // The child answers `config.get` from a snapshot, so this is the whole difference between a current answer and a permanently stale one.
        await expect(instance.handlers.probe_config!()).resolves.toBe("after");
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );
});

/** Exercise recorder boundaries through the production factory: desktop APIs and legacy host-root moves must be refused, while private temp sweeps remain usable.
 * Check granted secrets, refused secrets, and raw secret-file denial together, plus inherited confinement in spawned binaries.
 * An outside-root listing must precede the real rename so the case measures write refusal rather than missing fixtures. */
describe("a refused candidate's members, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "carries the gate's verdict both ways, and refuses the window its primary tool opens",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const plugin = installPlugin(fx, "meeting");
      const childEntryPath = pluginChildEntryPath();

      // The un-migrated state the plugin's own guard requires before it will attempt the move at all, planted from the HOST side because a confined child could
      // not have created it. Without this the handler below would exercise a `mkdir` the plugin never performs and report the same denial for a different reason.
      const legacyDir = join(fx.hostRoot, ".meeting-sessions");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "session-1.json"), LEGACY_SESSION_BYTES, "utf-8");

      const entryPath = join(plugin.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const attempt = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, code: error.code ?? error.name, message: String(error.message ?? "") }; }
};
export const createPlugin = async (context) => {
  const api = context.hostApi;
  // The plugin's own view of the two prompt keys it watches. Written by the
  // host's change push, read back by a tool, so the assertion is on what the
  // PLUGIN saw rather than on what the host sent.
  const observedPrompts = {};
  // Tagged with \`typeof\` rather than normalised with \`?? null\`, because the
  // claim being made is that a CLEARED key arrives as \`undefined\` and not as
  // \`null\`. A stub that folded both into \`null\` would report the same thing
  // either way, and the wire's reason for wrapping the value would go untested.
  const observe = (value) => [typeof value, value ?? null];
  api.config.onChange("customSummaryFinalPrompt", (value) => { observedPrompts.final = observe(value); });
  api.config.onChange("customSummaryIntermediatePrompt", (value) => { observedPrompts.intermediate = observe(value); });
  return {
    handlers: {
      // The three answers to "can this plugin have the STT key", together.
      meeting_credentials_probe: async () => ({
        granted: await api.getSecret("llm.apiKey.openai"),
        denied: await api.getSecret("llm.apiKey.azure-foundry"),
        directRead: await attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
      }),
      // The transcription round: a lease, the Whisper egress, the summary.
      meeting_transcription_probe: async () => {
        const lease = await api.resolveApiKey({ purpose: "stt" });
        const response = await api.hostFetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", auth: { lease: lease.leaseId } });
        await lease.release();
        return {
          vendor: lease.vendor,
          exposure: lease.exposure,
          leaseId: lease.leaseId,
          status: response.status,
          transcript: [...new Uint8Array(await response.arrayBuffer())],
          summary: await api.callLlm("summarise the meeting"),
        };
      },
      meeting_prompts_probe: async () => ({ ...observedPrompts }),
      // The primary tool's own pre-flight, transcribed from the plugin: resolve
      // \`electron\`, insist \`BrowserWindow\` is constructible and \`screen\` can
      // answer for the display, then bind a partitioned session for the
      // recorder's audio capture. The plugin runs exactly this BEFORE it
      // side-effects, and wraps a failure as "floating window unsupported".
      // Reproduced rather than imported because the plugin lives in another
      // repository; what makes it a measurement is that the shape of the guard
      // is the plugin's and the answer is a real confined child's.
      meeting_window_probe: async () => await attempt(() => {
        const electron = require("electron");
        if (typeof electron.BrowserWindow !== "function"
          || typeof electron.screen?.getPrimaryDisplay !== "function") {
          throw new Error("BrowserWindow/screen unavailable in this host context");
        }
        electron.session.fromPartition("persist:recorder");
        return "the recorder window would open";
      }),
      // FFmpeg: staged under pluginDataDir exactly where ffmpegRuntime.ts puts
      // it, then run. The plugin is useless without this, and it is the second
      // thing a jail could plausibly break.
      meeting_ffmpeg_probe: async () => {
        const binDir = join(context.pluginDataDir, "vendor", "ffmpeg", "bin");
        mkdirSync(binDir, { recursive: true });
        const staged = join(binDir, "ffmpeg");
        writeFileSync(staged, "#!/bin/sh\\n"
          + "echo staged-runtime-ran\\n"
          + "cat " + ${JSON.stringify(fx.secretFile)} + " 2>/dev/null && echo LEAKED || echo denied\\n"
          + "echo escaped > " + ${JSON.stringify(fx.outsideFile)} + " 2>/dev/null && echo wrote || echo denied\\n");
        chmodSync(staged, 0o755);
        const run = spawnSync(staged, [], { encoding: "utf-8" });
        if (run.error) return { started: false, code: run.error.code ?? run.error.name };
        return { started: true, status: run.status, stdout: String(run.stdout).trim().split("\\n") };
      },
      // The one-time move of the pre-\`pluginDataDir\` session directory, run as
      // the plugin runs it: the source path built off \`context.hostRoot\`, the
      // destination inside \`pluginDataDir\`, and the move itself a
      // \`renameSync\` per file rather than a directory creation.
      meeting_legacy_session_probe: async () => {
        const legacyDir = join(context.hostRoot, ".meeting-sessions");
        const sessionsDir = join(context.pluginDataDir, "sessions");
        return {
          legacyDir,
          listed: await attempt(() => readdirSync(legacyDir)),
          prepared: await attempt(() => { mkdirSync(sessionsDir, { recursive: true }); return "made"; }),
          migrate: await attempt(() => {
            for (const file of readdirSync(legacyDir)) {
              renameSync(join(legacyDir, file), join(sessionsDir, file));
            }
            return "moved";
          }),
        };
      },
      // The temp root the plugin stages under. \`readdirSync(tmpdir())\` is the
      // first filesystem call in the sweep its own \`createPlugin\` runs
      // unguarded — nothing precedes it that could throw first — and
      // \`mkdtempSync(join(tmpdir(), ...))\` is how it stages an upload.
      meeting_tmpdir_probe: async () => ({
        tmpdir: tmpdir(),
        sweep: await attempt(() => readdirSync(tmpdir()).length),
        stage: await attempt(() => mkdtempSync(join(tmpdir(), "ave-meeting-upload-"))),
        // The plugin does not do this: the directory is inside the write jail,
        // so creating it succeeds — absence, not permission, was the old
        // failure, and the host now removes it.
        create: await attempt(() => { mkdirSync(tmpdir(), { recursive: true }); return "made"; }),
      }),
    },
  };
};
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const release = vi.fn();
      const configValues = new Map<string, unknown>([
        ["customSummaryFinalPrompt", "the original final prompt"],
        ["customSummaryIntermediatePrompt", "the original intermediate prompt"],
      ]);
      /** Per-key listeners, because the host's own change bus is per-key. A single undifferentiated set would deliver every notification to every
       * subscriber, and the assertion below; that the plugin's two prompt watchers each saw THEIR key's value; would pass no matter which key actually changed. */
      const configListeners = new Map<string, Set<(value: unknown) => void>>();
      const changeConfig = (key: string, value: unknown): void => {
        if (value === undefined) configValues.delete(key);
        else configValues.set(key, value);
        // `"*"` is the bus's every-key wildcard, which is what the factory's own snapshot re-push subscribes to.
        for (const listener of configListeners.get(key) ?? []) listener(value);
        for (const listener of configListeners.get("*") ?? []) listener(value);
      };
      const hostApi = {
        // The four-tier gate, standing in for its verdict. Both keys are ones `meeting` really declares under `hostSecrets.read`, so the shape of the question is the plugin's own.
        getSecret: async (key: string) =>
          key === "llm.apiKey.openai" ? SECRET_TEXT : null,
        resolveApiKey: async () => ({
          ok: true as const,
          vendor: "openai" as const,
          exposure: "lease" as const,
          leaseId: "lease_transcription_probe",
          onClosed: () => () => undefined,
          release,
        }),
        hostFetch: async () =>
          new Response(new Uint8Array([0x00, 0x80, 0xff, 0x41]), { status: 200 }),
        callLlm: async () => "three action items",
        emitEvent: () => undefined,
        logEvent: () => undefined,
        onEvent: () => () => undefined,
        getInstalledPluginIds: () => ["meeting"],
        onPluginsChanged: () => () => undefined,
        config: {
          get: (key: string) => configValues.get(key),
          set: async () => undefined,
          onChange: (key: string, callback: (value: unknown) => void) => {
            const forKey = configListeners.get(key) ?? new Set();
            forKey.add(callback);
            configListeners.set(key, forKey);
            return () => forKey.delete(callback);
          },
        },
      } as unknown as PluginHostApi;

      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: "meeting",
          name: "Meeting",
          version: "0.5.42",
          entry: "plugin.mjs",
          requires: { hostProtocol: "4" },
          description: "the recorder, confined",
          configSchema: {
            type: "object",
            properties: {
              customSummaryFinalPrompt: { type: "string" },
              customSummaryIntermediatePrompt: { type: "string" },
            },
          },
          tools: [
            "meeting_credentials_probe",
            "meeting_transcription_probe",
            "meeting_prompts_probe",
            "meeting_window_probe",
            "meeting_ffmpeg_probe",
            "meeting_legacy_session_probe",
            "meeting_tmpdir_probe",
          ].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        } as PluginManifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
      });
      // The temp root ASRT itself would hand the child: read out of the HOST env while it builds the wrap, and here one that does not exist, inside `pluginDataDir` so it is write-allowed and merely absent; `/tmp/claude`'s status on an ordinary
      // machine, where the plugin's unguarded sweep of `tmpdir()` used to stop it loading. The child must not see it: its `TMPDIR` is its plugin's own directory, assigned inside the wrap after ASRT's, and created by the host before the spawn.
      const absentSandboxTmp = join(plugin.pluginDataDir, "sandbox-tmp-that-is-absent");
      expect(existsSync(absentSandboxTmp)).toBe(false);
      process.env.CLAUDE_CODE_TMPDIR = absentSandboxTmp;

      const instance = await factory({
        pluginId: "meeting",
        pluginSocketDir: resolvePluginSocketDir(plugin.pluginDataDir),
        pluginRoot: plugin.pluginRoot,
        // The app root, as production passes it; a directory the child has no write grant for,
        // which is what makes the legacy-migration case below an assertion rather than a coincidence.
        hostRoot: fx.hostRoot,
        pluginDataDir: plugin.pluginDataDir,
        userHome: homedir(),
        aveHome: aveHome(),
        config: Object.fromEntries(configValues),
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      try {
        // ── the gate's two arms, and the door it replaced ──────────────────
        const credentials = (await instance.handlers.meeting_credentials_probe!()) as {
          granted: string | null;
          denied: string | null;
          directRead: { ok: boolean; value?: string };
        };
        expect(credentials.granted).toBe(SECRET_TEXT);
        // Refused is `null`; not a throw, and not a stale value from a key the gate did grant.
        expect(credentials.denied).toBeNull();
        // …and the file the plugin used to be able to read instead.
        expect(credentials.directRead.ok).toBe(false);
        expect(credentials.directRead.value).toBeUndefined();

        // ── resolveApiKey / hostFetch / callLlm ────────────────────────────
        const transcription = (await instance.handlers.meeting_transcription_probe!()) as {
          vendor: string;
          exposure: string;
          leaseId: string;
          status: number;
          transcript: number[];
          summary: string;
        };
        expect(transcription.vendor).toBe("openai");
        expect(transcription.exposure).toBe("lease");
        expect(transcription.leaseId).toBe("lease_transcription_probe");
        expect(release).toHaveBeenCalledTimes(1);
        expect(transcription.status).toBe(200);
        // A NUL, a lone continuation byte and a 0xFF: audio bytes no text codec survives, which is what the transcription upload actually carries.
        expect(transcription.transcript).toEqual([0x00, 0x80, 0xff, 0x41]);
        expect(transcription.summary).toBe("three action items");

        // Nothing has changed yet, so the plugin has seen no notification.
        await expect(instance.handlers.meeting_prompts_probe!()).resolves.toEqual({});
        changeConfig("customSummaryFinalPrompt", "the edited final prompt");
        changeConfig("customSummaryIntermediatePrompt", undefined);
        await expect(instance.handlers.meeting_prompts_probe!()).resolves.toEqual({
          final: ["string", "the edited final prompt"],
          // A cleared key reaches the plugin as `undefined`; the plugin tagged the type before anything could normalise it. That is the whole reason the wire wraps the value in a
          // property instead of sending it bare: an absent property reads back as `undefined`, and this is the assertion that would go red if it started reading back as `null`.
          intermediate: ["undefined", null],
        });

        // ── the window its primary tool opens, which does NOT survive ──────
        const window = (await instance.handlers.meeting_window_probe!()) as {
          ok: boolean;
          code?: string;
          value?: string;
        };
        // The guard fails at RESOLUTION, before it can even ask whether `BrowserWindow` is a constructor. Asserted by code so a future child
        // that resolved `electron` to something inert would fail here loudly rather than by returning a shape the guard happens to reject.
        expect(window, JSON.stringify(window)).toMatchObject({
          ok: false,
          code: "MODULE_NOT_FOUND",
        });
        expect(window.value).toBeUndefined();

        // ── the FFmpeg runtime the plugin stages and runs itself ───────────
        const ffmpeg = (await instance.handlers.meeting_ffmpeg_probe!()) as {
          started: boolean;
          status: number;
          stdout: string[];
        };
        expect(ffmpeg.started).toBe(true);
        expect(ffmpeg.status).toBe(0);
        // It runs; and it inherits the jail in both directions, so the transcoder can neither read what the plugin that started it
        // cannot nor write where the plugin cannot. A confinement that ended at the first `spawn()` would produce "LEAKED" and "wrote" here.
        expect(ffmpeg.stdout).toEqual(["staged-runtime-ran", "denied", "denied"]);
        expect(existsSync(fx.outsideFile)).toBe(false);

        // ── the legacy session move, which this boundary CHANGES ───────────
        const legacy = (await instance.handlers.meeting_legacy_session_probe!()) as {
          legacyDir: string;
          listed: { ok: boolean; value?: string[] };
          prepared: { ok: boolean; code?: string };
          migrate: { ok: boolean; code?: string };
        };
        // The plugin still builds the path off `hostRoot`, and it arrives in the child unchanged…
        expect(legacy.legacyDir).toBe(legacyDir);
        // …the child can SEE the un-migrated file, so what follows is a WRITE denial and not a child that simply found nothing to move…
        expect(legacy.listed.ok, JSON.stringify(legacy.listed)).toBe(true);
        expect(legacy.listed.value).toEqual(["session-1.json"]);
        // …its destination inside the jail is created without complaint…
        expect(legacy.prepared.ok, JSON.stringify(legacy.prepared)).toBe(true);
        // …but the move itself fails closed. `hostRoot` is outside the child's write jail, and this is the same unguarded `renameSync` the plugin runs in its
        // activation body; so on an install that still holds un-migrated files there, this denial is not a lost migration, it is a plugin that does not start.
        expect(legacy.migrate.ok, JSON.stringify(legacy.migrate)).toBe(false);
        // And nothing moved: the file is where it was, and none landed. A partially-completed migration would be worse than a refused one.
        expect(readFileSync(join(legacyDir, "session-1.json"), "utf-8")).toBe(
          LEGACY_SESSION_BYTES,
        );
        expect(existsSync(join(plugin.pluginDataDir, "sessions", "session-1.json"))).toBe(
          false,
        );

        // ── the temp directory the child sees, whatever ASRT would hand it ─
        const temp = (await instance.handlers.meeting_tmpdir_probe!()) as {
          tmpdir: string;
          sweep: { ok: boolean; code?: string };
          stage: { ok: boolean; code?: string };
          create: { ok: boolean; code?: string };
        };
        // Neither the host's own temp directory nor the root ASRT was given: the plugin's directory, which the host created before the spawn.
        expect(realpathSync(temp.tmpdir)).toBe(
          realpathSync(join(appOwnedSandboxTempRoot(), sandboxTempPrincipalDirName({ kind: "plugin", id: "meeting" }))),
        );
        expect(temp.tmpdir).not.toBe(absentSandboxTmp);
        expect(existsSync(absentSandboxTmp)).toBe(false);
        expect(temp.tmpdir).not.toBe(tmpdir());
        // So the sweep the plugin runs unguarded inside `createPlugin`, and its upload staging, both succeed: the directory exists and is the plugin's to write.
        expect(temp.sweep, JSON.stringify(temp.sweep)).toMatchObject({ ok: true });
        expect(temp.stage, JSON.stringify(temp.stage)).toMatchObject({ ok: true });
        expect(temp.create, JSON.stringify(temp.create)).toMatchObject({ ok: true });
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );
});

/** Authentication redirects need a listener reachable from the host; check bind and connect separately on each platform.
 * For Unix sockets use a short canonical path so path-length limits or /tmp symlinks cannot cause a false confinement refusal. */
interface ShortRootedPlugin {
  readonly root: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly socketDir: string;
}

function makeShortRootedPlugin(): ShortRootedPlugin {
  const base = process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp";
  const root = mkdtempSync(join(base, "lv-uds-"));
  const pluginRoot = join(root, "p");
  const pluginDataDir = join(pluginRoot, "data");
  const socketDir = resolvePluginSocketDir(pluginDataDir);
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  return { root, pluginRoot, pluginDataDir, socketDir };
}

/** Bind a Unix-domain socket inside a confined child and report what happened, then; when the bind succeeded; try to reach it FROM THE HOST. The host half is the point. A child can say `listen()` returned, and a child saying that is exactly what the loopback case below produces on Linux while the socket sits in a namespace nobody else is in. Only an
 * outside connect distinguishes "bound" from "bound and reachable", which is the property a plugin's spawned worker actually depends on. @param socketPath where to bind. Passed rather than derived so a case can aim it at a directory the host did NOT register; the control that separates "the registration did it" from "unix sockets are simply allowed". */
interface UnixProbeSession {
  request(operation: "bind" | "connect" | "reset", socketPath?: string): Promise<{ ok?: boolean; code?: string; servers?: number; sockets?: number }>;
  stop(): Promise<void>;
}

/** One kernel policy, with every server and socket closed between operations. */
async function openUnixProbeSession(plugin: ShortRootedPlugin): Promise<UnixProbeSession> {
  const probePath = join(plugin.pluginRoot, "unix-probe.mjs");
  writeFileSync(probePath, `import { createServer } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { unlinkSync } from "node:fs";
const servers = new Set();
const sockets = new Set();
let watchdog;
const report = (id, result) => process.stdout.write("PROBE:" + JSON.stringify({ id, result }) + "\\n");
async function reset() {
  clearTimeout(watchdog);
  await Promise.all([...sockets].map(socket => new Promise(resolve => {
    socket.once("close", resolve);
    socket.destroy();
  })));
  await Promise.all([...servers].map(server => new Promise((resolve, reject) => {
    server.close(error => {
      servers.delete(server);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  })));
  return { servers: servers.size, sockets: sockets.size };
}
async function run(request) {
  if (request.operation === "reset") return await reset();
  if (request.operation === "bind") {
    watchdog = setTimeout(() => process.exit(0), 4000);
    watchdog.unref();
    const server = createServer((_req, res) => res.end("reached"));
    servers.add(server);
    try { unlinkSync(request.socketPath); } catch { /* no previous socket */ }
    return await new Promise(resolve => {
      server.once("error", error => resolve({ ok: false, code: error.code ?? error.name }));
      server.listen({ path: request.socketPath }, () => resolve({ ok: true }));
    });
  }
  watchdog = setTimeout(() => process.exit(0), 5000);
  watchdog.unref();
  return await new Promise(resolve => {
    const socket = connect({ path: request.socketPath, timeout: 3000 });
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, code: "ETIMEDOUT" }); });
    socket.once("error", error => { socket.destroy(); resolve({ ok: false, code: error.code ?? error.name }); });
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  report(request.id, await run(request));
}
await reset();
`, "utf-8");
  const child = await spawnConfinedPluginChild({
    pluginId: PLUGIN_ID,
    socketDir: plugin.socketDir,
    workerRunRoot: resolvePluginWorkerRunRoot(plugin.pluginDataDir),
    envelope: derivePluginChildEnvelope({
      pluginId: PLUGIN_ID,
      pluginRoot: plugin.pluginRoot,
      pluginDataDir: plugin.pluginDataDir,
      configValue: () => undefined,
    }),
    launch: { kind: "entry", childEntryPath: probePath },
  });
  type Result = Awaited<ReturnType<UnixProbeSession["request"]>>;
  const pending = new Map<number, { resolve(result: Result): void; reject(error: Error): void }>();
  let sequence = 0;
  let stdout = "";
  child.link.input.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
    for (let end = stdout.indexOf("\n"); end !== -1; end = stdout.indexOf("\n")) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      if (!line.startsWith("PROBE:")) continue;
      const frame = JSON.parse(line.slice("PROBE:".length)) as { id: number; result: Result };
      pending.get(frame.id)?.resolve(frame.result);
    }
  });
  const failPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
  };
  child.link.input.on("end", () => failPending(new Error(`the unix probe exited without reporting; stdout was: ${stdout}`)));
  child.link.input.on("error", failPending);
  return {
    request(operation, socketPath) {
      const id = ++sequence;
      return new Promise<Result>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the unix probe never reported; stdout was: ${stdout}`));
        }, 15_000);
        const finish = (complete: () => void): void => {
          clearTimeout(timer);
          pending.delete(id);
          complete();
        };
        pending.set(id, {
          resolve: result => finish(() => resolve(result)),
          reject: error => finish(() => reject(error)),
        });
        child.link.output.write(`${JSON.stringify({ id, operation, socketPath })}\n`);
      });
    },
    async stop() {
      child.link.terminate("unix probes done");
      await child.waitForExit!();
    },
  };
}

async function runUnixBindProbe(
  session: UnixProbeSession,
  socketPath: string,
): Promise<{ child: { ok: boolean; code?: string }; hostReach?: string }> {
  const report = await session.request("bind", socketPath) as { ok: boolean; code?: string };
  if (!report.ok) return { child: report };
  const hostReach = await new Promise<string>((resolve) => {
    const socket = connect({ path: socketPath, timeout: 2000 });
    socket.on("connect", () => { socket.destroy(); resolve("connected"); });
    socket.on("timeout", () => { socket.destroy(); resolve("ETIMEDOUT"); });
    socket.on("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code ?? error.name); });
  });
  return { child: report, hostReach };
}

async function runUnixConnectProbe(
  session: UnixProbeSession,
  socketPath: string,
): Promise<{ ok: boolean; code?: string }> {
  const server = createServer((_req, res) => res.end("reached"));
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  try {
    return await session.request("connect", socketPath) as { ok: boolean; code?: string };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("a confined child and a Unix-domain socket", () => {
  let shortPlugin: ShortRootedPlugin;
  let session: UnixProbeSession | undefined;
  let previousHome: string | undefined;

  beforeAll(async () => {
    if (process.platform === "win32" || !(await sandboxCasesRun())) return;
    previousHome = process.env.AVE_HOME;
    shortPlugin = makeShortRootedPlugin();
    process.env.AVE_HOME = join(shortPlugin.root, ".ave");
    mkdirSync(process.env.AVE_HOME, { recursive: true });
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    retainedSandbox = true;
    // beforeAll runs before the file's beforeEach, after the previous case's afterEach cleared the boot
    // request: the retained child is a plugin child, wrapped only while plugin-worker confinement was requested.
    setPluginWorkerConfinementRequestedAtBoot(true);
    session = await openUnixProbeSession(shortPlugin);
  });

  afterEach(async () => {
    if (session) expect(await session.request("reset")).toEqual({ servers: 0, sockets: 0 });
  });

  afterAll(async () => {
    try {
      await session?.stop();
      if (retainedSandbox && isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      retainedSandbox = false;
      if (shortPlugin) {
        if (previousHome === undefined) delete process.env.AVE_HOME;
        else process.env.AVE_HOME = previousHome;
        rmSync(shortPlugin.root, { recursive: true, force: true });
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "binds in the directory the host registered, and the HOST reaches it",
    async () => {
      if (!(await sandboxCasesRun())) return;
      // The same posture the loopback cases measure against: deny-by-default egress, no local binding. What changes the answer here is not a looser network policy; it is that this socket is a FILESYSTEM
      // object in a directory the spawn registered before wrapping. Binding an operation target does not depend on a fresh process; the shared child retains this same kernel grant and is reset after each case.
      const { child, hostReach } = await runUnixBindProbe(
        session!,
        join(shortPlugin.socketDir, "probe.sock"),
      );

      expect(child.ok, JSON.stringify(child)).toBe(true);
      // The half the child cannot assert about itself, and the half the whole capability exists for: a loopback TCP bind
      // either fails (macOS) or succeeds into a namespace nobody else is in (Linux). This one is reachable from outside on both.
      expect(hostReach).toBe("connected");
    },
    120_000,
  );

  it.runIf(process.platform !== "win32")(
    "connects to a worker socket the host bound in the plugin's run directory",
    async () => {
      if (!(await sandboxCasesRun())) return;
      // The field failure this closes: local-indexer's worker bound its control socket successfully; an unconfined probe reached it; and the plugin's own confined child got `connect EPERM` on the same path, every boot, so the health check timed out at 30s and every one of that plugin's tools was refused
      // for the rest of the session. `worker-spawn.ts` registers the directory so the WORKER may bind; nothing registered it for the client, because its header recorded an assumption; "the host connects from OUTSIDE the sandbox (unconstrained)"; that stopped being true when every plugin moved out of process.
      const runDir = join(resolvePluginWorkerRunRoot(shortPlugin.pluginDataDir), "w");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });

      // This is another operation under the identical registered envelope; reset closes every socket before this case and after its result.
      const report = await runUnixConnectProbe(session!, join(runDir, "control.sock"));

      expect(report, JSON.stringify(report)).toEqual({ ok: true });
    },
    120_000,
  );

  it.runIf(process.platform === "darwin")(
    "refuses a socket in a directory that is writable but NOT registered",
    async () => {
      if (!(await sandboxCasesRun())) return;
      // Changing only the bind directory distinguishes socket grants from write grants on macOS.
      // Linux permits the socket family without path scope, so it cannot support the same refusal assertion.
      const { child } = await runUnixBindProbe(
        session!,
        join(shortPlugin.pluginDataDir, "unregistered.sock"),
      );

      expect(child.ok, JSON.stringify(child)).toBe(false);
      expect(child.code).toMatch(/EPERM|EACCES/);
    },
    120_000,
  );
});

describe("a confined child and a loopback TCP listener", () => {
  it.runIf(process.platform === "darwin")(
    "on macOS the bind is refused outright, so the failure arrives before the user does",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      // The same posture every other confinement case here measures against, and the same one production
      // boots: deny-by-default egress, and no `allowLocalBinding`; because nothing in this app ever sets it.
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { child } = await runLoopbackBindProbe(fx);
      // No `allowLocalBinding` anywhere in this app, so the Seatbelt profile emits no `network-bind` rule and `listen()` has nothing to match.
      expect(child.ok).toBe(false);
      expect(child.code).toMatch(/EPERM|EACCES|EAFNOSUPPORT|EINVAL/);
    },
    120_000,
  );

  it.runIf(process.platform === "linux")(
    "on Linux the bind succeeds into a loopback the host is not in",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { child, hostReach } = await runLoopbackBindProbe(fx);
      // `--unshare-net` gives the child its own 127.0.0.1. Nothing refuses the bind because, inside that namespace, nothing is wrong with it.
      expect(child.ok).toBe(true);
      expect(typeof child.port).toBe("number");
      // …and this is the assertion the child could not make about itself: the host, which is where a
      // browser's redirect would come from, cannot reach the port the child is certain it is serving.
      expect(hostReach).not.toBe("connected");
    },
    120_000,
  );
});

/** Verify host-injected worker settings through real confinement; child homedir must differ from userHome while context.userHome retains the user's actual home. */
describe("the indexer's host-supplied answers, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "hands over the real home, the real Ave root, and the drive lookup it no longer spawns for",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const plugin = installPlugin(fx, "local-indexer");
      const childEntryPath = pluginChildEntryPath();
      const entryPath = join(plugin.pluginRoot, "plugin.mjs");

      writeFileSync(
        entryPath,
        `import { homedir } from "node:os";
export default async function createPlugin(context) {
  return {
    handlers: {
      indexer_home_probe: async () => ({
        contextUserHome: context.userHome,
        contextAveHome: context.aveHome,
        ownHomedir: homedir(),
      }),
      // The member that replaced a \`powershell.exe\` spawn. On this platform
      // the honest answer is \`null\` — there are no mapped drives — and what
      // the case proves is that the QUESTION crossed the boundary and came
      // back as an answer rather than as an unimplemented member.
      indexer_drive_probe: async () => {
        try {
          return { ok: true, value: await context.hostApi.resolveMappedDriveRoot("Z:") };
        } catch (error) {
          return { ok: false, message: String(error && error.message ? error.message : error) };
        }
      },
    },
  };
}
`,
        "utf-8",
      );

      let askedFor: string[] = [];
      const hostApi = {
        resolveMappedDriveRoot: async (drive: string) => {
          askedFor.push(drive);
          return null;
        },
        emitEvent: () => undefined,
        logEvent: () => undefined,
        onEvent: () => () => undefined,
        getInstalledPluginIds: () => ["local-indexer"],
        onPluginsChanged: () => () => undefined,
        config: {
          get: () => undefined,
          set: async () => undefined,
          onChange: () => () => undefined,
        },
      } as unknown as PluginHostApi;

      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: "local-indexer",
          name: "Local Indexer",
          version: "0.5.40",
          entry: "plugin.mjs",
          requires: { hostProtocol: "4" },
          description: "the indexer's host-supplied answers",
          tools: ["indexer_home_probe", "indexer_drive_probe"].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        } as PluginManifest,
        launch: { kind: "entry", entryPath },
        childEntryPath,
      });

      const instance = await factory({
        pluginId: "local-indexer",
        pluginSocketDir: resolvePluginSocketDir(plugin.pluginDataDir),
        pluginRoot: plugin.pluginRoot,
        hostRoot: fx.hostRoot,
        pluginDataDir: plugin.pluginDataDir,
        userHome: homedir(),
        aveHome: aveHome(),
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      try {
        const homes = (await instance.handlers.indexer_home_probe!()) as {
          contextUserHome: string;
          contextAveHome: string;
          ownHomedir: string;
        };
        // The substitution is real: what the child would have used as "the user's home" belongs to nobody.
        expect(homes.ownHomedir).not.toBe(homedir());
        // …and what it is given instead is the one the host reads, which is also the one the sensitive-path deny floor is anchored to.
        expect(homes.contextUserHome).toBe(homedir());
        expect(homes.contextAveHome).toBe(aveHome());

        const drive = (await instance.handlers.indexer_drive_probe!()) as {
          ok: boolean;
          value?: string | null;
          message?: string;
        };
        expect(drive.ok).toBe(true);
        expect(drive.value).toBeNull();
        // The control for that `null`: it is the host's answer, not the child quietly deciding for
        // itself. Without this the same `null` could have come from a member that was never reached.
        expect(askedFor).toEqual(["Z:"]);
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );
});

/** A `process` entry under the real wrap (docs/design/plugin-hostapi-protocol.md §9.7 P3, decision 36). These prove the spawn path and the environment only; a real non-JS interpreter is the cross-language smoke's job. The launch is `/usr/bin/env <declared pairs> PLUGIN_ROOT=… PLUGIN_DATA=… <command> <args>`, run INSIDE the wrap;
 * the wrapper ASRT spawns; `/bin/bash -c`; sees only the safe host environment and the sandbox HOME. So a variable that would make the wrapper itself run code is set too late to do so, and anything it makes the plugin's own process run is confined. The context the lifecycle hands a process plugin's factory, over the validation host. */
function processContext(fx: Fixture, plugin: InstalledPlugin): PluginRuntimeContext {
  return {
    pluginId: plugin.pluginId,
    pluginSocketDir: resolvePluginSocketDir(plugin.pluginDataDir),
    pluginRoot: plugin.pluginRoot,
    hostRoot: fx.hostRoot,
    pluginDataDir: plugin.pluginDataDir,
    userHome: homedir(),
    aveHome: aveHome(),
    config: {},
    log: () => undefined,
    hostApi: createValidationHost().api,
  };
}

describe("a process entry, spawned under the real wrap", () => {
  /** The executable the manifest names: a shell script that `exec`s this host's own binary, as Node, on a small protocol responder. It
   * stands in for a plugin's own launcher, so the spawn and the environment are the production ones and only the program at the end differs. */
  function installProcessPlugin(fx: Fixture): { plugin: InstalledPlugin; manifest: PluginManifest } {
    const plugin = installPlugin(fx, "processprobe");
    mkdirSync(join(plugin.pluginRoot, "bin"), { recursive: true });
    mkdirSync(join(plugin.pluginRoot, "vendor"), { recursive: true });
    writeFileSync(
      join(plugin.pluginRoot, "invoker.mjs"),
      `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const reply = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === ${JSON.stringify(PLUGIN_INSTANCE_METHODS.construct)}) {
    writeFileSync(join(process.env.PLUGIN_DATA, "launch-env.json"), JSON.stringify({
      PLUGIN_ROOT: process.env.PLUGIN_ROOT,
      PLUGIN_DATA: process.env.PLUGIN_DATA,
      SMOKE_VENDOR_DIR: process.env.SMOKE_VENDOR_DIR,
      entryPath: frame.params.entryPath,
    }));
    reply({ jsonrpc: "2.0", id: frame.id, result: {
      implementedToolNames: [], servesUiResources: false, lifecycleHooks: [], pluginProtocol: { requires: [] },
    } });
  } else if (frame.method !== undefined && frame.id !== undefined) {
    reply({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "not served by this probe" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
      "utf-8",
    );
    const launcher = join(plugin.pluginRoot, "bin", "plugin");
    writeFileSync(
      launcher,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} "$PLUGIN_ROOT/invoker.mjs"\n`,
      "utf-8",
    );
    chmodSync(launcher, 0o755);
    return {
      plugin,
      manifest: {
        id: plugin.pluginId,
        name: plugin.pluginId,
        version: "1.0.0",
        process: { command: "./bin/plugin", env: { SMOKE_VENDOR_DIR: "${PLUGIN_ROOT}/vendor" } },
        requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
        description: "a process entry whose environment is measured",
        tools: [],
      },
    };
  }

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reaches construct and reads PLUGIN_ROOT, PLUGIN_DATA and a declared variable from its environment",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const { plugin, manifest } = installProcessPlugin(fx);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const launch = resolveProcessLaunch(manifest, plugin.pluginRoot, plugin.pluginDataDir);
      const factory = createOutOfProcessPluginFactory({ manifest, launch: { kind: "process", ...launch } });
      const instance = await factory(processContext(fx, plugin));
      try {
        const seen = JSON.parse(readFileSync(join(plugin.pluginDataDir, "launch-env.json"), "utf-8")) as Record<string, string>;
        expect(seen).toEqual({
          PLUGIN_ROOT: realpathSync(plugin.pluginRoot),
          PLUGIN_DATA: realpathSync(plugin.pluginDataDir),
          SMOKE_VENDOR_DIR: join(realpathSync(plugin.pluginRoot), "vendor"),
          // Construct's entryPath is the resolved command for a process launch.
          entryPath: join(realpathSync(plugin.pluginRoot), "bin", "plugin"),
        });
        expect(isPluginChildConfined(plugin.pluginId)).toBe(true);
      } finally {
        await instance.stop?.();
      }
    },
    120_000,
  );

  /** Spawn a process launch directly, below the manifest hardening, and wait for it to end. */
  async function spawnBelowHardening(
    plugin: InstalledPlugin,
    env: Record<string, string>,
  ): Promise<void> {
    const launcher = join(plugin.pluginRoot, "bin", "plugin");
    const child = await spawnConfinedPluginChild({
      pluginId: plugin.pluginId,
      socketDir: resolvePluginSocketDir(plugin.pluginDataDir),
      workerRunRoot: resolvePluginWorkerRunRoot(plugin.pluginDataDir),
      envelope: derivePluginChildEnvelope({
        pluginId: plugin.pluginId,
        pluginRoot: plugin.pluginRoot,
        pluginDataDir: plugin.pluginDataDir,
        configValue: () => undefined,
      }),
      launch: {
        kind: "process",
        command: launcher,
        args: [],
        env: { ...env, PLUGIN_ROOT: plugin.pluginRoot, PLUGIN_DATA: plugin.pluginDataDir },
      },
    });
    const exited = new Promise<string>((resolve) => child.link.onGone(resolve));
    child.link.output.end();
    await exited;
    await child.waitForExit?.();
  }

  /** The positive control: the same environment given to the wrap's own outer shell, `/bin/bash -c`, OUTSIDE any sandbox. It must run the fixture, or the sentinel's absence under the wrap would prove nothing; the
   * control's sentinel is removed before the wrapped run. Its stdin is `/dev/null`: on a socket stdin, which is what a default Node pipe is, bash takes its rshd heuristic, sources `~/.bashrc` and skips `BASH_ENV`. */
  function runOuterShellUnconfined(env: Record<string, string>, sentinel: string): void {
    execFileSync("/bin/bash", ["-c", "true"], {
      env: { ...env, PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(existsSync(sentinel), "the control did not run the fixture, so the wrapped case would measure nothing")
      .toBe(true);
    rmSync(sentinel);
  }

  /** A launcher that does nothing, so anything that ran came from the environment. */
  function installInertPlugin(fx: Fixture): InstalledPlugin {
    const plugin = installPlugin(fx, "inertprobe");
    mkdirSync(join(plugin.pluginRoot, "bin"), { recursive: true });
    const launcher = join(plugin.pluginRoot, "bin", "plugin");
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(launcher, 0o755);
    return plugin;
  }

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "runs nothing before confinement from a BASH_ENV pair",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const plugin = installInertPlugin(fx);
      const sentinelDir = mkdtempSync(join(fx.root, "bash-env-sentinel-"));
      const sentinel = join(sentinelDir, "ran");
      const startup = join(plugin.pluginRoot, "startup.sh");
      writeFileSync(startup, `echo ran > ${JSON.stringify(sentinel)}\n`, "utf-8");
      runOuterShellUnconfined({ BASH_ENV: startup }, sentinel);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      await spawnBelowHardening(plugin, { BASH_ENV: startup });
      expect(existsSync(sentinel)).toBe(false);
    },
    120_000,
  );

  // Linux only. On macOS, System Integrity Protection strips DYLD_* from the environment of /bin/bash, which is the
  // wrap's outer shell, so the positive control cannot run the library there and a green case would claim nothing.
  it.runIf(process.platform === "linux")(
    "runs nothing before confinement from an LD_PRELOAD library (Linux, where the control loads it)",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const plugin = installInertPlugin(fx);
      const sentinelDir = mkdtempSync(join(fx.root, "preload-sentinel-"));
      const sentinel = join(sentinelDir, "ran");
      // A library whose constructor writes the sentinel, built in the plugin's own root. The C compiler is a
      // precondition of this case, not optional: a machine without one fails here rather than passing unmeasured.
      const source = join(fx.root, "preload.c");
      const library = join(plugin.pluginRoot, "preload.so");
      writeFileSync(
        source,
        `#include <stdio.h>\n__attribute__((constructor)) static void ran(void) {\n`
          + `  FILE *f = fopen(${JSON.stringify(sentinel)}, "w");\n  if (f) { fputs("ran", f); fclose(f); }\n}\n`,
        "utf-8",
      );
      execFileSync("cc", ["-shared", "-fPIC", "-o", library, source]);
      runOuterShellUnconfined({ LD_PRELOAD: library }, sentinel);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      await spawnBelowHardening(plugin, { LD_PRELOAD: library });
      expect(existsSync(sentinel)).toBe(false);
    },
    120_000,
  );
  // The host keeps resolving the data root; every storage handle and every spawn starts from it; so plugin-owned code that could swap it for a link would steer those. It still writes freely inside the root (the first step, which is also the proof the
  // script ran under the wrap); it may not rename the root into another of its write roots, remove it, or so put a link in its place. macOS: the pinned-root deny (`pinWriteRoots`, asrt-sandbox.ts). Linux: every write root is a bubblewrap bind mount.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a plugin child cannot rename, remove or replace its own data root, while writing inside it",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const plugin = installInertPlugin(fx);
      const outside = mkdtempSync(join(fx.root, "root-swap-outside-"));
      for (const item of readdirSync(plugin.pluginDataDir)) {
        rmSync(join(plugin.pluginDataDir, item), { recursive: true, force: true });
      }
      const before = emptyRemovableRoot(plugin.pluginDataDir);
      // The socket directory is another write root of the same child.
      const elsewhere = resolvePluginSocketDir(plugin.pluginDataDir);
      const report = join(elsewhere, "root-swap-report");
      const inventoryReport = join(elsewhere, "root-entries.json");
      writeFileSync(
        join(plugin.pluginRoot, "bin", "plugin"),
        rootSwapScript("", "printf '%s\\n' \"$result\" > \"$REPORT\""),
        "utf-8",
      );
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      await spawnBelowHardening(plugin, { ELSEWHERE: elsewhere, OUTSIDE: outside, REPORT: report, ROOT_ENTRIES_REPORT: inventoryReport });
      await resetAsrtSandbox();
      expectRootHeld(readFileSync(report, "utf-8"), inventoryReport, plugin.pluginDataDir, before, elsewhere, outside);
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a plugin worker cannot rename, remove or replace its plugin's data root, while writing inside it",
    async () => {
      if (!(await sandboxCasesRun())) return;
      // A home short enough for the worker's control-socket path to fit `sun_path`; the fixture's lives deep under the OS temp directory.
      const home = mkdtempSync(join("/tmp", "lvw-"));
      process.env.AVE_HOME = home;
      try {
        const pluginRoot = join(home, "plugins", "rs");
        const dataDir = join(pluginRoot, "data");
        const elsewhere = join(pluginRoot, "scratch");
        const outside = join(home, "outside");
        const inventoryReport = join(elsewhere, "root-entries.json");
        for (const dir of [dataDir, elsewhere, outside, join(pluginRoot, "bin")]) mkdirSync(dir, { recursive: true });
        const script = join(pluginRoot, "bin", "swap.sh");
        writeFileSync(script, rootSwapScript("", "printf '%s\\n' \"$result\" > \"$REPORT\""), "utf-8");
        const before = emptyRemovableRoot(dataDir);
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        const worker = await spawnWorker({
          pluginId: "rs",
          workerId: "w",
          command: "/bin/sh",
          args: [script],
          env: { PLUGIN_DATA: dataDir, ELSEWHERE: elsewhere, OUTSIDE: outside, REPORT: join(elsewhere, "report"), ROOT_ENTRIES_REPORT: inventoryReport },
          allowReadPaths: [join(pluginRoot, "bin")],
          allowWritePaths: [dataDir, elsewhere],
        });
        await new Promise<void>((resolve) => worker.onExit(() => resolve()));
        await resetAsrtSandbox();
        expectRootHeld(readFileSync(join(elsewhere, "report"), "utf-8"), inventoryReport, dataDir, before, elsewhere, outside);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a bundled hook cannot rename, remove or replace its plugin's data root, while writing inside it",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const generationRoot = mkdtempSync(join(fx.root, "hook-generation-"));
      const dataDir = mkdtempSync(join(fx.root, "hook-data-"));
      const outside = mkdtempSync(join(fx.root, "hook-outside-"));
      const inventoryReport = join(tempDirOf({ kind: "plugin", id: "swap-plugin" }), "root-entries.json");
      const script = join(generationRoot, "swap.sh");
      // The hook's other write root is its process HOME.
      writeFileSync(
        script,
        rootSwapScript(
          `ELSEWHERE="$HOME"\nROOT_ENTRIES_REPORT="$TMPDIR/root-entries.json"\nOUTSIDE=${JSON.stringify(outside)}\n`,
          "printf '{\"action\":\"allow\",\"reason\":\"%s\"}' \"$result\"",
        ),
        "utf-8",
      );
      const before = emptyRemovableRoot(dataDir);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const result = await runOneHookScript(
        { id: "swap", hookType: "pre", source: "config", hookPath: script, command: ["/bin/sh", script],
          confinement: { kind: "bundled", pluginId: "swap-plugin", dataDir, generationRoot } },
        { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
          sessionId: "root-swap", trustOrigin: "user-keyboard" },
        { timeoutMs: 10_000 },
      );
      expect(result.decision, result.reason).toBe("allow");
      await resetAsrtSandbox();
      expectRootHeld(result.reason, inventoryReport, dataDir, before, undefined, outside);
    },
    120_000,
  );
});

/** Every line of a child's raw stdout that is not one JSON object ended by 0x0A (decision 40). Read beside the decoder, never
 * instead of it: the decoder drops such a line by design and still yields the frame after it, so counting decoded frames cannot see one. */
function rawStdoutViolations(stdout: Buffer): string[] {
  const text = stdout.toString("utf-8");
  const lines = text.split("\n");
  const violations: string[] = [];
  // A stream that ends on 0x0A leaves an empty tail.
  const tail = lines.pop();
  if (tail !== "") violations.push(`unterminated: ${JSON.stringify(tail)}`);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      violations.push(JSON.stringify(line));
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) violations.push(JSON.stringify(line));
  }
  return violations;
}

/** What one child's process tree cost, sampled from spawn to exit (decision 41). */
interface TreeMeasurement {
  readonly peakRssBytes: number;
  readonly samples: number;
}

/** Sample the process tree rooted at `rootPid`; the spawned wrapper, as `observeChild` reports it; every 50 ms, until `exited` settles. The first sample completes synchronously before the caller can
 * stop the child. Linux reads only this tree through procfs; other platforms use the process table. RSS is in KiB on both platforms. `process.resourceUsage()` is not used: it reports the test runner. */
function sampleProcessTree(rootPid: number, exited: Promise<unknown>): Promise<TreeMeasurement> {
  let peakKiB = 0;
  let samples = 0;
  let done = false;
  void exited.then(() => {
    done = true;
  });
  const sample = async (initial = false): Promise<void> => {
    if (process.platform === "linux") {
      const seen = new Set<number>();
      const pending = [rootPid];
      let rootPresent = false;
      let total = 0;
      while (pending.length > 0) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
          if (!rss) continue;
          if (pid === rootPid) rootPresent = true;
          total += Number(rss[1]);
          for (const task of readdirSync(`/proc/${pid}/task`)) {
            try {
              const children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
              pending.push(...children.trim().split(/\s+/u).filter(Boolean).map(Number));
            } catch {
              // A thread can exit between the directory listing and the read.
            }
          }
        } catch {
          // A process can exit while its tree is being sampled.
        }
      }
      if (rootPresent) {
        samples += 1;
        peakKiB = Math.max(peakKiB, total);
      }
      return;
    }
    const stdout = initial
      ? execFileSync("ps", ["-o", "pid=,ppid=,rss=", "-A"], { encoding: "utf8" })
      : (await execFileAsync("ps", ["-o", "pid=,ppid=,rss=", "-A"])).stdout;
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const line of stdout.split("\n")) {
      const [pid, ppid, kib] = line.trim().split(/\s+/u).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(kib)) continue;
      rss.set(pid!, kib!);
      children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
    }
    if (!rss.has(rootPid)) return;
    let total = 0;
    for (const queue = [rootPid]; queue.length > 0;) {
      const pid = queue.pop()!;
      total += rss.get(pid) ?? 0;
      queue.push(...(children.get(pid) ?? []));
    }
    samples += 1;
    peakKiB = Math.max(peakKiB, total);
  };
  return (async () => {
    await sample(true);
    if (samples === 0) {
      throw new Error(`Process tree root ${rootPid} was unavailable before its first RSS sample`);
    }
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!done) await sample();
    }
    return { peakRssBytes: peakKiB * 1024, samples };
  })();
}

it.runIf(process.platform === "darwin" || process.platform === "linux")("samples a live child before its immediate exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  try {
    const measurement = sampleProcessTree(child.pid!, exited);
    child.kill();
    const result = await measurement;
    expect(result.samples).toBeGreaterThan(0);
    expect(result.peakRssBytes).toBeGreaterThan(0);
  } finally {
    child.kill();
    await exited;
  }
});

it.runIf(process.platform === "darwin" || process.platform === "linux")("reports a child that exited before its first sample", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  await exited;
  await expect(sampleProcessTree(child.pid!, exited)).rejects.toThrow(
    `Process tree root ${child.pid!} was unavailable before its first RSS sample`,
  );
});

/** The cross-language smoke under the real wrap (§9.7 P5, §10.1): the Python fixture installed where a plugin lives, with a v4 receipt at rung `release` that the production
 * integrity check verifies and P3's provenance gate admits, run by the production factory under the live sandbox; with `observeChild` as the cases' only view of the child. */
describe("the python smoke, confined by the production factory", () => {
  const PYTHON_SMOKE_ID = "python-smoke";
  /** Stands in for the pinned release zip's hash; the gate reads that it is pinned. */
  const ARTIFACT_SHA256 = "c".repeat(64);
  interface PinnedPythonFixture {
    readonly fx: Fixture;
    readonly plugin: InstalledPlugin;
    readonly manifest: PluginManifest;
    readonly integrity: Awaited<ReturnType<typeof verifyPluginIntegrity>>;
  }
  const ownedFixtures: Fixture[] = [];
  let prepared: Promise<Map<string, PinnedPythonFixture>> | undefined;

  afterAll(async () => {
    await prepared?.catch(() => undefined);
    for (const fx of ownedFixtures) {
      rmSync(fx.ungrantedTempDir, { recursive: true, force: true });
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  /** One immutable artifact supplies every launcher; each case gets a fresh child. */
  async function preparePinnedPythonFixtures(): Promise<Map<string, PinnedPythonFixture>> {
    const began = performance.now();
    const fx = makeFixture();
    ownedFixtures.push(fx);
    const plugin = installPlugin(fx, PYTHON_SMOKE_ID);
    installPythonSmoke(plugin.pluginRoot);
    const original = readFileSync(join(plugin.pluginRoot, "bin", "plugin"), "utf-8");
    const variants = [
      { preamble: "", command: "./bin/plugin" },
      { preamble: "echo ready", command: "./bin/plugin-bare-line" },
      { preamble: "printf 'Content-Length: 120\\r\\n\\r\\n'", command: "./bin/plugin-header" },
    ];
    for (const { preamble, command } of variants) {
      if (preamble === "") continue;
      const launcher = join(plugin.pluginRoot, command);
      writeFileSync(launcher, original.replace("set -eu\n", `set -eu\n${preamble}\n`), "utf-8");
      chmodSync(launcher, 0o755);
    }
    const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(plugin.pluginRoot, "plugin.json"), "utf-8")));
    if (!manifest.process) throw new Error("The smoke fixture must declare a process launcher");
    const installedAt = performance.now();
    const { receipt } = await buildGitInstallReceipt(plugin.pluginRoot, {
      pluginId: PYTHON_SMOKE_ID,
      version: manifest.version,
      artifactSha256: ARTIFACT_SHA256,
      git: {
        sourceId: "official",
        sourceOrigin: "official",
        snapshotCommit: "a".repeat(40),
        versionCommit: "b".repeat(40),
        packagePath: `plugins/${PYTHON_SMOKE_ID}`,
        rung: "release",
        rungs: [{ rung: "release", outcome: "used" }],
      },
      files: await listFilesRecursive(plugin.pluginRoot, PLUGIN_RUNTIME_DIR_NAMES),
    });
    const hashedAt = performance.now();
    const cacheRoot = join(fx.root, "receipts");
    await writeInstallReceipt(cacheRoot, receipt);
    const integrity = await verifyPluginIntegrity(cacheRoot, PYTHON_SMOKE_ID, plugin.pluginRoot);
    reportSmoke("fixture preparation", {
      installMs: Math.round(installedAt - began),
      receiptMs: Math.round(hashedAt - installedAt),
      integrityMs: Math.round(performance.now() - hashedAt),
    });
    // All launcher bytes are covered before any child runs. Selecting an entry inside this same read-only root needs no extra filesystem authority.
    return new Map(variants.map(({ preamble, command }) => [preamble, {
      fx,
      plugin,
      manifest: { ...manifest, process: { ...manifest.process, command } },
      integrity,
    }]));
  }

  async function installPinnedPythonSmoke(launcherPreamble = ""): Promise<PinnedPythonFixture> {
    // Provisioning keeps the existing test's cold-install budget. Reuse this one promise, including rejection, rather than rebuilding a missing fixture.
    prepared ??= preparePinnedPythonFixtures();
    const pinned = (await prepared).get(launcherPreamble);
    if (!pinned) throw new Error("No prepared launcher matches the requested preamble");
    const { fx, plugin, manifest, integrity } = pinned;
    expect(integrity).toEqual({
      ok: true,
      verified: { installSource: "git", artifactSha256: ARTIFACT_SHA256, signerKeyId: null, rung: "release", sourceOrigin: "official" },
    });
    assertProcessEntryAdmitted(manifest, integrity.ok ? integrity.verified : undefined);
    // Only writable state is reset. Receipt-covered payloads stay unchanged until all fresh child processes and their cases have finished.
    for (const name of PLUGIN_RUNTIME_DIR_NAMES) rmSync(join(plugin.pluginRoot, name), { recursive: true, force: true });
    mkdirSync(plugin.pluginDataDir, { recursive: true, mode: 0o700 });
    process.env.AVE_HOME = fx.aveHome;
    return pinned;
  }

  interface ObservedRun {
    readonly instance: RuntimePlugin;
    readonly child: ObservedPluginChild;
    readonly stdout: Buffer[];
    readonly spawnToConstructMs: number;
    readonly tree: Promise<TreeMeasurement>;
  }

  const running = new Map<ObservedRun, { exited: boolean }>();

  afterEach(async () => {
    for (const [run, state] of running) {
      try {
        // The observed exit is terminal. EOF cases need no stop or signal; failure cleanup stops only a child whose exit was not observed.
        if (!state.exited) await run.instance.stop!();
      } finally {
        await run.child.exited;
        await run.tree;
        running.delete(run);
      }
    }
  });

  /** The production factory over the pinned install, observed from its spawn. */
  async function runObserved(fx: Fixture, plugin: InstalledPlugin, manifest: PluginManifest): Promise<ObservedRun> {
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    let observed: ObservedPluginChild | undefined;
    let spawnedAt = 0;
    let tree: Promise<TreeMeasurement> | undefined;
    const stdout: Buffer[] = [];
    const factory = createOutOfProcessPluginFactory({
      manifest,
      launch: { kind: "process", ...resolveProcessLaunch(manifest, plugin.pluginRoot, plugin.pluginDataDir) },
      observeChild: (child) => {
        observed = child;
        spawnedAt = performance.now();
        child.onStdout((chunk) => stdout.push(chunk));
        tree = sampleProcessTree(child.pid!, child.exited);
        void tree.catch(() => undefined);
      },
    });
    let instance: RuntimePlugin;
    try {
      instance = await factory(processContext(fx, plugin));
    } catch (error) {
      // Construction starts teardown asynchronously. Join the spawned child's terminal exit and sampler before a later case resets its runtime dirs.
      const child = observed as ObservedPluginChild | undefined;
      await Promise.allSettled([child?.exited, tree]);
      throw error;
    }
    const run = {
      instance,
      child: observed!,
      stdout,
      spawnToConstructMs: Math.round(performance.now() - spawnedAt),
      tree: tree!,
    };
    reportSmoke("construct phase", { spawnToConstructMs: run.spawnToConstructMs });
    const state = { exited: false };
    running.set(run, state);
    void run.child.exited.then(() => { state.exited = true; });
    return run;
  }

  /** Construct, start, one `tools/call` and stop, as the lifecycle drives them. */
  async function driveLifecycle(run: ObservedRun): Promise<void> {
    const began = performance.now();
    await run.instance.start!();
    const startedAt = performance.now();
    await expect(run.instance.handlers.echo!({ said: "confined" })).resolves.toEqual({ echoed: { said: "confined" } });
    const calledAt = performance.now();
    await run.instance.stop!();
    await run.child.exited;
    reportSmoke("lifecycle phases", {
      startMs: Math.round(startedAt - began),
      toolMs: Math.round(calledAt - startedAt),
      stopMs: Math.round(performance.now() - calledAt),
    });
  }

  /** The child's own `ru_maxrss` from its stop log, in bytes: darwin reports bytes, linux KiB. */
  function childRuMaxrssBytes(stdout: Buffer): number {
    const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
    const stopLog = decoder.push(stdout).find(
      (frame) => frame.method === "notifications/ave/log"
        && typeof (frame.params as { meta?: { ruMaxrss?: unknown } }).meta?.ruMaxrss === "number",
    );
    const value = (stopLog!.params as { meta: { ruMaxrss: number } }).meta.ruMaxrss;
    return process.platform === "darwin" ? value : value * 1024;
  }

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "runs construct, start, tools/call and stop over the real wrap, with nothing on stdout but frames",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const { fx, plugin, manifest } = await installPinnedPythonSmoke();
      const run = await runObserved(fx, plugin, manifest);
      expect(isPluginChildConfined(plugin.pluginId)).toBe(true);
      expect(run.child.pid).toEqual(expect.any(Number));
      await driveLifecycle(run);
      const tree = await run.tree;
      const stdout = Buffer.concat(run.stdout);
      expect(rawStdoutViolations(stdout)).toEqual([]);
      reportSmoke("confined measurement", {
        platform: process.platform,
        fixture: PYTHON_SMOKE_ID,
        spawnToConstructMs: run.spawnToConstructMs,
        treePeakRssBytes: tree.peakRssBytes,
        treeSamples: tree.samples,
        childRuMaxrssBytes: childRuMaxrssBytes(stdout),
      });
      expect(tree.samples).toBeGreaterThan(0);
    },
    600_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "exits within five seconds of its stdin closing, with no request from the host and no termination",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const { fx, plugin, manifest } = await installPinnedPythonSmoke();
      const run = await runObserved(fx, plugin, manifest);
      // What a crashed host looks like to the child: stdin ends. No `stop`, no signal.
      run.child.endInput();
      const outcome = await Promise.race([
        run.child.exited.then(() => "exited"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 5_000)),
      ]);
      // Only a child that failed the rule is terminated, and only after the failure is recorded; its stop hook
      // may not answer either, so how the stop went is reported beside the failure rather than in place of it.
      let stopped = "";
      if (outcome !== "exited") {
        stopped = await Promise.resolve(run.instance.stop!()).then(
          () => "; then stopped",
          (error: unknown) => `; then stop failed: ${String(error)}`,
        );
      }
      expect(`${outcome}${stopped}`).toBe("exited");
    },
    600_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux").each([
    ["a bare line before its first frame", "echo ready"],
    ["a Content-Length header", "printf 'Content-Length: 120\\r\\n\\r\\n'"],
  ])(
    "fails the raw stdout check for %s, which the decoder tolerates",
    async (_label, preamble) => {
      if (!(await sandboxCasesRun())) return;
      const { fx, plugin, manifest } = await installPinnedPythonSmoke(preamble);
      const run = await runObserved(fx, plugin, manifest);
      // The decoder still yields every frame: the whole lifecycle answers.
      await driveLifecycle(run);
      await run.tree;
      expect(rawStdoutViolations(Buffer.concat(run.stdout))).not.toEqual([]);
    },
    600_000,
  );
});

describe("the sandbox temp directories", () => {
  // ASRT writes `TMPDIR=<shared root>` ahead of every wrapped command. Each confined process instead gets its principal's directory under that root; its plugin's, for a plugin child, worker or bundled hook; its own, for an MCP
  // stdio server; set as `TMPDIR` inside the wrap, granted alone, with the root read-denied. ASRT reads are deny-only and `0o700` stops no process of the same user, so the grants are the whole of the isolation measured here.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "no principal reaches another's temp files: two plugin children, a worker, a bundled hook and an MCP stdio wrap",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      // Short, for the worker's control-socket path to fit `sun_path`; every principal runs under it, so all of them share one temp root.
      const home = mkdtempSync(join("/tmp", "lvt-"));
      process.env.AVE_HOME = home;
      try {
        const root = appOwnedSandboxTempRoot();
        const pluginA = installTempPlugin(home, "temp-a");
        const pluginB = installTempPlugin(home, "temp-b");
        const a: SandboxTempPrincipal = { kind: "plugin", id: "temp-a" };
        const b: SandboxTempPrincipal = { kind: "plugin", id: "temp-b" };
        const hook: SandboxTempPrincipal = { kind: "plugin", id: "temp-hook" };
        // The plugin's own id, as an MCP server's: the kind keeps them apart.
        const server: SandboxTempPrincipal = { kind: "mcp", id: "temp-a" };
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

        const childA = await runTempProbe(fx, a, "child-a", [], (probe) => runPluginChildToExit(pluginA, probe));
        expectOwnTemp(childA, a, "child-a");

        const childB = await runTempProbe(fx, b, "child-b", [tempTarget(a, "child-a")],
          (probe) => runPluginChildToExit(pluginB, probe));
        expectOwnTemp(childB, b, "child-b");
        expectTempRefused(childB, "child-b", [tempTarget(a, "child-a")]);

        // The positive control for the refusals: a worker of plugin B shares B's directory, so the same reads and writes that fail across principals succeed within one.
        const workerB = await runTempProbe(fx, b, "worker-b", [tempTarget(b, "child-b"), tempTarget(a, "child-a")],
          async (probe) => {
            const worker = await spawnWorker({
              pluginId: "temp-b",
              workerId: "w",
              command: process.execPath,
              args: [probe],
              env: { ELECTRON_RUN_AS_NODE: "1" },
            });
            await new Promise<void>((resolve) => worker.onExit(() => resolve()));
          });
        expectOwnTemp(workerB, b, "worker-b");
        expect(workerB.others[0]!.read.ok, JSON.stringify(workerB.others[0])).toBe(true);
        expect(workerB.others[0]!.read.value).toBe("child-b");
        expect(workerB.others[0]!.write.ok, JSON.stringify(workerB.others[0])).toBe(true);
        expectTempRefused({ ...workerB, others: workerB.others.slice(1) }, "worker-b", [tempTarget(a, "child-a")]);

        const hookRun = await runTempProbe(fx, hook, "hook", [tempTarget(b, "child-b"), tempTarget(a, "child-a")],
          async (probe) => {
            const dataDir = mkdtempSync(join(fx.root, "temp-hook-data-"));
            const result = await runOneHookScript(
              { id: "temp", hookType: "pre", source: "config", hookPath: probe,
                command: ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", process.execPath, probe],
                confinement: { kind: "bundled", pluginId: "temp-hook", dataDir, generationRoot: dirname(probe) } },
              { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
                sessionId: "temp", trustOrigin: "user-keyboard" },
              { timeoutMs: 10_000 },
            );
            expect(result.decision, result.reason).toBe("allow");
          });
        expectOwnTemp(hookRun, hook, "hook");
        expectTempRefused(hookRun, "hook", [tempTarget(b, "child-b"), tempTarget(a, "child-a")]);

        const serverRun = await runTempProbe(fx, server, "server", [tempTarget(a, "child-a"), tempTarget(hook, "hook")],
          (probe) => runBundledWrapToExit(server, probe));
        expectOwnTemp(serverRun, server, "server");
        expectTempRefused(serverRun, "server", [tempTarget(a, "child-a"), tempTarget(hook, "hook")]);

        // And back the other way: the first child, run again, reaches none of the principals that came after it.
        const again = await runTempProbe(fx, a, "child-a-again",
          [tempTarget(b, "child-b"), tempTarget(hook, "hook"), tempTarget(server, "server")],
          (probe) => runPluginChildToExit(pluginA, probe));
        expectOwnTemp(again, a, "child-a-again");
        expectTempRefused(again, "child-a-again", [tempTarget(b, "child-b"), tempTarget(hook, "hook"), tempTarget(server, "server")]);
        expect(readdirSync(root).sort()).toEqual([a, b, hook, server].map(sandboxTempPrincipalDirName).sort());
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "no confined process reads another's sandbox HOME: an MCP stdio wrap, a plugin child and a bundled hook",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      // A's HOME is kept for the whole case, so B and C try to read a file that is there; theirs are removed when they exit, as in production.
      const homeA = createSandboxProcessHome();
      const homeRoot = realpathSync(appOwnedSandboxHomeRoot());
      try {
        const server: SandboxTempPrincipal = { kind: "mcp", id: "home-a" };
        const a = await runHomeProbe(fx, server, "home-a", [], homeRoot,
          (probe) => runBundledWrapToExit(server, probe, homeA));
        expectOwnHome(a, homeRoot, "home-a");
        expect(a.home).toBe(homeA.path);
        expect(readFileSync(join(homeA.path, "home-a"), "utf-8")).toBe("home-a");
        const fileA = join(homeA.path, "home-a");

        const pluginB = installPlugin(fx, "home-b");
        const b = await runHomeProbe(fx, { kind: "plugin", id: "home-b" }, "home-b", [fileA], homeRoot,
          (probe) => runPluginChildToExit(pluginB, probe));
        expectOwnHome(b, homeRoot, "home-b");
        expectHomeRefused(b, fileA);

        const hookPrincipal: SandboxTempPrincipal = { kind: "plugin", id: "home-c" };
        const c = await runHomeProbe(fx, hookPrincipal, "home-c", [fileA], homeRoot, async (probe) => {
          const dataDir = mkdtempSync(join(fx.root, "home-hook-data-"));
          const result = await runOneHookScript(
            { id: "home", hookType: "pre", source: "config", hookPath: probe,
              command: ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", process.execPath, probe],
              confinement: { kind: "bundled", pluginId: "home-c", dataDir, generationRoot: dirname(probe) } },
            { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
              sessionId: "home", trustOrigin: "user-keyboard" },
            { timeoutMs: 10_000 },
          );
          expect(result.decision, result.reason).toBe("allow");
        });
        expectOwnHome(c, homeRoot, "home-c");
        expectHomeRefused(c, fileA);
        // The control for both refusals: the bytes were there all along.
        expect(readFileSync(fileA, "utf-8")).toBe("home-a");
      } finally {
        homeA.cleanup();
      }
    },
    120_000,
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a bundled hook writes under its $TMPDIR, and cannot rename or remove that directory",
    async () => {
      if (!(await sandboxCasesRun())) return;
      const fx = fixture!;
      const tempDir = join(appOwnedSandboxTempRoot(), sandboxTempPrincipalDirName({ kind: "plugin", id: "tmp-plugin" }));
      ensureSandboxTempPrincipalDir({ kind: "plugin", id: "tmp-plugin" });
      const before = emptyRemovableRoot(tempDir);
      const generationRoot = mkdtempSync(join(fx.root, "hook-generation-"));
      const dataDir = mkdtempSync(join(fx.root, "hook-data-"));
      const script = join(generationRoot, "tmp.sh");
      const inventoryReport = join(dataDir, "root-entries.json");
      const node = `'${process.execPath.replace(/'/g, "'\\''")}'`;
      writeFileSync(
        script,
        "#!/bin/sh\n"
          + `NODE=${node}\n`
          + 'ROOT_ENTRIES_REPORT="$PLUGIN_DATA/root-entries.json"\n'
          + "echo probe > \"$TMPDIR/hook-tmp-probe\" 2>/dev/null\nwrote=$?\n"
          + "/bin/rm -f \"$TMPDIR/hook-tmp-probe\"\n"
          + rootEntriesScript("$TMPDIR")
          + "ELECTRON_RUN_AS_NODE=1 \"$NODE\" -e 'process.exit(0)' 2>/dev/null\nnode=$?\n"
          + "ELECTRON_RUN_AS_NODE=1 \"$NODE\" -e 'require(\"fs\").renameSync(process.argv[1], process.argv[2])' "
          + "\"$TMPDIR\" \"$HOME/moved-tmp\" 2>/dev/null\nrenamed=$?\n"
          + rootRemovalScript("$TMPDIR")
          + "printf '{\"action\":\"allow\",\"reason\":\"%s %s %s %s %s\"}' "
          + "\"$wrote\" \"$entries\" \"$node\" \"$renamed\" \"$removed\"\n",
        "utf-8",
      );
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const result = await runOneHookScript(
        { id: "tmp", hookType: "pre", source: "config", hookPath: script, command: ["/bin/sh", script],
          confinement: { kind: "bundled", pluginId: "tmp-plugin", dataDir, generationRoot } },
        { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
          sessionId: "hook-tmp", trustOrigin: "user-keyboard" },
        { timeoutMs: 10_000 },
      );
      expect(result.decision, result.reason).toBe("allow");
      const [wrote, entries, node_, renamed, removed] = result.reason.split(" ");
      expect(wrote, "the hook could not write under its TMPDIR").toBe("0");
      expect(entries, "the hook could not report its temp directory inventory").toBe("0");
      expectProtectedRootEntries(inventoryReport, tempDir);
      expect(node_, "Node did not run under the wrap, so the rename measured nothing").toBe("0");
      expect(renamed, "the hook renamed its temp directory").not.toBe("0");
      expectRootRemovalRefused(removed!);
      await resetAsrtSandbox();
      const after = lstatSync(tempDir);
      expect(after.isDirectory()).toBe(true);
      expect(after.ino).toBe(before.ino);
      expect(after.dev).toBe(before.dev);
      expect(readdirSync(tempDir), "runtime-owned placeholders survived cleanup").toEqual([]);
    },
    120_000,
  );
});

/** A plugin installed under `home`, for the cases that need a short AVE_HOME. */
function installTempPlugin(home: string, pluginId: string): InstalledPlugin {
  const pluginRoot = join(home, "plugins", pluginId);
  const pluginDataDir = join(pluginRoot, "data");
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  return { pluginId, pluginRoot, pluginDataDir };
}

/** A file another principal left in its temp directory, and that directory. */
interface TempTarget {
  readonly file: string;
  readonly dir: string;
  readonly marker: string;
}

function tempDirOf(principal: SandboxTempPrincipal): string {
  return join(appOwnedSandboxTempRoot(), sandboxTempPrincipalDirName(principal));
}

function tempTarget(principal: SandboxTempPrincipal, marker: string): TempTarget {
  return { file: join(tempDirOf(principal), marker), dir: tempDirOf(principal), marker };
}

interface TempProbeReport {
  readonly tmpdir: string;
  readonly writeOwn: ProbeAttempt;
  readonly listRoot: ProbeAttempt & { readonly value?: string[] };
  readonly others: ReadonlyArray<{ readonly read: ProbeAttempt; readonly write: ProbeAttempt }>;
}

/** Run one confined process that writes `<marker>` into its own `tmpdir()`, reads and writes into each `other` directory, lists the shared root, and leaves its report
 * in its OWN temp directory; which the host reads from the principal's directory, so a process whose `TMPDIR` named anything else leaves no report where the host looks. */
async function runTempProbe(
  fx: Fixture,
  principal: SandboxTempPrincipal,
  marker: string,
  others: readonly TempTarget[],
  run: (probe: string) => Promise<void>,
): Promise<TempProbeReport> {
  for (const other of others) {
    // The control for every refusal below: the bytes are there for the host.
    expect(readFileSync(other.file, "utf-8"), `${other.file} is not there to be refused`).toBe(other.marker);
  }
  const probe = join(fx.root, `temp-probe-${marker}.mjs`);
  writeFileSync(
    probe,
    `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const p = ${JSON.stringify({ marker, others, root: appOwnedSandboxTempRoot() })};
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
const own = tmpdir();
const report = {
  tmpdir: own,
  writeOwn: attempt(() => { writeFileSync(join(own, p.marker), p.marker); return "written"; }),
  others: p.others.map((other) => ({
    read: attempt(() => readFileSync(other.file, "utf-8")),
    write: attempt(() => { writeFileSync(join(other.dir, "planted-by-" + p.marker), "planted"); return "written"; }),
  })),
  listRoot: attempt(() => readdirSync(p.root)),
};
writeFileSync(join(own, "report-" + p.marker + ".json"), JSON.stringify(report));
process.stdout.write(JSON.stringify({ action: "allow", reason: "probed" }));
`,
    "utf-8",
  );
  await run(probe);
  const reportPath = join(tempDirOf(principal), `report-${marker}.json`);
  expect(existsSync(reportPath), `${marker} left no report in its principal's temp directory`).toBe(true);
  return JSON.parse(readFileSync(reportPath, "utf-8")) as TempProbeReport;
}

/** Its TMPDIR is its principal's directory, it can write there, and the bytes last. */
function expectOwnTemp(report: TempProbeReport, principal: SandboxTempPrincipal, marker: string): void {
  expect(realpathSync(report.tmpdir), `${marker}: TMPDIR is not its principal's directory`).toBe(realpathSync(tempDirOf(principal)));
  expect(report.writeOwn.ok, `${marker}: ${JSON.stringify(report.writeOwn)}`).toBe(true);
  expect(readFileSync(join(tempDirOf(principal), marker), "utf-8")).toBe(marker);
  // The shared root is read-denied: refused on macOS; on Linux it is an empty tmpfs with only this principal's directory bound back into it.
  if (report.listRoot.ok) {
    expect(report.listRoot.value, `${marker}: listed other principals' directories`)
      .toEqual([sandboxTempPrincipalDirName(principal)]);
  }
}

/** Every other principal's file stayed unread, and nothing was planted beside it. */
function expectTempRefused(report: TempProbeReport, marker: string, others: readonly TempTarget[]): void {
  expect(report.others).toHaveLength(others.length);
  others.forEach((other, index) => {
    const attempt = report.others[index]!;
    expect(attempt.read.ok, `read ${other.file}: ${JSON.stringify(attempt.read)}`).toBe(false);
    expect(attempt.read.value).toBeUndefined();
    expect(attempt.write.ok, `write beside ${other.file}: ${JSON.stringify(attempt.write)}`).toBe(false);
    expect(existsSync(join(other.dir, `planted-by-${marker}`)), `${marker} planted a file beside ${other.file}`).toBe(false);
  });
}

interface HomeProbeReport {
  readonly home: string;
  readonly writeOwn: ProbeAttempt;
  readonly readOwn: ProbeAttempt;
  readonly listRoot: ProbeAttempt & { readonly value?: string[] };
  readonly others: readonly ProbeAttempt[];
}

/** Run one confined process that writes `<marker>` under its `$HOME`, reads it back, reads each of `others`, and lists the HOME
 * root. Its HOME is removed when a plugin child or hook exits, so the report goes to its principal's temp directory, which lasts. */
async function runHomeProbe(
  fx: Fixture,
  principal: SandboxTempPrincipal,
  marker: string,
  others: readonly string[],
  homeRoot: string,
  run: (probe: string) => Promise<void>,
): Promise<HomeProbeReport> {
  const probe = join(fx.root, `home-probe-${marker}.mjs`);
  writeFileSync(
    probe,
    `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const p = ${JSON.stringify({ marker, others, homeRoot })};
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
const home = homedir();
const report = {
  home,
  writeOwn: attempt(() => { writeFileSync(join(home, p.marker), p.marker); return "written"; }),
  readOwn: attempt(() => readFileSync(join(home, p.marker), "utf-8")),
  others: p.others.map((file) => attempt(() => readFileSync(file, "utf-8"))),
  listRoot: attempt(() => readdirSync(p.homeRoot)),
};
writeFileSync(join(tmpdir(), "home-report-" + p.marker + ".json"), JSON.stringify(report));
process.stdout.write(JSON.stringify({ action: "allow", reason: "probed" }));
`,
    "utf-8",
  );
  await run(probe);
  const reportPath = join(tempDirOf(principal), `home-report-${marker}.json`);
  expect(existsSync(reportPath), `${marker} left no report in its principal's temp directory`).toBe(true);
  return JSON.parse(readFileSync(reportPath, "utf-8")) as HomeProbeReport;
}

/** Its HOME is a host-made directory under the HOME root, its own to write and read. */
function expectOwnHome(report: HomeProbeReport, homeRoot: string, marker: string): void {
  expect(dirname(report.home), `${marker}: HOME is not under the sandbox HOME root`).toBe(homeRoot);
  expect(report.writeOwn.ok, `${marker}: ${JSON.stringify(report.writeOwn)}`).toBe(true);
  expect(report.readOwn.value, `${marker}: ${JSON.stringify(report.readOwn)}`).toBe(marker);
  // The root is read-denied: refused on macOS; on Linux an empty tmpfs with only this process's HOME bound back into it.
  if (report.listRoot.ok) {
    expect(report.listRoot.value, `${marker}: listed other processes' HOMEs`).toEqual([basename(report.home)]);
  }
}

function expectHomeRefused(report: HomeProbeReport, file: string): void {
  expect(report.others[0]!.ok, `read ${file}: ${JSON.stringify(report.others[0])}`).toBe(false);
  expect(report.others[0]!.value).toBeUndefined();
}

/** Run a plugin child whose entry is `entry`, and wait for it to exit. */
async function runPluginChildToExit(plugin: InstalledPlugin, entry: string): Promise<void> {
  const child = await spawnConfinedPluginChild({
    pluginId: plugin.pluginId,
    socketDir: resolvePluginSocketDir(plugin.pluginDataDir),
    workerRunRoot: resolvePluginWorkerRunRoot(plugin.pluginDataDir),
    envelope: derivePluginChildEnvelope({
      pluginId: plugin.pluginId,
      pluginRoot: plugin.pluginRoot,
      pluginDataDir: plugin.pluginDataDir,
      configValue: () => undefined,
    }),
    launch: { kind: "entry", childEntryPath: entry },
  });
  await new Promise<void>((resolve, reject) => {
    child.link.input.on("data", () => undefined);
    child.link.input.on("end", () => resolve());
    child.link.input.on("error", reject);
  });
}

/** Run `probe` the way an MCP stdio server is run: `wrapBundledCommand`, then spawn. A `home` the caller passes is the caller's to remove. */
async function runBundledWrapToExit(
  principal: SandboxTempPrincipal,
  probe: string,
  home?: ReturnType<typeof createSandboxProcessHome>,
): Promise<void> {
  const sandboxHome = home ?? createSandboxProcessHome();
  try {
    const { argv, env, egress } = await wrapBundledCommand({
      egressOwner: { kind: "worker", role: principal.kind === "mcp" ? "mcp-server" : "hook", pluginId: principal.kind === "plugin" ? principal.id : undefined, instanceId: principal.id },
      command: process.execPath,
      args: [probe],
      sandboxHome,
      allowWrite: [],
      ownPluginReads: [],
      tempPrincipal: principal,
    });
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "ignore", "ignore"],
        env: bundledWrappedEnv(buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }), env, sandboxHome.env),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
    } finally {
      egress.release();
      await cleanupAsrtSandboxAfterCommand();
    }
  } finally {
    if (home === undefined) sandboxHome.cleanup();
  }
}

/** Use the rename syscall, not a utility that may copy on EXDEV, to test pinned roots.
 * Keep the inventory outside the target and a successful binary launch as the control; the runtime-as-node flag also works under the desktop test runner. */
function rootSwapScript(preamble: string, emit: string): string {
  const node = `'${process.execPath.replace(/'/g, "'\\''")}'`;
  return "#!/bin/sh\n" + preamble
    + `NODE=${node}\n`
    + "/bin/mkdir \"$PLUGIN_DATA/inside\" && /bin/rmdir \"$PLUGIN_DATA/inside\"\ninside=$?\n"
    + rootEntriesScript("$PLUGIN_DATA")
    + "ELECTRON_RUN_AS_NODE=1 \"$NODE\" -e 'process.exit(0)' 2>/dev/null\nnode=$?\n"
    + "ELECTRON_RUN_AS_NODE=1 \"$NODE\" -e 'require(\"fs\").renameSync(process.argv[1], process.argv[2])' "
    + "\"$PLUGIN_DATA\" \"$ELSEWHERE/moved-root\" 2>/dev/null\nrenamed=$?\n"
    + "removed=skipped\n"
    + `if [ -d "$PLUGIN_DATA" ]; then ${rootRemovalScript("$PLUGIN_DATA")}fi\n`
    + "[ -e \"$PLUGIN_DATA\" ] || /bin/ln -s \"$OUTSIDE\" \"$PLUGIN_DATA\"\n"
    + `result="$inside $entries $node $renamed $removed"\n${emit}\nexit 0\n`;
}

/** The root is where and what it was, and nothing reached past it. */
function expectRootHeld(
  result: string,
  inventoryReport: string,
  dataDir: string,
  before: Stats,
  elsewhere: string | undefined,
  outside: string,
): void {
  const [inside, entries, node, renamed, removed] = result.trim().split(" ");
  expect(inside, "the code could not write inside its root").toBe("0");
  expect(entries, "the code could not report its root inventory").toBe("0");
  expectProtectedRootEntries(inventoryReport, dataDir);
  expect(node, "Node did not run under the wrap, so the rename below measured nothing").toBe("0");
  expect(renamed, "the code renamed its data root into another write root").not.toBe("0");
  expectRootRemovalRefused(removed!);
  const after = lstatSync(dataDir);
  expect(after.isSymbolicLink()).toBe(false);
  expect(after.isDirectory()).toBe(true);
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
  expect(readdirSync(dataDir), "runtime-owned placeholders survived cleanup").toEqual([]);
  if (elsewhere !== undefined) expect(existsSync(join(elsewhere, "moved-root"))).toBe(false);
  expect(readdirSync(outside)).toEqual([]);
}

/** Prove the fixture root is empty and removable before native mounts exist. */
function emptyRemovableRoot(root: string): Stats {
  expect(readdirSync(root), "the fixture root was not empty before wrapping").toEqual([]);
  const before = lstatSync(root);
  expect(before.isSymbolicLink()).toBe(false);
  expect(before.isDirectory()).toBe(true);
  rmdirSync(root);
  mkdirSync(root, { mode: before.mode & 0o777 });
  return lstatSync(root);
}

/** Write every mounted entry outside the target root, beyond any hook output limit. */
function rootEntriesScript(root: string): string {
  const inspect = 'const fs=require("fs"),path=require("path"),root=process.argv[1]; '
    + 'const entries=fs.readdirSync(root).sort().map(name=>{const entry=path.join(root,name),stat=fs.lstatSync(entry); '
    + 'return {name,kind:stat.isDirectory()?"directory":stat.isCharacterDevice()?"device":"other",'
    + 'empty:stat.isDirectory()?fs.readdirSync(entry).length===0:stat.size===0};}); '
    + 'fs.writeFileSync(process.argv[2],JSON.stringify({root,entries}),{mode:0o600});';
  return `ELECTRON_RUN_AS_NODE=1 "$NODE" -e '${inspect}' "${root}" "$ROOT_ENTRIES_REPORT"\nentries=$?\n`;
}

/** Capture the syscall error: a non-empty-directory refusal proves no root pin. */
function rootRemovalScript(root: string): string {
  const remove = 'try{require("fs").rmdirSync(process.argv[1]);process.stdout.write("removed");}'
    + 'catch(error){process.stdout.write(error.code??error.name);}';
  return `removed=$(ELECTRON_RUN_AS_NODE=1 "$NODE" -e '${remove}' "${root}")\n`;
}

function expectRootRemovalRefused(code: string): void {
  // A mounted target or its read-only parent can refuse before inspecting contents.
  const expected = process.platform === "linux" ? ["EBUSY", "EROFS"] : ["EPERM", "EACCES"];
  expect(expected, `root removal returned ${code}; directory contents are not proof of a pinned root`).toContain(code);
}

/** Empty before wrapping; inside Linux only the policy's typed deny mounts may appear. */
function expectProtectedRootEntries(reportPath: string, root: string): void {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { root: string; entries: unknown };
  const canonicalRoot = realpathSync(root);
  expect(realpathSync(reportPath).startsWith(`${canonicalRoot}/`), "the inventory report polluted the measured root").toBe(false);
  expect(realpathSync(report.root), "the inventory came from another sandbox directory").toBe(canonicalRoot);
  const mandatory = buildMandatorySandboxWritePolicy([canonicalRoot]).denyWrite.map(entry => typeof entry === "string" ? entry : entry.path);
  // A nested deny target (`.claude/hooks`) makes the runtime create its top-level parent too.
  const names = [...new Set(mandatory.filter(path => path.startsWith(`${canonicalRoot}/`))
    .map(path => path.slice(canonicalRoot.length + 1).split("/")[0]!))].sort();
  const expected = process.platform === "linux" ? names.map(name => ({
    name,
    kind: mandatory.some(path => path.startsWith(join(canonicalRoot, name) + "/")) ? "directory" : "device",
    empty: true,
  })) : [];
  expect(report.entries, "only mandatory runtime-created empty deny mounts may occupy the fixture root").toEqual(expected);
}
