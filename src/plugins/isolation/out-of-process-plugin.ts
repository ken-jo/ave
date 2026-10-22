/**
 * Route one plugin out of the main process, and confine it there
 * (`docs/blueprints/plugin-process-isolation.md` §4, §5, §7).
 *
 * Two things land here together because §4 says they have to. The process
 * boundary alone buys a great deal — no shared heap, no `electron`, one
 * structural chokepoint, a separate crash domain — and buys NO filesystem or
 * network confinement at all: a Node child still has `fs`, `net` and
 * `child_process` unless something wraps its argv. So the spawn goes through
 * `spawnConfinedChild` and nowhere else, and that primitive is where the wrap
 * is decided.
 *
 * THE CHILD IS CONFINED EXACTLY AS MUCH AS THE HOST'S WORKERS ARE. One
 * setting, `features.pluginWorkerConfinement`, says whether extension
 * processes run under the OS sandbox; plugin workers, MCP stdio servers and
 * plugin children all follow it (host shells follow `features.osToolSandbox`,
 * which never decides this). While it
 * is off the child is spawned as given and nothing marks it confined, so the
 * reviewer grants it no sandbox-based relaxation. While it is on, the wrap is
 * mandatory and a plugin that cannot be wrapped does not load. The rule that
 * used to live here — no unconfined path, ever — made a promise on Windows
 * and Linux that the host itself had never made, and its cost was every
 * plugin on those platforms failing to start with an internal error.
 *
 * WHAT THIS SEAM IS. The host's contract with a plugin is
 * `RuntimePluginFactory`, so that is what the isolated path produces: a factory
 * that spawns a child and returns a `RuntimePlugin` whose handlers and
 * lifecycle hooks are round trips. Everything above it — the method map, the
 * permission manager, the effect gate, the generation lease, the loopback MCP
 * projection — is untouched and cannot tell the difference, which is exactly
 * why the five plugins that are not the pilot keep loading as they did.
 */
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

const log = createLogger("out-of-process-plugin");

/**
 * One directory the HOST has decided a named plugin's child may reach beyond
 * its own two.
 *
 * The two shapes are not interchangeable, and the difference is the whole
 * safety argument:
 *
 *  - `hostDirectory` names a LITERAL location under `~/.ave`, written out in
 *    this file and changed only by a reviewed commit. Nothing outside the host
 *    can influence which path it resolves to. It is granted READ, and the only
 *    reason a read grant is not inert is that ASRT's read model is deny-only:
 *    `allowRead` re-allows a region inside a covering deny (`asrt-sandbox.ts`
 *    documents this, and `confined-plugin-child.test.ts` proves it against the
 *    real sandbox). So a host directory the deny floor covers — `certs` — can
 *    be re-opened for exactly one plugin, and a host directory the floor does
 *    NOT cover — `runtime` — is readable anyway and appears here because the
 *    delegated-worker check compares against this list rather than against the
 *    floor.
 *
 *  - `userChosenDirectory` names a CONFIG KEY, never a path. The host reads the
 *    key, and admits the value only if it lies inside the plugin's own writable
 *    root or inside a directory the USER approved through the host's
 *    workspace-root flow — and, either way, only if it lies outside every root
 *    {@link ceilingSubtractions} names. The plugin can therefore choose WHERE
 *    under the user's ceiling it works, and cannot raise the ceiling:
 *    `config.set(key, "/")` produces a refusal at the next spawn, not a wider
 *    jail. It is granted WRITE, and read alongside it, because a read-only
 *    grant here would be inert — an ordinary user directory is on no deny list.
 *    The read half is added by the same line that adds the write half, which is
 *    what keeps the two lists in the relation `DelegatedWorkerConfinement`
 *    describes.
 *
 *  KEEPING A READ GRANT FROM BECOMING A WRITE GRANT IS DONE BY SUBTRACTING THE
 *  ROWS, not by reasoning about their shape. {@link ceilingSubtractions} puts
 *  directory every host catalog entry resolves to into the
 *  set a `userChosenDirectory` value is refused for naming, and the comparison
 *  is canonical on both sides.
 *
 *  Subtracting `aveHome()` alone is NOT the same thing, and the difference is
 *  easy to miss because in a home made only of real directories the two
 *  coincide. A row is a LEXICAL join onto the home; a granted directory that is
 *  itself a symlink out of the home has a canonical form the home does not
 *  contain, and the comparison then misses. `confined-plugin-child.test.ts` pins that case for the `runtime`
 *  row — the interpreter tree moved to another volume, the volume approved as
 *  a workspace root — asked with the linked spelling and with the target's own
 *  spelling; with the home entry alone, both spellings reached
 *  `envelope.write`.
 *
 *  WHAT IS NOT CLAIMED is that this holds for all time. Each row is resolved
 *  when the envelope is derived; a link swapped between that moment and the
 *  child's use of the grant is a residual this does not close, and it is the
 *  same check-time/use-time residual the delegated-worker grant check carries.
 */
type PluginEnvelopeGrant = PluginSandboxGrant;

/**
 * What the derivation needs that it cannot read for itself.
 *
 * `configValue` is `hostApi.config.get`, taken from the incarnation rather than
 * re-read from settings: `config.get` is the merge of schema defaults, manifest
 * config and the user's saved value, and a second reader assembled here would
 * answer a different question from the one the plugin's own code asks.
 */
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

/**
 * Refuse a widening, and say which grant asked for what.
 *
 * An `Error` subtype rather than a boundary error: this runs on the SPAWN path,
 * so a refusal here fails the plugin's construction — there is no child yet to
 * answer, and a plugin whose declared envelope cannot be honoured must not load
 * with a quietly smaller one. The subtype lets the Doctor avoid reinstalling
 * the same manifest after this refusal.
 */
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

/**
 * Where one `hostDirectory` row resolves.
 *
 * ONE answer, read by the derivation that grants the directory and by the
 * subtraction that keeps a config value from naming it. Spelled out twice,
 * the two could come to disagree about where a row points, and the disagreement
 * would be invisible: the grant would still be read-only and the subtraction
 * would still refuse something — just not the same directory.
 */
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

/**
 * The roots a `userChosenDirectory` value is refused for naming, whatever the
 * user approved, and why each one is on the list.
 *
 * These are SUBTRACTED from the ceiling rather than left out of one half of it,
 * and the difference is not stylistic. The ceiling's own-roots half and its
 * user-approval half overlap in the production layout, so a root merely omitted
 * from the first is readmitted by the second the moment the user approves
 * anything above it — which is one `config.set` away, and needs no symlink and
 * no race.
 *
 * Each entry is a WRITE exclusion and says nothing about read. What the child
 * may read is decided elsewhere — by the ASRT deny floor and by the envelope's
 * own `read` list — and appearing here neither opens nor closes any of that.
 * What the exclusion removes is a config value's ability to turn a directory
 * into a kernel-level WRITE grant.
 */
function ceilingSubtractions(
  inputs: PluginChildEnvelopeInputs,
): readonly { readonly root: string; readonly detail: string }[] {
  return [
    {
      // `<pluginsRoot>` — the parent of THIS plugin's root, which is where
      // every install physically lives (`plugin-paths.ts`; `ensurePluginDataDir`
      // already reads the parent the same way). Named as the whole directory
      // rather than as `inputs.pluginRoot` alone because the argument for
      // excluding the plugin's own bundle — it is the module the next load
      // imports into the main process, and the bytes the install receipt is
      // taken over — is the same argument for every sibling's bundle, and for
      // every sibling's storage namespace. The plugin's own data directory is
      // under here too, which is why it is admitted BEFORE this runs.
      //
      // In the default layout this root is INSIDE the one below and either
      // entry would refuse; they are separate because they are anchored to
      // different things. This one is derived from the path the host actually
      // located this incarnation's bundle at, while `aveHome()` re-reads
      // `AVE_HOME` on every call — so a home that moved after install, or a
      // `pluginsRoot` supplied by constructor injection, leaves the two
      // pointing at different directories and only this one still covers the
      // bundles.
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
      // This plugin's OWN bundle root, named separately from the install root
      // above even though the shipped layout puts it inside. The row above is
      // `resolvePath(pluginRoot, "..")` — a LEXICAL parent, which is the right
      // way to name the install root and the wrong way to name a bundle that
      // is a symlink out of it, because the caller canonicalises what it is
      // handed. Naming the bundle root itself is what makes the two agree when
      // the install directory is a link.
      root: inputs.pluginRoot,
      detail: "resolves inside the plugin's own bundle root",
    },
    // Every directory the closed host catalog resolves to — the whole catalog,
    // not this plugin's alone, because what is being excluded is the class
    // "somewhere the host handed a plugin child READ" and a value that names a
    // neighbour's granted directory raises the same question as one that names
    // its own. The entries are enumerated rather than covered by the `aveHome()`
    // entry above: a row is a LEXICAL join onto the home, the caller compares
    // in canonical form, and a granted directory that is itself a symlink out
    // of the home therefore has a canonical form the home entry does not
    // contain. Moving a multi-gigabyte interpreter tree to another volume and
    // linking it back is the ordinary reason for that to be true on a real
    // machine.
    ...Object.values(HOST_DIRECTORY_CATALOG).map((grant) => ({
      root: join(aveHome(), ...grant.segments),
      detail: "resolves inside a host-owned catalog directory",
    })),
  ];
}

/**
 * Resolve one `userChosenDirectory` grant, or refuse it.
 *
 * Returns `undefined` when the key names nothing — an unset key means the
 * plugin is using the default that already lives inside its data directory, so
 * there is no widening to perform. That is the set being empty, not a rescue
 * branch: a key that IS set and cannot be honoured throws.
 *
 * THE CEILING IS THE PLUGIN'S OWN WRITABLE ROOT — `pluginDataDir` — UNIONED
 * WITH the directories the user approved through the host's workspace-root
 * flow, the same `permissions.additionalDirectories` list that already widens a
 * plugin-owned tool's write jail (`sandbox-write-jail.ts`). Both halves go
 * through `isPathAllowed`, the host's own segment-aligned predicate for "did
 * the user authorise this", so there is no second notion of approval here to
 * drift from the first.
 *
 * {@link ceilingSubtractions} IS SUBTRACTED FROM THE WHOLE CEILING, and that it
 * is subtracted rather than merely left out of one half is the point. What this
 * resolves is a WRITE grant, and those roots hold the bundles the next load
 * imports, the bytes each install receipt is taken over, and every directory a
 * `hostDirectory` row granted READ. Putting any of them into the child's
 * kernel-level write jail is the primitive {@link spawnConfinedPluginChild}
 * removes rather than merely detects, and a root the child may only READ cannot
 * bound a grant that carries write.
 *
 * Omitting them from the own-roots half alone would NOT have achieved that, and
 * the reason is the production layout: `pluginDataDir` is a CHILD of
 * `pluginRoot` (`~/.ave/plugins/<id>/data`, `plugin-storage-layout.ts`), which
 * is itself under the install root and under `~/.ave`. Any workspace root the
 * user approves at or above the install location therefore contains all three,
 * and the approval half would readmit exactly what the own-roots half declined
 * to name — with no symlink and no race, on one `config.set`.
 *
 * THE ORDER OF THE THREE STEPS IS: the plugin's own data directory is admitted
 * FIRST, the subtractions are asked SECOND, the user's approvals are consulted
 * LAST. The first boundary decides a VERDICT and the second decides a MESSAGE,
 * and it is worth being exact about which is which:
 *
 *  - The data-directory step RETURNS. It is the only admitting step, and the
 *    data directory sits inside every subtracted root, so a subtraction asked
 *    ahead of it refuses the plugin's own default index location. Four cases in
 *    `confined-plugin-child.test.ts` go red on that move.
 *  - The remaining two steps both REFUSE and neither admits, so swapping them
 *    changes no verdict — a subtracted root is refused either way. What it
 *    changes is which refusal the caller is handed: with the approvals first, a
 *    value under a subtracted root that no approval covers is told to "approve
 *    the directory in the host first", which is advice that cannot work. One
 *    case goes red on that move, and it goes red on the message.
 *
 * ALL FOUR CONTAINMENT QUESTIONS THIS FUNCTION ASKS ARE ASKED ON THE CANONICAL
 * FORM, not on the lexical one: the value, the plugin's own writable root, each
 * subtracted root, and the user's approved roots (`sanitizeAllowedDirectories`
 * canonicalises and case-folds what it returns, so that side arrives that way).
 * `config.set` is a member the plugin holds and `pluginDataDir` is a directory
 * the plugin writes, so a lexical containment test is one the plugin can
 * satisfy with a symlink it planted itself. A link at `<pluginDataDir>/x` pointing at a
 * directory the user never approved reads as inside the ceiling while naming a
 * directory outside it, and the grant that follows is what reaches the kernel.
 * `canonicalizePathForMatch` resolves the link; where the path does not exist
 * yet it resolves the nearest existing ancestor and re-joins the missing tail,
 * so "the directory is not there yet" is answered without weakening the check.
 * It is also already in hand — the sensitive-path layer above computes the same
 * string.
 *
 * WHAT IS RETURNED IS THE CALLER'S OWN SPELLING, not the canonical one. The
 * delegated-worker check compares a worker's requested paths against these
 * entries and the plugin asks with the value it holds, so returning a
 * re-spelled path would refuse the very grants this widening exists to admit.
 * Containment was decided on the canonical form, so both spellings name a
 * directory inside the ceiling. The one exception is a directory inside the
 * plugin's own data directory, answered with `pluginDataDir` itself: it adds no
 * reach, and its own spelling is a path the plugin can re-point.
 *
 * The host DEFAULTS that scope normally carries — `computeDefaultAllowedDirectories`
 * returns the process cwd and `~/.ave` — are deliberately not unioned in here.
 * They are where the app happens to be running and where the host keeps its own
 * state; neither is a directory the user chose for a plugin, and including them
 * would widen every plugin with a chosen-directory grant by accident.
 * `~/.ave` is more than left out: {@link ceilingSubtractions} takes it away
 * even when the user has approved it explicitly.
 */
function resolveUserChosenDirectory(
  inputs: PluginChildEnvelopeInputs,
  grant: Extract<PluginEnvelopeGrant, { kind: "userChosenDirectory" }>,
): string | undefined {
  const raw = inputs.configValue(grant.configKey);
  // `""` is the default several plugin config schemas ship for an unset string
  // key, and `resolve("")` is the host's cwd — a value that would silently
  // grant something nobody chose.
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    rejectEnvelopeGrant(inputs.pluginId, grant.configKey, `expected a string, got ${typeof raw}`);
  }
  if (!isAbsolute(raw)) {
    // A relative value has no meaning HERE, and the reason is not that it is
    // suspicious. The directory it is relative to is the PLUGIN's to choose,
    // and the host holds no way to learn which one a given key is resolved
    // against — so honouring one would mean guessing a base and then handing
    // the kernel a write grant over the guess. A leading `~` lands here for the
    // same reason and is expanded nowhere on this path.
    //
    // WHAT THIS COSTS is worth stating rather than discovering: a relative
    // value the plugin itself accepts and resolves fails the plugin's whole
    // construction here, because {@link rejectEnvelopeGrant} runs on the spawn
    // path. That is the fail-closed direction — the alternative is a child
    // loaded with an envelope quietly smaller than the reviewed one — but it
    // means such a setting has to be made absolute BEFORE the plugin holding it
    // is loaded. Every `entry` plugin is routed out of process since
    // Admission, so the refusal ends in one sentence a user can act on — the
    // same sentence for every plugin and every key, because the corrective
    // action is the user's and is the same everywhere: replace the value with
    // a directory the host approved, or clear it so the grant is not asked.
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
  // The read half of this grant re-allows inside the deny floor exactly as a
  // `hostDirectory` grant does, and unlike a `hostDirectory` grant the value is
  // reachable by anything that can write the plugin's config. Without this the
  // user approving `~/.ave` as a workspace root — which the approval flow
  // permits, since `~/.ave` is not itself a sensitive path — would let a
  // config value point the grant at `~/.ave/secrets` and re-open it.
  const sensitive = isSensitivePath(folded);
  if (sensitive) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' matches the sensitive-path rule '${sensitive}'`,
    );
  }
  // The host guard above pins only the per-platform DEFAULT user data
  // locations. The sandbox floor denies the exact one the host runs with
  // (`--user-data-dir`, XDG_CONFIG_HOME) and any trusted custom deny, and a
  // grant under either would re-open it: the read half everywhere, the write
  // half too on Linux, where bubblewrap binds the root over the deny's mask.
  const floorDeny = protectedReadDenyCovering(target);
  if (floorDeny !== undefined) {
    rejectEnvelopeGrant(
      inputs.pluginId,
      grant.configKey,
      `'${target}' lies under the sandbox read-deny floor entry '${floorDeny}'`,
    );
  }
  const ownWritableRoot = caseFoldForMatch(canonicalizePathForMatch(inputs.pluginDataDir));
  // Inside the plugin's own data directory: the grant adds nothing, so it is
  // answered with the data directory itself rather than with the spelling the
  // config holds. That spelling — `…\DATA\work`, an 8.3 `IKCHA~1` form — was
  // decided "inside" by this folded comparison and then carried into the
  // envelope verbatim, where a case-sensitive containment check took it for an
  // independent root; on Windows a grant on a root below `data\` is a grant on
  // whatever the plugin later swaps in there (decision 66). It also keeps the
  // spawn from creating a directory under `data\` along a path the plugin
  // controls.
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

/**
 * The paths the PLUGIN owns, plus whatever the host decided it also reaches.
 *
 * Read by the spawn — which adds the throwaway sandbox HOME on top — and by the
 * `spawnWorker` grant check, which does not: that HOME belongs to this process
 * and is not the plugin's to hand on. Deriving both from one function is what
 * makes the delegation check a check against the ACTUAL jail: widening what a
 * plugin child may reach widens what it may delegate, in the same edit, instead
 * of leaving a second list to drift behind the first.
 *
 * PER INCARNATION, and not by preference. ASRT applies the wrap to the child's
 * argv at exec, so the jail is fixed for the life of that process — a directory
 * the user approves afterwards does not widen a running child, and one they
 * revoke does not narrow it. The delegated-worker check therefore has to read
 * this same snapshot rather than a fresh derivation, or the boundary would
 * admit a grant the child's own kernel-level jail denies.
 *
 * WHAT THIS DOES NOT DO IS MATERIALISE the roots it names. A declared directory
 * that does not exist yet is still in the envelope; creating it belongs to the
 * ONE caller that hands the lists to the kernel —
 * {@link spawnConfinedPluginChild} — and it is done there rather than skipped,
 * for a reason that is not cosmetic: a root that is absent at wrap time is
 * DROPPED FROM THE GRANT rather than refused, so the child would start with an
 * envelope quietly unequal to the reviewed one. Creating it first is what keeps
 * the enforced set and the decided set the same set.
 *
 * It does READ the disk, and it has to. A `userChosenDirectory` grant is
 * bounded by the user's approvals in `~/.ave/settings.json` and compared in
 * canonical form, which means resolving symlinks. Containment decided on
 * spellings alone would be a question about strings, and the plugin writes one
 * of the strings — see {@link resolveUserChosenDirectory}. A `hostDirectory`
 * grant needs none of that: its path is written out in this file.
 */
export function derivePluginChildEnvelope(
  inputs: PluginChildEnvelopeInputs,
): DelegatedWorkerConfinement {
  // The socket directory is in the BASE envelope rather than in a per-plugin
  // grant row, and that is deliberate. It grants no reach: the directory is
  // inside the plugin's own storage namespace, which `pluginDataDir` already
  // sits in, so a plugin that could write one could always write the other.
  // What it does is make the ONE place a plugin may bind a Unix socket exist
  // for every confined child, so the spawn can register that place with ASRT
  // unconditionally instead of only for the plugins someone remembered.
  const socketDir = resolvePluginSocketDir(inputs.pluginDataDir);
  // READ, not write: the child is the CLIENT of a worker socket the host
  // allocated and the worker bound. Connecting needs the directory reachable
  // and named on the Unix-socket allow; creating anything in it is the host's
  // job, and granting write would hand the plugin the ability to leave a socket
  // where the host expects to find its own.
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
      // Logged, not merely declared: a child running with more reach than the
      // base envelope is an operational fact, and `why` is the reviewed reason
      // it holds — which is worth having in the log of the run rather than only
      // in the diff that added it.
      log.info(`[${inputs.pluginId}] envelope widened: read ${directory} — ${grant.why}`);
      continue;
    }
    const chosen = resolveUserChosenDirectory(inputs, grant);
    if (chosen === undefined) continue;
    // Folded into the base envelope: nothing to add, nothing to register.
    if (chosen === inputs.pluginDataDir) continue;
    inputs.onUserChosenDirectory?.(chosen);
    // Read as well as write: the plugin has to list and re-open what it wrote.
    // This is also the only thing that keeps `read` a superset of `write` —
    // `DelegatedWorkerConfinement` documents that relation as maintained here
    // rather than enforced anywhere.
    read.push(chosen);
    if (access === "write") write.push(chosen);
    log.info(
      `[${inputs.pluginId}] envelope widened: ${access} ${chosen} `
        + `(config '${grant.configKey}') — ${grant.why}`,
    );
  }
  // The host-only storage directory beside `pluginDataDir` is in no child's
  // write envelope (plugin-storage-layout.ts). Nothing above can produce such a
  // grant today — a chosen directory under the plugins root is refused unless
  // it is inside the data directory — and this keeps it that way.
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
  /**
   * Every root the child may reach, as {@link derivePluginChildEnvelope}
   * produced it. Carried as ONE value rather than as the two directories it
   * used to be spelled out as, so the ASRT wrap below and the delegated-worker
   * check in `host-api-dispatcher.ts` are looking at the same object rather
   * than at two derivations of it.
   *
   * `envelope.write` is what this spawn GRANTS for writing, not the whole set
   * the child can write: see the spawn's own filesystem note below, and axis 6
   * of the admission record in the history of `out-of-process-plugins.ts`.
   */
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

/**
 * The two ways a plugin child is produced (docs/design/plugin-hostapi-protocol.md §2.1).
 *
 *  - `entry`: the host's reference runtime, `childEntryPath`, run by the
 *    Electron binary as Node. Injected so a test can serve a stand-in.
 *  - `process`: the plugin's own executable, as {@link ProcessLaunch} resolved
 *    it — `env` holds the declared pairs and then the host-owned pair.
 */
type ConfinedPluginLaunch =
  | { readonly kind: "entry"; readonly childEntryPath: string }
  | ({ readonly kind: "process" } & ProcessLaunch);

/**
 * Where a `process` launch's environment is applied: `env(1)`, INSIDE the
 * wrap. Never a `PATH` lookup — both supported platforms ship it here.
 */
const PROCESS_ENV_LAUNCHER = "/usr/bin/env";

/**
 * The spawn line for one launch (decision 36).
 *
 * A `process` launch runs `/usr/bin/env <declared pairs> PLUGIN_ROOT=…
 * PLUGIN_DATA=… <command> <args>`, so every variable — host-owned and
 * declared — is set by a process that already runs inside the wrap. The outer
 * executable ASRT spawns is `/bin/bash -c <wrapped>`, which reads its OWN
 * environment before the sandbox command runs (a `BASH_ENV` there is sourced
 * unconfined), so the base environment carries no manifest byte at all: the
 * safe host allow-list, plus the sandbox HOME the caller overlays.
 */
function confinedSpawnLine(
  pluginId: string,
  launch: ConfinedPluginLaunch,
): { command: string; args: string[]; baseEnv: NodeJS.ProcessEnv } {
  if (launch.kind === "entry") {
    return {
      // `process.execPath` is the Electron binary — in production AND under
      // this repository's own test runner, which launches Vitest through that
      // binary (`scripts/run-vitest-under-electron.mjs`). A child spawned from
      // a test is therefore spawned from the executable production spawns
      // from, which is what makes the confinement suite's `electron` answers
      // measurements rather than artefacts of a Node-versus-Electron runner.
      // `ELECTRON_RUN_AS_NODE` makes that binary behave as Node, which is what
      // removes `electron` from the child's CJS registry — §4's "No Electron"
      // is this environment variable plus the absence of a renderer, not a
      // promise. It does NOT act uniformly across module systems, so
      // `confined-plugin-child.test.ts` asserts each form separately rather
      // than one on the others' behalf.
      command: process.execPath,
      args: [launch.childEntryPath],
      baseEnv: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }
  // `env` reads an operand containing `=` as an assignment, so a command path
  // with one would be split rather than run. The manifest schema refuses it in
  // `command`; a resolved path can still carry one through a user-chosen home
  // or data directory, and that is refused here, never passed on.
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

/**
 * A spawned, confined child.
 *
 * A {@link ChildLink} plus what the factory's owner needs about the process:
 * its pid and its exit. The protocol session never touches a `ChildProcess`,
 * so the protocol can be exercised over in-memory paired streams while the
 * confinement is exercised against a real process.
 */
export interface ConfinedPluginChild {
  readonly link: ChildLink;
  /** The spawned wrapper's pid, or `undefined` when the spawn produced none. */
  readonly pid: number | undefined;
  /** The wrap the spawn actually applied, passed through from {@link spawnConfinedChild}. */
  readonly confinement: SpawnConfinement;
  readonly waitForExit?: () => Promise<void>;
}

/**
 * What {@link OutOfProcessPluginSpec.observeChild} is handed: the production
 * child, observable and nothing more.
 *
 * It can read the child's stdout bytes beside the transport, read the
 * wrapper's pid, observe the exit and end the child's stdin — which is how a
 * crashed host looks to the child. It cannot supply, replace or re-spawn the
 * child, see the envelope, the spawn spec, the table or the registration,
 * write a frame or terminate anything.
 */
export interface ObservedPluginChild {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Buffer) => void): void;
  endInput(): void;
  /** Settles with the reason the child's link reported it gone. */
  readonly exited: Promise<string>;
}

/** How long a sandboxed Windows child has to start and announce its listener. */
const WINDOWS_CHANNEL_CONNECT_TIMEOUT_MS = 30_000;

/**
 * The sandboxed Windows launch of the reference runtime: Node's symlink-
 * preserving flags, the child entry, the loopback transport, and the child's
 * environment as one argument.
 *
 * The flags are {@link NODE_PRESERVE_SYMLINK_FLAGS}, which says why. For the
 * child the trade is narrow: the entry path is already the host's real path
 * (decision 33), and the host's integrity and path checks run on its side.
 * The environment is {@link srtWinTargetEnv}'s, which says what stays srt-win's.
 */
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

/**
 * Spawn the child under ASRT.
 *
 * Filesystem grants, and why each is the size it is:
 *
 *  - WRITE is a real jail, and what THIS SPAWN puts into it is `envelope.write`
 *    plus the throwaway sandbox HOME — no other path is added on this path.
 *    The runtime adds only device write defaults. All other write roots come
 *    from host policy, including the principal temp directory added by the
 *    confinement primitive. Shared temporary and cache paths get no implicit
 *    grant. The same scope is measured by `confined-plugin-child.test.ts`.
 *    What the host does NOT put in it is `pluginRoot`. A value under this
 *    plugin's bundle root, a value under a SIBLING's bundle under the same
 *    install root, and a value under a bundle root that is itself a symlink out
 *    of that install root are each refused by {@link ceilingSubtractions}, and
 *    each of those three has a case in `confined-plugin-child.test.ts` that
 *    goes red when its entry is removed.
 *    That root is the one the integrity check covers, and a plugin that could
 *    rewrite it could rewrite the bytes its own manifest hash was taken over.
 *    What CAN be in it under that root is `pluginDataDir` — the plugin's own
 *    storage namespace, which the production layout nests inside it
 *    (`~/.ave/plugins/<id>/data`, `plugin-storage-layout.ts`) — and
 *    directories INSIDE `pluginDataDir`, because a `userChosenDirectory` value
 *    may name the plugin's own default index location and that is where it
 *    lives. Because the data directory is nested there, the exclusion cannot be
 *    expressed by omitting a name from one list; it is the subtraction, applied
 *    between the two halves of {@link resolveUserChosenDirectory}'s ceiling,
 *    that carries it.
 *
 *    THE UNRESOLVED SIBLING is the edge this does not reach. The install-root
 *    entry is the lexical parent of THIS bundle, so a NEIGHBOUR's bundle that
 *    is itself a symlink out of the install root has a canonical form that
 *    entry does not contain, and no entry enumerates the neighbours — that
 *    would mean reading the install directory on every derivation. Stated as a
 *    residual rather than closed, and it is narrower than it sounds: the host
 *    is what creates an install directory, so a bundle root that is a link is a
 *    layout nothing in the app produces on its own.
 *  - READ in ASRT is deny-only — `allowRead` re-allows a region INSIDE a
 *    covering deny and is inert without one (see `asrt-sandbox.ts`). Plugins
 *    are installed under `<AVE_HOME>/plugins` (`plugin-paths.ts`), which the
 *    shared floor does NOT cover: it names `<AVE_HOME>/secrets` and its
 *    siblings, not the plugins root. So this spawn refuses the whole root on
 *    macOS and Linux (`denyPluginsRoot`, `asrt-sandbox.ts`), and the child's
 *    own root, data and socket directories — already in `envelope.read` — are
 *    re-allowed inside it. That deny is what makes "cannot read another
 *    plugin's data directory" true rather than aspirational; Admission's
 *    adversarial fixture measured a child listing and reading a neighbour's
 *    data before it existed (`adversarial-escapes.test.ts`, escape 1a). A
 *    declared `hostDirectory` grant widens the floor for that plugin.
 *
 * On Windows ASRT 0.0.80 supports no per-exec allow grants at all — passing any
 * makes `wrapWorkerCommand` throw — so the wrap carries the deny floor alone
 * (`grantMode: "deny-only"`) and reachability is an ACL question. The session
 * config grants nothing (`sandbox-init.ts` passes no `allowRead`/`allowWrite`),
 * and the default `<AVE_HOME>` in the user's profile admits no other account,
 * so this spawn grants the child its envelope and its sandbox HOME — read, and
 * write where the envelope writes — against a holder process it owns for the
 * child's lifetime (`holdWindowsFilesystemGrant`, the model `worker-spawn.ts`
 * uses for a worker). The grant is refused if any path reaches past the
 * plugin's own install or generation cache into a plugin-owned root
 * (`pluginGrantPathsBeyondOwnRoots`), is released on every way the child ends,
 * and a holder that dies stops the child. The grant is the ACL half of a
 * Windows `entry` child loading; the launch is the other half. srt-win gives
 * the target the sandbox profile's environment rather than `baseEnv`/
 * `extraEnv`, PowerShell does not wait for `electron.exe`, stdin is not
 * relayed, and the module import `lstat`s profile ancestors no grant covers —
 * so this spawn launches through `cmd.exe` with the environment in an
 * argument and Node's symlink-preserving flags, and speaks to the child over
 * an authenticated loopback connection ({@link windowsLoopbackLaunchLine},
 * `child-loopback-link.ts`; plugin-hostapi-protocol.md §2.3, §9.8 A2).
 *
 * §4's Windows residual stands unchanged and is not softened here: srt-win
 * confines filesystem and network but NOT process creation, so a confined
 * plugin child on Windows can still spawn. Nor are plugins isolated from each
 * other there, and by owner decision (2026-10-10) none is attempted: every
 * confined process runs as the one `srt-sandbox` account, so a grant to one
 * plugin's child or worker is visible to every confined process while it is held, and a
 * deny on a neighbour's directory would take it from that neighbour's own
 * processes too. Third-party plugins run on Windows under that shared identity
 * — sandboxed from the host as configured, not from each other — an accepted
 * risk pending ASRT per-plugin identity (plugin-hostapi-protocol.md §9.8 A2).
 */
export async function spawnConfinedPluginChild(
  spec: ConfinedPluginChildSpec,
): Promise<ConfinedPluginChild> {
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
    // Reviewer no-leak: the confined marker must not outlive the child. Runs
    // unconditionally (idempotent) so a spawn that failed AFTER onWrapped and
    // a normal exit both clear it.
    unmarkPluginChildConfined(spec.pluginId);
    // The Windows grant is the child's own reach; it must not outlive the
    // child on any path — exit, close, a spawn that produced no process, or a
    // failure before the spawn. `release` is idempotent.
    windowsGrant?.release();
    if (socketDirRegistered) {
      socketDirRegistered = false;
      // The ALLOW is a SHARED-config entry, so it outlives the child that
      // needed it and would accumulate one `(subpath <dir>)` per plugin ever
      // loaded. Removed on the same unconditional path the confined marker is.
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
    // Every root the wrap is about to grant is created first, `0o700` — the
    // same thing `worker-spawn.ts` does for the control-socket dir it grants.
    // An allow path that does not exist at wrap time is SILENTLY SKIPPED rather
    // than refused: ASRT 0.0.80's Linux backend drops a non-existent write path
    // and a non-existent read allow path from the bwrap argv with a debug line
    // and no error, and macOS's lexical rule admits the path but the kernel
    // still has no directory to open. Neither reports anything, so without this
    // pass the child would come up with an envelope quietly unequal to the one
    // that was reviewed — the failure to avoid is the silent inequality, not a
    // crash.
    // BOTH lists are walked rather than `read` alone: `read` is documented as a
    // superset of `write`, but nothing in the type or at runtime enforces that,
    // and a write-only root that slipped past it would be the one root this
    // pass exists for and the one it skipped. A creation failure throws, and
    // the plugin then does not load at all rather than loading with an envelope
    // the host did not decide on.
    // IT SITS INSIDE THE `try`, and not for tidiness: the throwaway HOME above
    // is a `mkdtemp` directory that only `releaseSandboxState` removes, and a
    // dangling-symlink grant makes this loop throw on the documented
    // fail-closed path. Run ahead of the `try` it left one such directory
    // behind per failed load, and `config.set` restarts the plugin, so a
    // setting that keeps failing kept accumulating them.
    for (const directory of [...spec.envelope.read, ...spec.envelope.write]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    // BEFORE the wrap, and that ordering is the whole point rather than a
    // preference. The Unix-socket ALLOW lives on ASRT's SHARED config, and the
    // seatbelt profile the child runs under is GENERATED when the command is
    // wrapped — so a registration that arrived afterwards would apply to the
    // next child and not to this one, and the symptom would be an `EPERM` on a
    // bind the host believes it permitted. (`asrt-sandbox.ts`, WORKER UDS
    // header: a per-command `allowUnixSockets` is inert; only the shared one is
    // read, and on macOS it must name the DIRECTORY, not the socket file.)
    //
    // Registered for EVERY confined child rather than for the plugins known to
    // want a socket: the directory is inside the plugin's own namespace and
    // grants no reach beyond it, so making it conditional would buy nothing and
    // would make "the plugin binds and it fails" depend on a list someone has
    // to remember to update.
    if (isPluginWorkerConfinementActive()) {
      await registerWorkerUnixSocketDir(socketDir, socketHolder);
      socketDirRegistered = true;
    }
    // The OTHER direction across the same boundary. `worker-spawn.ts` registers
    // one worker's leaf so that worker may BIND; this registers the plugin's
    // whole `run/` subtree so the child that asked for the worker may CONNECT.
    // Both are needed and neither implies the other: the bind allow is granted
    // to the worker's profile, and a profile is generated per wrapped command.
    //
    // The Unix-socket allow list is SHARED, so every registered directory
    // appears in every profile generated afterwards — plugin A's child carries
    // an allow naming plugin B's `run/`. That widens nothing, and the reason is
    // the same one that makes the `sockets/` registration above safe: the allow
    // is necessary but not sufficient. Reaching B's socket also means reaching
    // its PATH, and the filesystem jail is per-plugin — A's envelope names A's
    // directories and no others. The fs jail is the boundary; this list only
    // decides whether a Unix socket may be used at all.
    // Both registrations add to ASRT's SHARED allow-list, which exists only
    // while the sandbox does — with it off there is nothing to add to, and the
    // child is not wrapped, so nothing would read the entry.
    if (isPluginWorkerConfinementActive()) {
      await registerWorkerUnixSocketDir(workerRunRoot, socketHolder);
      workerRunRootRegistered = true;
    }
    // Windows: the wrap takes denies only, so the child's own directories are
    // granted to the shared `srt-sandbox` account for exactly the child's
    // lifetime, against a holder the host owns — the model a delegated worker
    // already uses (`worker-spawn.ts`). Without it the child reaches only what
    // the directories' existing ACLs admit, which under the default
    // `<AVE_HOME>` in the user profile is nothing: not its entry, not its data.
    // The grant is held to the plugin's own roots, because Windows has no
    // `denyPluginsRoot` to stop an inheriting grant from covering a neighbour.
    if (process.platform === "win32" && isPluginWorkerConfinementActive()) {
      // Each grant names the outermost envelope root only: `srt-win` stamps the
      // ACE on what a path resolves to, and a root nested in another — `data/`
      // under a runtime root that holds it, one chosen directory inside another
      // — is a path the inheriting grant on the outer root already covers, and
      // naming it again would hand `srt-win` a spelling to resolve
      // (`outermostContainingRoots`, decision 66). A chosen directory inside
      // `data/` never gets here: derivation folds it into `data/`.
      const allowRead = [...outermostContainingRoots(spec.envelope.read, spec.envelope.read), sandboxHome.path];
      const allowWrite = [...outermostContainingRoots(spec.envelope.write, spec.envelope.write), sandboxHome.path];
      const beyond = [
        ...pluginGrantPathsBeyondOwnRoots(spec.pluginId, [...allowRead, ...allowWrite]),
        // An ACL grant inherits: a write grant on the plugin root would cover
        // the host-only storage directory beside the data directory. The spec
        // carries `socketDir`, a sibling of `data/`, so the storage directory
        // derived beside it is the same one.
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
    // Windows, wrapped: srt-win relays no stdin, delivers none of this spawn's
    // environment, and PowerShell does not wait for `electron.exe` — so the
    // child is launched through `cmd.exe`, told its environment in an
    // argument, and spoken to over an authenticated loopback connection
    // instead of its pipes (`child-loopback-link.ts`). Everywhere else, and on
    // Windows with the sandbox off, the stdio child is unchanged.
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
      // The plugin's own temp directory, shared with its workers and bundled
      // hooks and with no other principal.
      tempPrincipal: { kind: "plugin", id: spec.pluginId },
      allowRead: [...spec.envelope.read, sandboxHome.path],
      allowWrite: [...spec.envelope.write, sandboxHome.path],
      // Every other plugin's code and data: the floor does not cover the
      // plugins root, so this spawn does wherever a deny can re-allow.
      ...(process.platform === "win32" ? {} : { denyPluginsRoot: true }),
      // The envelope names a floor-piercing host directory only when the
      // plugin's reviewed declaration asked for it.
      floorPierces: spec.envelope.read.filter((path) => hostDirectoryFloorPierces().includes(path)),
      // The data root above all: the host keeps resolving it, so a child that
      // could swap it for a link would steer the next storage handle or spawn.
      pinWriteRoots: true,
      baseEnv,
      extraEnv,
      // The child is a JSON-RPC server whose pipes the host owns, so unlike the
      // Python worker it needs stdin (on every path but Windows' loopback one,
      // where stdin is inert and stdout carries only the announce).
      stdio: ["pipe", "pipe", "pipe"],
      onWrapped: () => {
        wrapped = true;
        // Reviewer signal (sandbox-capability registry): tools owned by this
        // plugin now execute in a genuinely ASRT-confined child, so
        // resolveReviewerSandboxCapability may report the real capability for
        // them. Set ONLY on the wrapped path — an unwrapped spawn never marks.
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
    // Diagnostics only. The child rebinds everything except the framer to
    // stderr precisely so a stray plugin `console.log` lands here instead of
    // corrupting the protocol.
    child.stderr?.on("data", (chunk: Buffer) => {
      log.debug(`[${spec.pluginId}] ${chunk.toString("utf-8").trimEnd()}`);
    });
    // A launch that hands back a child already gone (its `exit` emitted before
    // these listeners) is released and reported at once, not waited on.
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    const exited = new Promise<void>((resolve) => {
      if (alreadyExited) resolve();
      child.once("exit", () => resolve());
      child.once("close", () => resolve());
    });
    child.once("exit", releaseSandboxState);
    child.once("close", releaseSandboxState);
    if (alreadyExited) releaseSandboxState();
    // Gone means the process no longer exists: it exited, or the spawn
    // produced no process to run. An `error` from a process that has a pid is
    // a fault on a live child — Node emits one when a signal could not be
    // delivered — and must not release it as if it were gone.
    const hasProcess = (): boolean => typeof child.pid === "number" && child.pid > 0;
    child.on("error", () => {
      if (!hasProcess()) releaseSandboxState();
    });
    // Why the child is gone, settled from here on: a child that dies before
    // anyone asks — while the channel is still being set up, or before the
    // caller attaches `onGone` — is still reported, and one that had already
    // exited by the time the launch handed it back (`exitCode`/`signalCode`
    // set, its `exit` possibly already emitted) is reported at once.
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
    // A holder that dies takes the grant's guarantee with it; the child it
    // served stops rather than run on a grant nobody holds.
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
      // The child may have died in the moment the handshake finished, its
      // `exit` not yet delivered: a channel to a dead child is no channel.
      if (child.exitCode !== null || child.signalCode !== null) {
        channel.destroy();
        terminateChild();
        throw new Error(
          `${exitedReason(child.exitCode, child.signalCode)} as its channel was connected`,
        );
      }
      // stdout now carries nothing the protocol reads; keep it drained and
      // logged, as stderr is.
      child.stdout.on("data", (chunk: Buffer) => {
        log.debug(`[${spec.pluginId}] stdout: ${chunk.toString("utf-8").trimEnd()}`);
      });
      // The connection IS the child's lifetime from here: a channel that
      // closes or fails leaves nothing to serve, so the process is ended and
      // its exit reported through `onGone` as for a pipe.
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
  /**
   * How the plugin's process is produced, and so what construct's `entryPath`
   * says (decision 33): the resolved, real path of the plugin's JS module
   * (not of the child runtime) for an `entry` plugin; for a `process` plugin
   * the launch `resolveProcessLaunch` built, whose command path construct
   * carries.
   */
  readonly launch:
    | { readonly kind: "entry"; readonly entryPath: string }
    | ({ readonly kind: "process" } & ProcessLaunch);
  /**
   * Defaults to the emitted `plugin-child-main.js` under the runtime asset dir.
   * The plugin runtime always passes the path its composition root resolved
   * (`PluginRuntimeOptions.childEntryPath`: {@link resolvePluginChildEntryPath}
   * in the app, a bundle of the same entry in the tests). It is the path the
   * CONFINED spawn runs for an `entry` launch, so a test that serves a
   * stand-in still runs it under the real wrap and bypasses nothing.
   */
  readonly childEntryPath?: string;
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
  /**
   * Told the wrap a child was spawned under, once, the moment the spawn
   * returns — before the grant re-check, so a construction that fails after
   * a child existed still reports that child's confinement. Not called when
   * no child was spawned. The runtime records it for the Doctor
   * (`PluginConfinementReport`); it can read a value and nothing more.
   */
  readonly onChildSpawned?: (confinement: SpawnConfinement) => void;
}

/**
 * The host protocol version this plugin's connection speaks (§3.2).
 *
 * Its declared, served `requires.hostProtocol`. Omission and unserved versions
 * fail before activation on the runtime loader's two paths; this check also
 * protects a direct connection from bypassing that gate.
 */
export function connectionHostProtocol(manifest: PluginManifest): HostProtocolVersion {
  const declared = manifest.requires?.hostProtocol;
  if (!isServedHostProtocolVersion(declared)) {
    throw new IncompatibleHostProtocolError(manifest.id, { declared: declared ?? null });
  }
  return declared;
}

/**
 * Build the factory the lifecycle calls in place of the in-process one.
 *
 * The returned factory does the whole of the boundary's setup — spawn,
 * dispatcher assembly, construct — inside ONE call, which is what puts it under
 * the host's existing `runPluginFactoryWithTimeout`. A child that never
 * finishes constructing therefore fails the plugin exactly as a factory that
 * never resolves does today, with no new timeout policy invented for it.
 */
export function createOutOfProcessPluginFactory(
  spec: OutOfProcessPluginSpec,
): RuntimePluginFactory {
  const childEntryPath = spec.childEntryPath ?? resolvePluginChildEntryPath();
  const pluginId = spec.manifest.id;

  return async (context: PluginRuntimeContext): Promise<RuntimePlugin> => {
    // Refused before anything is spawned. `runtime/index.ts` refuses the same
    // manifest at every load path; this is the spawn path's own copy of the
    // rule, so a factory reached any other way cannot start a child that would
    // be told a version it does not speak.
    const hostProtocolVersion = connectionHostProtocol(spec.manifest);
    // A `process` launch runs code the host cannot read, so it runs only under
    // a live sandbox that confines processes: never unwrapped (unlike an
    // `entry` launch with the sandbox off), and never on Windows, whose
    // sandbox does not confine process creation (§2.2, §7.3). The deny floor
    // and the wrap stay `spawnConfinedChild`'s.
    if (spec.launch.kind === "process" && (!isPluginWorkerConfinementActive() || process.platform === "win32")) {
      throw new ProcessEntryUnconfinedError();
    }
    const hostApi = context.hostApi as unknown as DispatchableHostApi;
    // Derived ONCE, here, and then held: the spawn wraps the child with it and
    // the dispatch table checks delegated workers against it, so the two cannot
    // be looking at different answers to the same question. Deriving it before
    // the spawn is also what makes a refused widening fail construction rather
    // than produce a child confined more narrowly than the host decided.
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
    // The only way this factory obtains a child: the confined spawn, with the
    // envelope derived above.
    let child: ConfinedPluginChild | undefined;
    try {
      child = await spawnConfinedPluginChild({
        pluginId,
        envelope,
        assertStillValid: () => registration?.assertCurrent(),
        socketDir: resolvePluginSocketDir(context.pluginDataDir),
        workerRunRoot: resolvePluginWorkerRunRoot(context.pluginDataDir),
        launch: spec.launch.kind === "entry"
          ? { kind: "entry", childEntryPath }
          : spec.launch,
      });
      spec.onChildSpawned?.(child.confinement);
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

    // The SAME envelope value the spawn received, so the boundary checks
    // delegated workers against the jail the child actually runs in.
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
        try {
          await spawned.waitForExit?.();
        } finally {
          registration?.dispose();
        }
      },
    });
    // The channel and `teardown` stay here: the lifecycle gets the instance,
    // whose `stop` is its one hand on the child's lifetime.
    return session.instance;
  };
}
