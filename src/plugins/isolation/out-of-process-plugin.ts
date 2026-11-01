/** Isolated factories preserve the runtime contract (docs/blueprints/plugin-process-isolation.md).
 * Worker confinement is independent of shell confinement: disabled children receive no isolation relaxation; enabled wrapping is mandatory and failure prevents loading. */
import { mkdirSync, statSync } from "node:fs";
import { sameFileIdentity, type FileIdentity } from "../../lib/file-identity.js";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { ENV_NAME_RE } from "../../mcp/safe-names.js";
import { ProcessEntryUnconfinedError, type ProcessLaunch } from "../process-entry.js";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { createLogger } from "../../lib/logger.js";
import {
  NODE_PRESERVE_SYMLINK_FLAGS,
  resolvePluginChildEntryPath,
  spawnConfinedChild,
  srtWinTargetEnv,
  type SpawnConfinement,
} from "../../permissions/confined-child.js";
import {
  markPluginChildConfined,
  unmarkPluginChildConfined,
} from "../../permissions/sandbox-capability.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import {
  cleanupAsrtSandboxAfterCommand,
  isPluginWorkerConfinementActive,
  assertExtensionStartAllowed,
  outermostContainingRoots,
  pluginGrantPathsBeyondOwnRoots,
  protectedReadDenyCovering,
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
} from "../../permissions/asrt-sandbox.js";
import { holdWindowsFilesystemGrant, type HeldWindowsGrant } from "../../permissions/windows-acl-grant-holder.js";
import {
  resolvePluginSocketDir,
  resolvePluginWorkerRunRoot,
  writeGrantsReachingHostStorage,
} from "../plugin-storage-layout.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { terminateChildProcess } from "../../tools/terminate-child-process.js";
import {
  isPathAllowed,
  sanitizeAllowedDirectories,
} from "../../permissions/allowed-directories.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";
import { aveHome } from "../../shared/ave-home.js";
import { HOST_DIRECTORY_CATALOG, hostDirectoryFloorPierces } from "../sandbox-authority.js";
import type {
  PluginManifest,
  PluginRuntimeContext,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import type { PluginSandboxDeclaration, PluginSandboxGrant } from "../public-contract.js";
import type { DelegatedWorkerConfinement } from "./host-api-dispatcher.js";
import {
  IncompatibleHostProtocolError,
  isServedHostProtocolVersion,
  type HostProtocolVersion,
} from "./host-api-wire.js";
import type { ChildLink } from "./plugin-child-transport.js";
import {
  CHILD_LOOPBACK_TRANSPORT_ARG,
  connectToAnnouncedChild,
  encodeChildEnv,
} from "./child-loopback-link.js";
import {
  createBoundHostApiDispatchTable,
  type DispatchableHostApi,
} from "./bound-host-api-table.js";
import { openPluginProtocolSession } from "./plugin-protocol-session.js";
import { spawnMxcPluginChild, type MxcPluginChild, type MxcPluginChildLaunch } from "./mxc-plugin-child.js";
import { MxcProcessContractError } from "../../permissions/mxc-extension-errors.js";

const log = createLogger("out-of-process-plugin");

/** Host-directory rows grant only literal host-selected reads; user-chosen keys may add read/write only within canonical approved ceilings.
 * Subtract each host row canonically so symlinks cannot turn read grants into write grants; link swaps after derivation remain a check/use residual. */
type PluginEnvelopeGrant = PluginSandboxGrant;

/** What the derivation needs that it cannot read for itself. `configValue` is `hostApi.config.get`, taken from the incarnation rather than re-read from settings: `config.get` is the
 * merge of schema defaults, manifest config and the user's saved value, and a second reader assembled here would answer a different question from the one the plugin's own code asks. */
export interface PluginChildEnvelopeInputs {
  readonly pluginId: string;
  readonly sandbox?: PluginSandboxDeclaration;
  /** The plugin's immutable runtime root; the child reads its code from here. */
  readonly pluginRoot: string;
  /** `~/.ave/plugins/<id>/data`. */
  readonly pluginDataDir: string;
  readonly configValue: (key: string) => unknown;
  readonly onUserChosenDirectory?: (path: string) => void;
}

/** Refuse a widening, and say which grant asked for what. An `Error` subtype rather than a boundary error: this runs on the SPAWN path, so a refusal here fails the plugin's construction; there is no
 * child yet to answer, and a plugin whose declared envelope cannot be honoured must not load with a quietly smaller one. The subtype lets the Doctor avoid reinstalling the same manifest after this refusal. */
export class PluginSandboxGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSandboxGrantError";
  }
}

function rejectEnvelopeGrant(pluginId: string, configKey: string, detail: string): never {
  throw new PluginSandboxGrantError(
    `[out-of-process-plugin] ${pluginId}: cannot widen the child's envelope for `
      + `config key '${configKey}': ${detail}`,
  );
}

/** Where one `hostDirectory` row resolves. ONE answer, read by the derivation that grants the directory and by the subtraction that keeps a config value from naming it. Spelled out twice, the two could
 * come to disagree about where a row points, and the disagreement would be invisible: the grant would still be read-only and the subtraction would still refuse something; just not the same directory. */
function hostGrantDirectory(
  grant: Extract<PluginEnvelopeGrant, { kind: "hostDirectory" }>,
): string {
  const name = grant.segments.length === 1 ? grant.segments[0] : undefined;
  const catalog = name && Object.hasOwn(HOST_DIRECTORY_CATALOG, name)
    ? HOST_DIRECTORY_CATALOG[name as keyof typeof HOST_DIRECTORY_CATALOG]
    : undefined;
  if (!catalog) throw new PluginSandboxGrantError("host directory is outside the closed catalog");
  const directory = join(aveHome(), ...catalog.segments);
  if (isSensitivePath(directory, "read") && !catalog.piercesDenyFloor) {
    throw new PluginSandboxGrantError("host directory cannot pierce the sensitive deny floor");
  }
  return directory;
}

/** Subtract bundle, storage, and host-read roots from the entire write ceiling, including user approvals; these exclusions do not change read policy. */
function ceilingSubtractions(
  inputs: PluginChildEnvelopeInputs,
): readonly { readonly root: string; readonly detail: string }[] {
  return [
    {
      // Exclude the actual install parent, not only the current bundle, to protect sibling bundles and data.
      // Keep this separate from the home exclusion because injected or relocated install paths may differ.
      root: resolvePath(inputs.pluginRoot, ".."),
      detail:
        "resolves inside the directory that holds every installed plugin's bundle, which "
        + "carries the modules the next load imports into the main process and the bytes "
        + "each install receipt is taken over",
    },
    {
      // `~/.ave` — the host's own storage namespace. The parts of it that are
      // secret are already refused by the sensitive-path gate in
      // {@link resolveUserChosenDirectory}, and this entry is what covers the
      // parts that are merely host-owned: session transcripts, the routine
      // store, the audit log, and any directory a later host feature adds
      // under the home without anyone editing this list.
      //
      // It is NOT what keeps a `hostDirectory` grant out of the write list.
      // Every row does join onto `aveHome()`, so in a home whose entries are
      // all real directories this entry happens to cover them — but that is a
      // fact about one filesystem, not about the shapes, and the entries below
      // are what actually carry the exclusion.
      root: aveHome(),
      detail: "resolves inside the host's own storage namespace",
    },
    {
      // This plugin's OWN bundle root, named separately from the install root above even though the shipped layout puts it inside. The row above is `resolvePath(pluginRoot, "..")`; a LEXICAL parent, which is the right way to name the
      // install root and the wrong way to name a bundle that is a symlink out of it, because the caller canonicalises what it is handed. Naming the bundle root itself is what makes the two agree when the install directory is a link.
      root: inputs.pluginRoot,
      detail: "resolves inside the plugin's own bundle root",
    },
    // Every directory the closed host catalog resolves to; the whole catalog, not this plugin's alone, because what is being excluded is the class "somewhere the host handed a plugin child READ" and a value that names a neighbour's granted directory raises the same question as one that names its own. The entries are enumerated rather than covered by the `aveHome()`
    // entry above: a row is a LEXICAL join onto the home, the caller compares in canonical form, and a granted directory that is itself a symlink out of the home therefore has a canonical form the home entry does not contain. Moving a multi-gigabyte interpreter tree to another volume and linking it back is the ordinary reason for that to be true on a real machine.
    ...Object.values(HOST_DIRECTORY_CATALOG).map((grant) => ({
      root: join(aveHome(), ...grant.segments),
      detail: "resolves inside a host-owned catalog directory",
    })),
  ];
}

/** Admit own data first, then reject canonical subtractions before consulting canonical user-approved roots; never add cwd or home defaults.
 * Resolve symlinks through the nearest existing ancestor, preserve the caller's spelling for delegation, and return pluginDataDir for its descendants.
 * Unset keys add no grant; invalid set values throw, and excluded paths must never prompt users to approve an impossible grant. */
function resolveUserChosenDirectory(
  inputs: PluginChildEnvelopeInputs,
  grant: Extract<PluginEnvelopeGrant, { kind: "userChosenDirectory" }>,
): string | undefined {
  const raw = inputs.configValue(grant.configKey);
  // `""` is the default several plugin config schemas ship for an unset string key, and `resolve("")` is the host's cwd; a value that would silently grant something nobody chose.
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    rejectEnvelopeGrant(inputs.pluginId, grant.configKey, `expected a string, got ${typeof raw}`);
  }
  if (!isAbsolute(raw)) {
    // Relative and tilde paths have no host-known base; refuse them before loading rather than guess or silently shrink the envelope.
    // The user must choose an approved absolute directory or clear the setting.
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${raw}' is not an absolute path — the host cannot resolve a relative value, because `
        + `the directory it would be relative to is the plugin's to choose; `
        + `enter an approved absolute directory for '${grant.configKey}', or clear the setting`,
    );
  }
  const target = resolvePath(raw);
  const folded = caseFoldForMatch(canonicalizePathForMatch(target));
  // The read half of this grant re-allows inside the deny floor exactly as a `hostDirectory` grant does, and unlike a `hostDirectory` grant the value is reachable by anything that can write the plugin's config.
  // Without this the user approving `~/.ave` as a workspace root; which the approval flow permits, since `~/.ave` is not itself a sensitive path; would let a config value point the grant at `~/.ave/secrets` and re-open it.
  const sensitive = isSensitivePath(folded);
  if (sensitive) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' matches the sensitive-path rule '${sensitive}'`,
    );
  }
  // The host guard above pins only the per-platform DEFAULT user data locations. The sandbox floor denies the exact one the host runs with (`--user-data-dir`, XDG_CONFIG_HOME) and
  // any trusted custom deny, and a grant under either would re-open it: the read half everywhere, the write half too on Linux, where bubblewrap binds the root over the deny's mask.
  const floorDeny = protectedReadDenyCovering(target);
  if (floorDeny !== undefined) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' lies under the sandbox read-deny floor entry '${floorDeny}'`,
    );
  }
  const ownWritableRoot = caseFoldForMatch(canonicalizePathForMatch(inputs.pluginDataDir));
  // Inside the plugin's own data directory: the grant adds nothing, so it is answered with the data directory itself rather than with the spelling the config holds. That spelling; `…\DATA\work`, an 8.3 `IKCHA~1` form; was decided "inside" by this folded comparison and then carried into the envelope
  // verbatim, where a case-sensitive containment check took it for an independent root; on Windows a grant on a root below `data\` is a grant on whatever the plugin later swaps in there (decision 66). It also keeps the spawn from creating a directory under `data\` along a path the plugin controls.
  if (isPathAllowed(folded, { directories: [ownWritableRoot] })) return inputs.pluginDataDir;
  for (const excluded of ceilingSubtractions(inputs)) {
    const root = caseFoldForMatch(canonicalizePathForMatch(excluded.root));
    if (!isPathAllowed(folded, { directories: [root] })) continue;
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' ${excluded.detail} — no approval can open it to write`,
    );
  }
  const approved = sanitizeAllowedDirectories(
    readPermissionSettings().permissions.additionalDirectories,
  );
  if (!isPathAllowed(folded, { directories: approved })) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' resolves outside the plugin's own data directory and no workspace root `
        + `the user approved covers it — approve the directory in the host first`,
    );
  }
  return target;
}

/** Bind a running grant to the path and filesystem object granted at spawn. */
export function capturePluginSandboxGrant(path: string): {
  path: string;
  canonicalPath: string;
  identity?: FileIdentity;
} {
  const canonicalPath = caseFoldForMatch(canonicalizePathForMatch(path));
  const entry = statSync(path, { bigint: true, throwIfNoEntry: false });
  return {
    path,
    canonicalPath,
    ...(entry ? { identity: { dev: entry.dev, ino: entry.ino } } : {}),
  };
}

/** Recheck the original kernel grant and the current approved roots. */
export function isPluginSandboxGrantCovered(
  grant: ReturnType<typeof capturePluginSandboxGrant>,
  pluginRoot: string,
  pluginDataDir: string,
): boolean {
  try {
    if (caseFoldForMatch(canonicalizePathForMatch(grant.path)) !== grant.canonicalPath) return false;
    const entry = statSync(grant.path, { bigint: true, throwIfNoEntry: false });
    if (grant.identity && (!entry || !sameFileIdentity(entry, grant.identity))) return false;
    if (!grant.identity && entry) grant.identity = { dev: entry.dev, ino: entry.ino };
    return resolveUserChosenDirectory({
      pluginId: "sandbox-grant",
      pluginRoot,
      pluginDataDir,
      configValue: () => grant.path,
    }, { kind: "userChosenDirectory", configKey: "directory", why: "approved directory" }) !== undefined;
  } catch {
    return false;
  }
}

/** Derive spawn and delegation grants from one per-incarnation snapshot; later settings changes cannot alter a running kernel jail.
 * Canonicalize chosen paths against approvals; spawn must materialize every root so the enforced envelope cannot silently shrink. */
export function derivePluginChildEnvelope(
  inputs: PluginChildEnvelopeInputs,
): DelegatedWorkerConfinement {
  // The socket directory is in the BASE envelope rather than in a per-plugin grant row, and that is deliberate. It grants no reach: the directory is inside the plugin's own storage namespace, which `pluginDataDir` already sits in, so a plugin that could
  // write one could always write the other. What it does is make the ONE place a plugin may bind a Unix socket exist for every confined child, so the spawn can register that place with ASRT unconditionally instead of only for the plugins someone remembered.
  const socketDir = resolvePluginSocketDir(inputs.pluginDataDir);
  // READ, not write: the child is the CLIENT of a worker socket the host allocated and the worker bound. Connecting needs the directory reachable and named on the
  // Unix-socket allow; creating anything in it is the host's job, and granting write would hand the plugin the ability to leave a socket where the host expects to find its own.
  const workerRunRoot = resolvePluginWorkerRunRoot(inputs.pluginDataDir);
  const read = [inputs.pluginRoot, inputs.pluginDataDir, socketDir, workerRunRoot];
  const write = [inputs.pluginDataDir, socketDir];
  const grants: Array<{ grant: PluginEnvelopeGrant; access: "read" | "write" }> = [
    ...(inputs.sandbox?.read ?? []).map((grant) => ({ grant, access: "read" as const })),
    ...(inputs.sandbox?.write ?? []).map((grant) => ({ grant, access: "write" as const })),
  ];
  for (const { grant, access } of grants) {
    if (grant.kind === "hostDirectory") {
      const directory = hostGrantDirectory(grant);
      read.push(directory);
      // Logged, not merely declared: a child running with more reach than the base envelope is an operational fact, and `why`
      // is the reviewed reason it holds; which is worth having in the log of the run rather than only in the diff that added it.
      log.info(`[${inputs.pluginId}] envelope widened: read ${directory} — ${grant.why}`);
      continue;
    }
    const chosen = resolveUserChosenDirectory(inputs, grant);
    if (chosen === undefined) continue;
    // Folded into the base envelope: nothing to add, nothing to register.
    if (chosen === inputs.pluginDataDir) continue;
    inputs.onUserChosenDirectory?.(chosen);
    // Read as well as write: the plugin has to list and re-open what it wrote. This is also the only thing that keeps `read` a
    // superset of `write`; `DelegatedWorkerConfinement` documents that relation as maintained here rather than enforced anywhere.
    read.push(chosen);
    if (access === "write") write.push(chosen);
    log.info(
      `[${inputs.pluginId}] envelope widened: ${access} ${chosen} `
        + `(config '${grant.configKey}') — ${grant.why}`,
    );
  }
  // The host-only storage directory beside `pluginDataDir` is in no child's write envelope (plugin-storage-layout.ts). Nothing above can produce
  // such a grant today; a chosen directory under the plugins root is refused unless it is inside the data directory; and this keeps it that way.
  const reaching = writeGrantsReachingHostStorage(inputs.pluginDataDir, write);
  if (reaching.length > 0) {
    throw new Error(
      `[${inputs.pluginId}] refusing a write grant that reaches the host-only storage directory: ${reaching.join(", ")}`,
    );
  }
  return { read: [...new Set(read)], write: [...new Set(write)] };
}

/** What a confined child needs to exist. */
export interface ConfinedPluginChildSpec {
  readonly pluginId: string;
  /** Every root the child may reach, as {@link derivePluginChildEnvelope} produced it. Carried as ONE value rather than as the two directories it used to be spelled out as, so the ASRT wrap below and the delegated-worker check in `host-api-dispatcher.ts` are looking at the
   * same object rather than at two derivations of it. `envelope.write` is what this spawn GRANTS for writing, not the whole set the child can write: see the spawn's own filesystem note below, and axis 6 of the admission record in the history of `out-of-process-plugins.ts`. */
  readonly envelope: DelegatedWorkerConfinement;
  readonly assertStillValid?: () => void;
  /**
   * Where this child may bind a Unix-domain socket, as
   * {@link resolvePluginSocketDir} derived it from the plugin's data directory.
   *
   * Passed rather than recomputed here. It is already inside
   * {@link envelope}, but as one entry among several with nothing marking which
   * — and the registration below has to name exactly one directory, so reading
   * it back out of the list would mean guessing.
   */
  readonly socketDir: string;
  /**
   * Where a worker this plugin asks the host to spawn will bind its control
   * socket, as {@link resolvePluginWorkerRunRoot} derived it. Registered next to
   * {@link socketDir} and for the same reason — the child has to be able to
   * CONNECT there, and the allow is generated when the child is wrapped.
   */
  readonly workerRunRoot: string;
  /** What the wrap runs: see {@link ConfinedPluginLaunch}. */
  readonly launch: ConfinedPluginLaunch;
}

/** The two ways a plugin child is produced (docs/design/plugin-hostapi-protocol.md §2.1). - `entry`: the host's reference runtime, `childEntryPath`, run by the Electron binary as Node.
 * Injected so a test can serve a stand-in. - `process`: the plugin's own executable, as {@link ProcessLaunch} resolved it; `env` holds the declared pairs and then the host-owned pair. */
type ConfinedPluginLaunch =
  | { readonly kind: "entry"; readonly childEntryPath: string }
  | ({ readonly kind: "process" } & ProcessLaunch);

/** Where a `process` launch's environment is applied: `env(1)`, INSIDE the wrap. Never a `PATH` lookup; both supported platforms ship it here. */
const PROCESS_ENV_LAUNCHER = "/usr/bin/env";

/** The spawn line for one launch (decision 36). A `process` launch runs `/usr/bin/env <declared pairs> PLUGIN_ROOT=… PLUGIN_DATA=… <command> <args>`, so every variable; host-owned and declared; is set by a process that already runs inside the wrap. The outer executable ASRT
 * spawns is `/bin/bash -c <wrapped>`, which reads its OWN environment before the sandbox command runs (a `BASH_ENV` there is sourced unconfined), so the base environment carries no manifest byte at all: the safe host allow-list, plus the sandbox HOME the caller overlays. */
function confinedSpawnLine(
  pluginId: string,
  launch: ConfinedPluginLaunch,
): { command: string; args: string[]; baseEnv: NodeJS.ProcessEnv } {
  if (launch.kind === "entry") {
    return {
      // Spawn the production executable in runtime-as-node mode to remove desktop APIs; test each module system because resolution differs.
      command: process.execPath,
      args: [launch.childEntryPath],
      baseEnv: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }
  // `env` reads an operand containing `=` as an assignment, so a command path with one would be split rather than run. The manifest schema refuses
  // it in `command`; a resolved path can still carry one through a user-chosen home or data directory, and that is refused here, never passed on.
  if (launch.command.includes("=")) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: the process entry's resolved path '${launch.command}' contains '=', `
        + "which env(1) would read as an assignment; move the plugin to a directory without '=' in its path",
    );
  }
  const pairs = Object.entries(launch.env).map(([name, value]) => {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`[out-of-process-plugin] ${pluginId}: '${name}' is not an environment variable name`);
    }
    return `${name}=${value}`;
  });
  let launcherIsFile = false;
  try {
    launcherIsFile = statSync(PROCESS_ENV_LAUNCHER).isFile();
  } catch {
    launcherIsFile = false;
  }
  if (!launcherIsFile) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: ${PROCESS_ENV_LAUNCHER} is missing or not a regular file on this system; `
        + "a process entry is launched through it",
    );
  }
  return {
    command: PROCESS_ENV_LAUNCHER,
    args: [...pairs, launch.command, ...launch.args],
    baseEnv: buildSafeChildEnv(),
  };
}

/** A spawned, confined child. A {@link ChildLink} plus what the factory's owner needs about the process: its pid and its exit. The protocol session
 * never touches a `ChildProcess`, so the protocol can be exercised over in-memory paired streams while the confinement is exercised against a real process. */
export interface ConfinedPluginChild {
  readonly link: ChildLink;
  /** The spawned wrapper's pid, or `undefined` when the spawn produced none. */
  readonly pid: number | undefined;
  /** The wrap the spawn actually applied, passed through from {@link spawnConfinedChild}. */
  readonly confinement: SpawnConfinement;
  readonly waitForExit?: () => Promise<void>;
}

/** What {@link OutOfProcessPluginSpec.observeChild} is handed: the production child, observable and nothing more. It can read the child's stdout bytes beside the transport, read the wrapper's pid, observe the exit and end
 * the child's stdin; which is how a crashed host looks to the child. It cannot supply, replace or re-spawn the child, see the envelope, the spawn spec, the table or the registration, write a frame or terminate anything. */
export interface ObservedPluginChild {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Buffer) => void): void;
  endInput(): void;
  /** Settles with the reason the child's link reported it gone. */
  readonly exited: Promise<string>;
}

/** How long a sandboxed Windows child has to start and announce its listener. */
const WINDOWS_CHANNEL_CONNECT_TIMEOUT_MS = 30_000;

/** The sandboxed Windows launch of the reference runtime: Node's symlink- preserving flags, the child entry, the loopback transport, and the child's environment as one argument. The flags are {@link NODE_PRESERVE_SYMLINK_FLAGS}, which says
 * why. For the child the trade is narrow: the entry path is already the host's real path (decision 33), and the host's integrity and path checks run on its side. The environment is {@link srtWinTargetEnv}'s, which says what stays srt-win's. */
function windowsLoopbackLaunchLine(
  args: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
  extraEnv: Readonly<Record<string, string>>,
): {
  readonly args: string[];
  readonly windowsShell: "cmd";
  readonly windowsCommandLineEnv: Readonly<Record<string, string>>;
} {
  return {
    args: [
      ...NODE_PRESERVE_SYMLINK_FLAGS,
      ...args,
      CHILD_LOOPBACK_TRANSPORT_ARG,
      encodeChildEnv(srtWinTargetEnv(baseEnv, extraEnv)),
    ],
    windowsShell: "cmd",
    windowsCommandLineEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** Writes include the envelope, private home, principal temp, and runtime device defaults; protect bundle roots while permitting own data.
 * Read re-allows require a covering install-root deny on macOS/Linux; an unresolved symlinked sibling remains a residual.
 * Windows holds permitted envelope ACL grants for the child lifetime and refuses reach into other plugin-owned roots; use authenticated loopback transport and preserved symlink imports.
 * Release grants on every exit and stop the child if its holder dies; launch failures must clean up.
 * Windows confines host filesystem and network access without process isolation or isolation between plugins sharing the sandbox account. */
export async function spawnConfinedPluginChild(
  spec: ConfinedPluginChildSpec,
): Promise<ConfinedPluginChild> {
  assertExtensionStartAllowed();
  spec.assertStillValid?.();
  // Decided before anything is created, so a refused line leaves nothing behind.
  const spawnLine = confinedSpawnLine(spec.pluginId, spec.launch);
  const sandboxHome = createSandboxProcessHome();
  const socketDir = spec.socketDir;
  const workerRunRoot = spec.workerRunRoot;
  let socketDirRegistered = false;
  const socketHolder = {};
  let workerRunRootRegistered = false;
  let wrapped = false;
  let windowsGrant: HeldWindowsGrant | undefined;
  const releaseSandboxState = (): void => {
    // Reviewer no-leak: the confined marker must not outlive the child. Runs unconditionally (idempotent) so a spawn that failed AFTER onWrapped and a normal exit both clear it.
    unmarkPluginChildConfined(spec.pluginId);
    // The Windows grant is the child's own reach; it must not outlive the child on any path; exit,
    // close, a spawn that produced no process, or a failure before the spawn. `release` is idempotent.
    windowsGrant?.release();
    if (socketDirRegistered) {
      socketDirRegistered = false;
      // The ALLOW is a SHARED-config entry, so it outlives the child that needed it and would accumulate one
      // `(subpath <dir>)` per plugin ever loaded. Removed on the same unconditional path the confined marker is.
      void unregisterWorkerUnixSocketDir(socketDir, socketHolder);
    }
    if (workerRunRootRegistered) {
      workerRunRootRegistered = false;
      void unregisterWorkerUnixSocketDir(workerRunRoot, socketHolder);
    }
    if (wrapped) {
      wrapped = false;
      void cleanupAsrtSandboxAfterCommand();
    }
    sandboxHome.cleanup();
  };
  try {
    // Materialize both read and write roots before wrapping; missing roots may be silently omitted by native backends.
    // Keep creation inside cleanup handling so refusal cannot leak the private home; creation failure prevents plugin loading.
    for (const directory of [...spec.envelope.read, ...spec.envelope.write]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    // Register Unix-socket directories before wrapping because profiles read shared configuration at generation time.
    // Use the directory, not the socket file, for every confined child within its own namespace.
    if (process.platform !== "win32" && isPluginWorkerConfinementActive()) {
      await registerWorkerUnixSocketDir(socketDir, socketHolder);
      socketDirRegistered = true;
    }
    // Register worker leaves for bind and the plugin run subtree for connect; neither profile grant implies the other.
    // Shared socket entries do not widen filesystem reach: per-plugin path confinement remains the boundary.
    if (process.platform !== "win32" && isPluginWorkerConfinementActive()) {
      await registerWorkerUnixSocketDir(workerRunRoot, socketHolder);
      workerRunRootRegistered = true;
    }
    // Windows: the wrap takes denies only, so the child's own directories are granted to the shared `srt-sandbox` account for exactly the child's lifetime, against a holder the host owns; the model a delegated worker already uses (`worker-spawn.ts`). Without it the child reaches only
    // what the directories' existing ACLs admit, which under the default `<AVE_HOME>` in the user profile is nothing: not its entry, not its data. The grant is held to the plugin's own roots, because Windows has no `denyPluginsRoot` to stop an inheriting grant from covering a neighbour.
    if (process.platform === "win32" && isPluginWorkerConfinementActive()) {
      // Each grant names the outermost envelope root only: `srt-win` stamps the ACE on what a path resolves to, and a root nested in another; `data/` under a runtime root that holds it, one chosen directory inside another; is a path the
      // inheriting grant on the outer root already covers, and naming it again would hand `srt-win` a spelling to resolve (`outermostContainingRoots`, decision 66). A chosen directory inside `data/` never gets here: derivation folds it into `data/`.
      const allowRead = [...outermostContainingRoots(spec.envelope.read, spec.envelope.read), sandboxHome.path];
      const allowWrite = [...outermostContainingRoots(spec.envelope.write, spec.envelope.write), sandboxHome.path];
      const beyond = [
        ...pluginGrantPathsBeyondOwnRoots(spec.pluginId, [...allowRead, ...allowWrite]),
        // An ACL grant inherits: a write grant on the plugin root would cover the host-only storage directory beside the data
        // directory. The spec carries `socketDir`, a sibling of `data/`, so the storage directory derived beside it is the same one.
        ...writeGrantsReachingHostStorage(spec.socketDir, allowWrite),
      ];
      if (beyond.length > 0) {
        throw new Error(
          `[out-of-process-plugin] ${spec.pluginId}: refusing a Windows grant beyond the plugin's own roots: `
            + `${[...new Set(beyond)].join(", ")}`,
        );
      }
      windowsGrant = await holdWindowsFilesystemGrant({
        label: `plugin-child:${spec.pluginId}:asrt-win-acl`,
        allowRead,
        allowWrite,
      });
    }
    const grant = windowsGrant;
    const { command, baseEnv } = spawnLine;
    const extraEnv = { ...sandboxHome.env };
    // Windows, wrapped: srt-win relays no stdin, delivers none of this spawn's environment, and PowerShell does not wait for `electron.exe`; so the child is launched through `cmd.exe`, told its environment in
    // an argument, and spoken to over an authenticated loopback connection instead of its pipes (`child-loopback-link.ts`). Everywhere else, and on Windows with the sandbox off, the stdio child is unchanged.
    const windowsLoopback = spec.launch.kind === "entry" && process.platform === "win32" && isPluginWorkerConfinementActive();
    const launchLine = windowsLoopback
      ? windowsLoopbackLaunchLine(spawnLine.args, baseEnv, extraEnv)
      : { args: spawnLine.args };
    const { child, confinement } = await spawnConfinedChild({
      command,
      ...launchLine,
      label: `plugin-child:${spec.pluginId}`,
      egressOwner: { kind: "worker", role: "plugin-child", pluginId: spec.pluginId },
      grantMode: process.platform === "win32" ? "deny-only" : "allow-list",
      // The plugin's own temp directory, shared with its workers and bundled hooks and with no other principal.
      tempPrincipal: { kind: "plugin", id: spec.pluginId },
      allowRead: [...spec.envelope.read, sandboxHome.path],
      allowWrite: [...spec.envelope.write, sandboxHome.path],
      // Every other plugin's code and data: the floor does not cover the plugins root, so this spawn does wherever a deny can re-allow.
      ...(process.platform === "win32" ? {} : { denyPluginsRoot: true }),
      // The envelope names a floor-piercing host directory only when the plugin's reviewed declaration asked for it.
      floorPierces: spec.envelope.read.filter((path) => hostDirectoryFloorPierces().includes(path)),
      // The data root above all: the host keeps resolving it, so a child that could swap it for a link would steer the next storage handle or spawn.
      pinWriteRoots: true,
      baseEnv,
      extraEnv,
      // The child is a JSON-RPC server whose pipes the host owns, so unlike the Python worker it needs stdin
      // (on every path but Windows' loopback one, where stdin is inert and stdout carries only the announce).
      stdio: ["pipe", "pipe", "pipe"],
      onWrapped: () => {
        wrapped = true;
        // Reviewer signal (sandbox-capability registry): tools owned by this plugin now execute in a genuinely ASRT-confined child, so
        // resolveReviewerSandboxCapability may report the real capability for them. Set ONLY on the wrapped path; an unwrapped spawn never marks.
        markPluginChildConfined(spec.pluginId);
      },
      assertStillValid: () => {
        spec.assertStillValid?.();
        grant?.assertAlive();
      },
    });
    if (!child.stdin || !child.stdout) {
      child.kill("SIGKILL");
      throw new Error(`[out-of-process-plugin] ${spec.pluginId}: child has no pipes`);
    }
    // Diagnostics only. The child rebinds everything except the framer to stderr precisely so a stray plugin `console.log` lands here instead of corrupting the protocol.
    child.stderr?.on("data", (chunk: Buffer) => {
      log.debug(`[${spec.pluginId}] ${chunk.toString("utf-8").trimEnd()}`);
    });
    // A launch that hands back a child already gone (its `exit` emitted before these listeners) is released and reported at once, not waited on.
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    const exited = new Promise<void>((resolve) => {
      if (alreadyExited) resolve();
      child.once("exit", () => resolve());
      child.once("close", () => resolve());
    });
    child.once("exit", releaseSandboxState);
    child.once("close", releaseSandboxState);
    if (alreadyExited) releaseSandboxState();
    // Gone means the process no longer exists: it exited, or the spawn produced no process to run. An `error` from a process that has a
    // pid is a fault on a live child; Node emits one when a signal could not be delivered; and must not release it as if it were gone.
    const hasProcess = (): boolean => typeof child.pid === "number" && child.pid > 0;
    child.on("error", () => {
      if (!hasProcess()) releaseSandboxState();
    });
    // Why the child is gone, settled from here on: a child that dies before anyone asks; while the channel is still being set up, or before the caller attaches `onGone`; is
    // still reported, and one that had already exited by the time the launch handed it back (`exitCode`/`signalCode` set, its `exit` possibly already emitted) is reported at once.
    const exitedReason = (code: number | null, signal: NodeJS.Signals | null): string =>
      `[out-of-process-plugin] ${spec.pluginId}: child exited code=${String(code)} signal=${String(signal)}`;
    const gone = new Promise<string>((resolve) => {
      if (alreadyExited) {
        resolve(exitedReason(child.exitCode, child.signalCode));
        return;
      }
      child.once("exit", (code, signal) => resolve(exitedReason(code, signal)));
      child.on("error", (error: Error) => {
        if (!hasProcess()) resolve(`[out-of-process-plugin] ${spec.pluginId}: child error: ${error.message}`);
      });
    });
    let terminated = false;
    const terminateChild = (): void => {
      if (terminated) return;
      terminated = true;
      const forceTimer = terminateChildProcess(child, 3_000);
      child.once("exit", () => clearTimeout(forceTimer));
    };
    // A holder that dies takes the grant's guarantee with it; the child it served stops rather than run on a grant nobody holds.
    grant?.onLost(terminateChild);
    let input: Readable = child.stdout;
    let output: Writable = child.stdin;
    let channel: Socket | undefined;
    if (windowsLoopback) {
      if (confinement !== "windows-srt") {
        terminateChild();
        throw new Error(
          `[out-of-process-plugin] ${spec.pluginId}: a sandboxed Windows launch came back '${confinement}', not 'windows-srt'`,
        );
      }
      try {
        channel = await connectToAnnouncedChild({
          stdout: child.stdout,
          exited: gone,
          timeoutMs: WINDOWS_CHANNEL_CONNECT_TIMEOUT_MS,
        });
      } catch (error) {
        terminateChild();
        throw error;
      }
      // The child may have died in the moment the handshake finished, its `exit` not yet delivered: a channel to a dead child is no channel.
      if (child.exitCode !== null || child.signalCode !== null) {
        channel.destroy();
        terminateChild();
        throw new Error(
          `${exitedReason(child.exitCode, child.signalCode)} as its channel was connected`,
        );
      }
      // stdout now carries nothing the protocol reads; keep it drained and logged, as stderr is.
      child.stdout.on("data", (chunk: Buffer) => {
        log.debug(`[${spec.pluginId}] stdout: ${chunk.toString("utf-8").trimEnd()}`);
      });
      // The connection IS the child's lifetime from here: a channel that closes or fails leaves
      // nothing to serve, so the process is ended and its exit reported through `onGone` as for a pipe.
      const connected = channel;
      connected.once("close", terminateChild);
      connected.on("error", (error: Error) => {
        log.debug(`[${spec.pluginId}] channel error: ${error.message}`);
        connected.destroy();
      });
      input = connected;
      output = connected;
    }
    return {
      pid: hasProcess() ? child.pid : undefined,
      confinement,
      waitForExit: () => exited,
      link: {
        input,
        output,
        terminate: (reason) => {
          log.debug(`[${spec.pluginId}] terminating child: ${reason}`);
          channel?.destroy();
          terminateChild();
        },
        onGone: (handler) => {
          void gone.then(handler);
        },
        onFault: (handler) => {
          child.on("error", (error: Error) => {
            if (!hasProcess()) return;
            handler(`[out-of-process-plugin] ${spec.pluginId}: child fault: ${error.message}`);
          });
        },
      },
    };
  } catch (error) {
    releaseSandboxState();
    throw error;
  }
}

export interface OutOfProcessPluginSpec {
  readonly manifest: PluginManifest;
  readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** How the plugin's process is produced, and so what construct's `entryPath` says (decision 33): the resolved, real path of the plugin's JS module (not
   * of the child runtime) for an `entry` plugin; for a `process` plugin the launch `resolveProcessLaunch` built, whose command path construct carries. */
  readonly launch:
    | { readonly kind: "entry"; readonly entryPath: string }
    | ({ readonly kind: "process" } & ProcessLaunch);
  /** Defaults to the emitted `plugin-child-main.js` under the runtime asset dir. The plugin runtime always passes the path its composition root resolved (`PluginRuntimeOptions.childEntryPath`: {@link
   * resolvePluginChildEntryPath} in the app, a bundle of the same entry in the tests). It is the path the CONFINED spawn runs for an `entry` launch, so a test that serves a stand-in still runs it under the real wrap and bypasses nothing. */
  readonly childEntryPath?: string;
  /** Internal backend-plan integration. Absent until the policy owner admits this holder;
   * the existing path stays authoritative otherwise. Never infer readiness from the OS or a PID.
   * The planner must bind the exact command, cwd and captured envelope, and own revocation.
   * Capability publication remains with that planner, after native spawn and protocol setup. */
  readonly prepareMxcChild?: (intent: {
    readonly pluginId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly envelope: DelegatedWorkerConfinement;
  }) => Promise<MxcPluginChildLaunch>;
  readonly registerSandboxEnvelope?: (paths: readonly string[], pluginRoot: string, pluginDataDir: string) => {
    assertCurrent(): void;
    dispose(): void;
  };
  readonly onMalformedCredentialSelector?: (pluginId: string) => void;
  /**
   * Observe the production child, once, after the wrap and the grant re-check
   * and before the protocol starts — so a listener sees every byte. Test-only:
   * no runtime caller passes it (`validate-boundary.test.ts`), and
   * {@link ObservedPluginChild} can observe the child and end its input but
   * cannot replace, re-spawn or terminate it.
   */
  readonly observeChild?: (child: ObservedPluginChild) => void;
  /** Told the wrap a child was spawned under, once, the moment the spawn returns; before the grant re-check, so a construction that fails after a child existed still reports
   * that child's confinement. Not called when no child was spawned. The runtime records it for the Doctor (`PluginConfinementReport`); it can read a value and nothing more. */
  readonly onChildSpawned?: (confinement: SpawnConfinement) => void;
}

/** The host protocol version this plugin's connection speaks (§3.2). Its declared, served `requires.hostProtocol`. Omission and unserved
 * versions fail before activation on the runtime loader's two paths; this check also protects a direct connection from bypassing that gate. */
export function connectionHostProtocol(manifest: PluginManifest): HostProtocolVersion {
  const declared = manifest.requires?.hostProtocol;
  if (!isServedHostProtocolVersion(declared)) {
    throw new IncompatibleHostProtocolError(manifest.id, { declared: declared ?? null });
  }
  return declared;
}

/** Build the factory the lifecycle calls in place of the in-process one. The returned factory does the whole of the boundary's setup; spawn, dispatcher assembly, construct; inside ONE call, which is what puts it under
 * the host's existing `runPluginFactoryWithTimeout`. A child that never finishes constructing therefore fails the plugin exactly as a factory that never resolves does today, with no new timeout policy invented for it. */
export function createOutOfProcessPluginFactory(
  spec: OutOfProcessPluginSpec,
): RuntimePluginFactory {
  const childEntryPath = spec.childEntryPath ?? resolvePluginChildEntryPath();
  const pluginId = spec.manifest.id;

  return async (context: PluginRuntimeContext): Promise<RuntimePlugin> => {
    assertExtensionStartAllowed();
    // Refused before anything is spawned. `runtime/index.ts` refuses the same manifest at every load path; this is the spawn path's
    // own copy of the rule, so a factory reached any other way cannot start a child that would be told a version it does not speak.
    const hostProtocolVersion = connectionHostProtocol(spec.manifest);
    if (spec.prepareMxcChild && spec.launch.kind !== "entry") {
      throw new MxcProcessContractError("Native plugin launch requires the reference child runtime");
    }
    // A `process` launch runs code the host cannot read, so it runs only under a live sandbox that confines processes: never unwrapped (unlike an `entry` launch with
    // the sandbox off), and never on Windows, whose sandbox does not confine process creation (§2.2, §7.3). The deny floor and the wrap stay `spawnConfinedChild`'s.
    if (spec.launch.kind === "process" && (!isPluginWorkerConfinementActive() || process.platform === "win32")) {
      throw new ProcessEntryUnconfinedError();
    }
    const hostApi = context.hostApi as unknown as DispatchableHostApi;
    // Derived ONCE, here, and then held: the spawn wraps the child with it and the dispatch table checks delegated workers against it, so the two cannot be looking at different answers
    // to the same question. Deriving it before the spawn is also what makes a refused widening fail construction rather than produce a child confined more narrowly than the host decided.
    const chosenPaths: string[] = [];
    const envelope = derivePluginChildEnvelope({
      pluginId,
      ...(spec.manifest.sandbox === undefined ? {} : { sandbox: spec.manifest.sandbox }),
      pluginRoot: context.pluginRoot,
      pluginDataDir: context.pluginDataDir,
      configValue: (key) => hostApi.config.get(key),
      onUserChosenDirectory: (path) => chosenPaths.push(path),
    });
    const registration = spec.registerSandboxEnvelope?.(chosenPaths, context.pluginRoot, context.pluginDataDir);
    // Both launch paths receive the same captured envelope used by the effect boundary.
    let child: ConfinedPluginChild | MxcPluginChild | undefined;
    try {
      if (spec.prepareMxcChild) {
        const launch = await spec.prepareMxcChild({
          pluginId, command: process.execPath, args: [childEntryPath],
          cwd: context.pluginRoot, envelope,
        });
        child = await spawnMxcPluginChild(launch);
      } else child = await spawnConfinedPluginChild({
        pluginId,
        envelope,
        assertStillValid: () => registration?.assertCurrent(),
        socketDir: resolvePluginSocketDir(context.pluginDataDir),
        workerRunRoot: resolvePluginWorkerRunRoot(context.pluginDataDir),
        launch: spec.launch.kind === "entry"
          ? { kind: "entry", childEntryPath }
          : spec.launch,
      });
      if ("confinement" in child) spec.onChildSpawned?.(child.confinement);
      registration?.assertCurrent();
    } catch (error) {
      child?.link.terminate("sandbox grant changed during spawn");
      await child?.waitForExit?.();
      registration?.dispose();
      throw error;
    }
    const spawned = child;

    if (spec.observeChild) {
      const { link } = spawned;
      spec.observeChild({
        pid: spawned.pid,
        onStdout: (listener) => {
          link.input.on("data", listener);
        },
        endInput: () => {
          link.output.end();
        },
        exited: new Promise<string>((resolve) => link.onGone(resolve)),
      });
    }

    // The SAME envelope value the spawn received, so the boundary checks delegated workers against the jail the child actually runs in.
    const table = createBoundHostApiDispatchTable(
      hostApi,
      envelope,
      spec.onMalformedCredentialSelector
        ? () => spec.onMalformedCredentialSelector?.(pluginId)
        : undefined,
    );
    const session = await openPluginProtocolSession({
      pluginId,
      manifest: spec.manifest,
      hostProtocolVersion,
      link: spawned.link,
      context,
      entryPath: spec.launch.kind === "entry" ? spec.launch.entryPath : spec.launch.command,
      table,
      ...(spec.auditLog ? { auditLog: spec.auditLog } : {}),
      onClosed: async () => {
        await spawned.waitForExit?.();
        // Unverified termination keeps the registration quarantined with its launch lease.
        registration?.dispose();
      },
    });
    // The channel and `teardown` stay here: the lifecycle gets the instance, whose `stop` is its one hand on the child's lifetime.
    return session.instance;
  };
}
