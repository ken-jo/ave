




import { spawn } from "node:child_process";
import { noteConfinedProcessesMayRun } from "../lib/confined-process-phase.js";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { policyHomeAnchors } from "../shared/policy-home.js";
import { aveHome } from "../shared/ave-home.js";
import { agentPluginDataRoot } from "../marketplace/content/agent-plugin-data.js";
import { testSandboxPrivateBase } from "../shared/ave-home-test-guard.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { globMatch } from "../lib/glob-matcher.js";
import { llmRouteBaseUrls } from "../shared/llm-vendor-defaults.js";
import { canonicalizePathForMatch, caseFoldForMatch, getConfiguredSessionReadPolicy, getRuntimeSensitiveKeyPaths, SENSITIVE_PATH_ENTRIES } from "./sensitive-paths.js";
import { hardenLinuxSandboxWrap } from "./linux-sandbox-wrap.js";
import { createLogger } from "../lib/logger.js";
import { hostDirectoryFloorPierces } from "../plugins/sandbox-authority.js";
import { resolvePluginPaths } from "../plugins/plugin-paths.js";
import { defaultHooksDir } from "../hooks/hook-discovery.js";

import type {
  SandboxRuntimeConfig,
  NetworkConfig,
  FilesystemConfig,
  WindowsConfig,
  WindowsBinShell,
  SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";

const log = createLogger("asrt-sandbox");

/**
 * The loopback PERMIT port range srt-win's egress proxy binds on Windows.
 *
 * SINGLE SOURCE OF TRUTH (Windows network model): the value the install flow
 * WFP-permits (`installWindowsSandbox({ proxyPortRange })`) MUST equal the value
 * the runtime config sets (`config.windows.proxyPortRange`), or the proxy binds
 * a port the WFP filter blocks and ALL egress hard-fails. Both sides reference
 * THIS one constant — {@link buildSandboxConfig} sources the runtime value from
 * it; the Windows install UX sources the WFP
 * value from the same export.
 *
 * Why not `export … from "@anthropic-ai/sandbox-runtime"`: ASRT is ESM-only and
 * deliberately NOT statically imported (a static import inlines its source into
 * the main bundle and breaks its vendor-binary resolution — see the module
 * header). So this mirrors ASRT's `DEFAULT_WINDOWS_PROXY_PORT_RANGE`
 * value `[60080, 60089]` as a plain literal. A unit test (asrt-sandbox.test.ts)
 * pins this against ASRT's REAL exported constant so any upstream drift fails
 * CI rather than silently desyncing the proxy bind from the WFP permit.
 */
export const DEFAULT_WINDOWS_PROXY_PORT_RANGE: readonly [number, number] = [
  60080, 60089,
];

/**
 * The `app.asar` → `app.asar.unpacked` path-segment rewrite, kept in ONE place.
 *
 * When Ave runs from a packaged Electron build, `@anthropic-ai/sandbox-runtime`
 * resolves to a VIRTUAL path inside `resources/app.asar`, but its vendored
 * payload (`vendor/srt-win/**`, selected by electron-builder `asarUnpack`) is
 * physically extracted to the sibling `app.asar.unpacked` tree. Any on-disk path
 * into that payload — the srt-win.exe binary, the ACL grant target — must have
 * its `.asar` segment rewritten to `.asar.unpacked`. In a dev checkout there is
 * no `.asar` segment, so the rewrite is a no-op.
 *
 * SINGLE AUTHORITY: {@link getVendoredSrtWinExePath} (the srt-win.exe path) and
 * the Windows-backend ACL target resolver (asrt-windows-support.ts) both rewrite
 * through THIS function, so the segment regex lives in exactly one spot.
 */
const APP_ASAR_PATH_SEGMENT = /(^|[\\/])app\.asar(?=$|[\\/])/i;

export function rewriteAsarPathToUnpacked(pathValue: string): string {
  return pathValue.replace(APP_ASAR_PATH_SEGMENT, "$1app.asar.unpacked");
}

/**
 * The explicit, absolute path to ASRT's vendored `srt-win.exe` — the SINGLE
 * SOURCE OF TRUTH for the Windows sandbox helper binary.
 *
 * ⚠️ WHY THIS EXISTS (ASRT 0.0.67 breaking change) ⚠️
 * ASRT 0.0.67 REMOVED implicit vendored-binary resolution: `resolveSrtWin(cfg)`
 * now THROWS unless `cfg.path` is set (`SrtWinConfigSchema.path` is required).
 * The packaged exe lives under the package root, which in a dev checkout sits
 * inside the working-tree write grant, so ASRT deliberately refuses to
 * auto-resolve it (a planted `srt-win.exe` there would otherwise be spawned as
 * the broker). Every Windows entry point — {@link buildSandboxConfig} →
 * `SandboxManager.initialize`, the boot dependency gate
 * ({@link checkAsrtDependencies}), and the per-worker ACL grant
 * ({@link grantWindowsWorkerFilesystemAccess}) — MUST therefore supply this path
 * explicitly, or the Windows OS-sandbox silently degrades at runtime (tsc cannot
 * catch it — the config field and the `resolveSrtWin` param are both optional).
 *
 * Resolution mirrors ASRT's own `VENDORED_SRT_WIN_EXE`: the package root
 * (`@anthropic-ai/sandbox-runtime/package.json` → dirname), rewritten for a
 * packaged `app.asar.unpacked` layout, then
 * `vendor/srt-win/<arch>/srt-win.exe` (arch from `process.arch`).
 *
 * SYNC + PURE so {@link buildSandboxConfig} stays synchronous for the unit tests
 * (same rationale as the DEFAULT_WINDOWS_PROXY_PORT_RANGE mirror). A pin test
 * (asrt-sandbox.test.ts) asserts this equals ASRT's real `VENDORED_SRT_WIN_EXE`,
 * so any upstream drift in the vendored layout fails CI rather than silently
 * resolving a wrong/absent path.
 */
export function getVendoredSrtWinExePath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return join(root, "vendor", "srt-win", arch, "srt-win.exe");
}

/** ASRT's vendored seccomp arch directories (`getVendorArchitecture`); ia32 and others have none. */
const SECCOMP_VENDOR_ARCH: Partial<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/**
 * The Linux seccomp helper bubblewrap runs, as one canonical file path — the
 * SINGLE SOURCE OF TRUTH both for what the wrap execs ({@link buildSandboxConfig}
 * pins it as ASRT's `seccomp.applyPath`) and for the one read a wrap is given
 * beneath a covering read deny ({@link seccompHelperHiddenBy}).
 *
 * WHY: ASRT runs `apply-seccomp` from INSIDE the bwrap namespace and leaves it
 * to the caller to keep that path visible there. A shell denies all of `$HOME`,
 * so an app or checkout under HOME hid its own helper and every strict wrap
 * exited 127 ("apply-seccomp: No such file or directory"). ASRT's own resolver
 * also asks `fs.existsSync`, which Electron answers true for a path inside
 * `app.asar`, so a packaged build would hand bwrap a virtual path no process
 * outside Electron can exec. The helper is unpacked
 * (`asarUnpack: node_modules/@anthropic-ai/sandbox-runtime/vendor/**`), so the
 * path is rewritten to `app.asar.unpacked` like {@link getVendoredSrtWinExePath},
 * then canonicalised so the exec'd spelling and the bound spelling are one.
 *
 * `undefined` off Linux, on an arch ASRT vendors no helper for, and — with a
 * one-time warning — when the vendored helper is missing or not a file; ASRT
 * then resolves the helper itself exactly as before this pin existed.
 */
export function getVendoredApplySeccompPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const arch = SECCOMP_VENDOR_ARCH[process.arch];
  if (arch === undefined) return undefined;
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const path = join(root, "vendor", "seccomp", arch, "apply-seccomp");
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    warnSeccompHelperUnavailable(`unreadable (${(error as NodeJS.ErrnoException).code ?? "error"}): ${path}`);
    return undefined;
  }
  if (!lstatSync(real).isFile()) {
    warnSeccompHelperUnavailable(`not a file: ${real}`);
    return undefined;
  }
  return real;
}

let seccompHelperWarned = false;

/**
 * A missing helper must not cost the session its filesystem confinement: a
 * throw here fails ASRT initialization, which the default mode degrades to
 * isolation=none. Without a pinned path ASRT resolves the helper itself and,
 * finding none, runs bwrap without seccomp (Unix sockets unrestricted) — the
 * behaviour before this pin existed. Logged once per process, not per wrap.
 */
function warnSeccompHelperUnavailable(detail: string): void {
  if (seccompHelperWarned) return;
  seccompHelperWarned = true;
  log.warn(
    `[sandbox-seccomp-unavailable] Vendored apply-seccomp helper is ${detail}; ` +
      "not pinning seccomp.applyPath or granting its read — ASRT falls back to its own resolution",
  );
}

/**
 * The seccomp helper file when one of a wrap's read denies (a shell's
 * whole-HOME deny) would hide it, else `undefined` (always off Linux). The
 * wrap then re-allows exactly that file, which ASRT emits as one `--ro-bind`
 * of itself inside the deny's tmpfs — never its directory or the package.
 */
function seccompHelperHiddenBy(denyRead: readonly string[]): string | undefined {
  const helper = getVendoredApplySeccompPath();
  if (helper === undefined) return undefined;
  const canonical = canonicalizePathForMatch(helper);
  return denyRead.some((denied) => readDenyCoversPath(denied, canonical)) ? helper : undefined;
}

/** Resolve the external JVM's agent from the physical packaged payload. */
export function getVendoredJavaProxyAgentJarPath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const root = rewriteAsarPathToUnpacked(dirname(packageJson));
  const path = join(root, "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error("[sandbox-java-agent-unavailable] Packaged JVM proxy agent is missing or invalid");
  }
  return path;
}

/**
 * The subset of ASRT configuration that is ONLY ever permitted to originate
 * from TRUSTED host/user settings.
 *
 * ⚠️ TRUST BOUNDARY — READ BEFORE EDITING ⚠️
 * The fields below WEAKEN the sandbox:
 *   - `allowAppleEvents`              — lets the child send Apple Events /
 *                                       Launch Services open requests (macOS).
 *   - `enableWeakerNetworkIsolation`  — opens `com.apple.trustd.agent`; a
 *                                       documented data-exfiltration vector.
 *   - `network.allowAllUnixSockets`   — removes the per-socket allow-list.
 *
 * The WEAKENING fields MUST be sourced exclusively from trusted user/host
 * configuration. They MUST NEVER be derived from plugin manifests,
 * project-local config, MCP server input, or any other
 * untrusted/attacker-influenced surface. Do not add a code path that lets
 * plugin/project config set any of these flags. Network is deny-by-default: an
 * empty `allowedDomains` means the sandboxed process has no network egress.
 *
 * NOTE on `allowedDomains`: this is the SHARED, enforced egress allow-list
 * (see the NETWORK ENFORCEMENT MODEL header). Boot computes it as the UNION of
 * every loaded, host-validated `manifest.networkAccess.allowedDomains` (∪ an
 * optional trusted host baseline) via {@link computeUnionAllowedDomains}. The
 * union itself is derived from manifests — a trusted seam (the host validated
 * those manifests at install) — but the WEAKENING flags above never are.
 */
export interface TrustedSandboxSettings {
  /**
   * The SHARED, ENFORCED egress allow-list. Empty/omitted ⇒ no network egress
   * (deny-by-default). Set this to the manifest UNION (+ trusted baseline) so
   * `filterNetworkRequest` allows exactly those domains. With
   * `strictAllowlist: true` any host not on this list is hard-denied with no
   * askCb fallthrough. See {@link computeUnionAllowedDomains}.
   */
  readonly allowedDomains?: readonly string[];
  /** Domains explicitly denied (takes precedence over allow). */
  readonly deniedDomains?: readonly string[];
  /** Enforce the allow-list strictly (no implicit infra domains). */
  readonly strictAllowlist?: boolean;
  /** Paths the child may read. */
  readonly allowRead?: readonly string[];
  /** Paths the child is denied reading (takes precedence). */
  readonly denyRead?: readonly string[];
  /** Paths the child may write. */
  readonly allowWrite?: readonly string[];
  /** Paths the child is denied writing (takes precedence). */
  readonly denyWrite?: readonly string[];
  /**
   * macOS-only: directories whose Unix-domain sockets the child may bind /
   * connect (emitted as `network.allowUnixSockets`, the seatbelt `(subpath
   * <dir>)` allow). The worker-UDS control channel uses this — see the WORKER
   * UDS header. TRUSTED-ONLY: host-allocated worker control-socket dirs, never
   * a plugin-supplied value. Ignored on Linux (seccomp is path-blind — the
   * `allowAllUnixSockets` weakening + the `--bind` of the writable dir apply
   * instead) and on Windows (no UDS primitive). Maintained additively at
   * runtime via {@link registerWorkerUnixSocketDir}.
   */
  readonly allowUnixSocketDirs?: readonly string[];
  /**
   * Sandbox-weakening flags. TRUSTED-ONLY (see the trust-boundary note above).
   * Never wire a plugin/project-config path to any field in this object.
   */
  readonly weakening?: {
    readonly allowAppleEvents?: boolean;
    readonly enableWeakerNetworkIsolation?: boolean;
    readonly allowAllUnixSockets?: boolean;
  };
  /**
   * Upstream HTTP/HTTPS proxy the sandbox's egress proxy should chain through
   * for outbound connections (corporate-proxy passthrough). TRUSTED-ONLY.
   *
   * SECURITY (parentProxy is passed explicitly):
   * ASRT's `resolveParentProxy` (parent-proxy.js:46) does
   * `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`. An EMPTY
   * object `{}` has no `http` key, so `cfg?.http` is `undefined` and the `??`
   * chain STILL inherits the HOST `HTTP_PROXY`/`HTTPS_PROXY` env — a covert
   * egress channel identical to passing no config at all. Only an EXPLICIT
   * EMPTY STRING short-circuits the chain (`'' ?? x` ⇒ `''`) and yields genuine
   * direct-connect. {@link buildSandboxConfig} therefore ALWAYS sets
   * `network.parentProxy.http`/`.https` explicitly:
   *   - default (this field omitted): empty strings ⇒ ASRT connects directly
   *     and does NOT chain through the host proxy (the secure floor);
   *   - present: only the explicit, trusted corporate-proxy URLs below are
   *     used -- never the ambient host env.
   * This field is the ONLY way to opt a sandbox into a parent proxy.
   */
  readonly corporateProxy?: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy?: string;
  };
  /**
   * Windows-only sandbox settings (srt-win network backend). TRUSTED-ONLY —
   * the proxy port range must agree with what the install flow WFP-permits.
   *
   * `proxyPortRange`: the loopback PERMIT range srt-win's egress proxy binds.
   * Defaults to {@link DEFAULT_WINDOWS_PROXY_PORT_RANGE} when omitted (which is
   * also what the install WFP-permits by default), so the proxy bind range
   * always matches the WFP rule. Set explicitly only when an enterprise install
   * used a non-default range. Has no effect off win32.
   */
  readonly windows?: {
    readonly proxyPortRange?: readonly [number, number];
  };
  /**
   * The REAL Electron `app.getPath("userData")` for this process, threaded in
   * from a TRUSTED main-process caller (boot.ts) that CAN import `electron`.
   *
   * When present: this EXACT path is denied (handles `--user-data-dir`,
   * XDG_CONFIG_HOME, and future productName changes correctly).
   * When absent: {@link getDefaultSensitiveReadDenyPaths} falls back to a
   * per-platform os.homedir() + literal derivation so there is always SOME
   * coverage even without the threaded value (e.g. the mcp-client wrap path).
   *
   * IMPORTANT: do NOT derive this from plugin manifests, project config, or
   * any untrusted source — only from `electron.app.getPath("userData")` in
   * the main process.
   */
  readonly userDataDir?: string;
}

/**
 * Per-command filesystem scoping. This is the ONLY config a caller may vary
 * per command, and it can only ever NARROW or RE-SHAPE the filesystem jail —
 * it cannot widen network egress and cannot carry any sandbox-weakening flag.
 *
 * Windows ASRT 0.0.76 note: `srt-win exec` supports per-exec `denyRead` /
 * `denyWrite` only. Non-empty per-exec `allowRead` / `allowWrite` is rejected
 * before calling ASRT. Long-lived plugin workers that need explicit read/write
 * grants use {@link grantWindowsWorkerFilesystemAccess} with a dedicated
 * holder PID instead of passing allow grants through this per-exec channel.
 *
 * ⚠️ TRUST BOUNDARY ⚠️
 * `wrapWithSandboxArgv` accepts a `customConfig: Partial<SandboxRuntimeConfig>`
 * that ASRT merges over the initialized config for this command only — that is
 * the single channel through which a per-command call could otherwise smuggle
 * a weakening flag (`allowAppleEvents`, `enableWeakerNetworkIsolation`,
 * `network.allowAllUnixSockets`) past the trusted-settings gate. To keep that
 * channel safe by construction, callers pass ONLY this narrow filesystem shape;
 * {@link buildPerCommandSandboxCustomConfig} maps it to the exact
 * `{ filesystem }` slice handed to ASRT. There is deliberately no field here
 * for network or weakening flags, so a plugin/project-influenced call site
 * cannot reach them.
 */
export interface PerCommandFilesystem {
  /** Paths the child may write for this command (the derived write-jail). */
  readonly allowWrite?: readonly string[];
  /** Paths the child may read (e.g. cwd re-allowed after a HOME-wide deny). */
  readonly allowRead?: readonly string[];
  /** Paths the child is denied reading (e.g. $HOME, to fix the read-jail leak). */
  readonly denyRead?: readonly string[];
  /** Paths the child is denied writing (takes precedence over allowWrite). */
  readonly denyWrite?: readonly string[];
  /**
   * The child may write INSIDE each `allowWrite` root but not unlink, rename
   * or replace the root itself. Set by every wrap of PLUGIN-OWNED code — the
   * plugin child, its workers, bundled hooks and MCP stdio servers — whose
   * write roots are directories the host created and keeps resolving, a
   * plugin's data root above all. Never by a wrap of the user's own shell or
   * tools, whose write roots are the user's workspaces. Narrows only: it adds
   * write denies (see {@link PINNED_WRITE_ROOT_MARKER}), so it requires
   * `denyWrite` to be restated, since a per-command `denyWrite` replaces the
   * shared floor rather than extending it.
   */
  readonly pinWriteRoots?: boolean;
  /**
   * Reads this wrap may hold inside the protected read floor, each one also
   * named in `allowRead`. Without it every `allowRead` entry under the floor
   * is withheld. Composers set it for an exact user hook script, the builtin
   * shell's configured saved-session root, or a plugin's declared
   * `hostDirectory` that pierces the floor (`certs`). Anything else
   * is refused (see {@link readGrantsOutsideReadDenies}).
   */
  readonly floorPierces?: readonly string[];
  /**
   * Refuse this wrap every root that holds a plugin's code or data
   * ({@link ensurePluginOwnedReadRoots}): the plugins root, `<AVE_HOME>/plugins`
   * — every plugin's code, data, generation payloads and receipts, and the
   * registry — and the two roots of agent plugins, `<AVE_HOME>/agent-plugin-data`
   * (each one's data) and `<AVE_HOME>/packages/agent-plugin` (each one's
   * installed versions). Set by every wrap of plugin-owned or third-party code
   * — the plugin child, its workers, bundled hooks and MCP stdio servers —
   * never by a wrap of the user's own shell or tools. The floor covers none of
   * these roots, and ASRT's reads are deny-only, so without it any such process
   * reads every other plugin's data.
   *
   * The wrap's own directories stay reachable because an `allowRead` entry
   * inside a covering deny is re-allowed: seatbelt's later allow, bubblewrap's
   * bind over the tmpfs. A process that belongs to a plugin names that
   * plugin's directories in `allowRead`; one that belongs to no plugin names
   * none. On Linux a read re-allow of a directory that holds a write root
   * would shadow that root's writable bind, and {@link hardenLinuxSandboxWrap}
   * puts the write back. A plugin installed after the wrap is covered as well:
   * the deny is the root, not a list of what was in it — which is why each
   * root is created before the wrap: Linux's bwrap skips a read deny on a path
   * that is not there, so a root made later would be visible to every process
   * wrapped before it.
   *
   * macOS and Linux only, and refused on Windows: ASRT applies a Windows deny
   * as an ACE for the ONE `srt-sandbox` account every confined process runs
   * as, so a deny on a neighbour's directory would take it from that
   * neighbour's own child too, and nothing re-allows there.
   */
  readonly denyPluginsRoot?: boolean;
}

export interface WindowsWorkerFilesystemGrant {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  release(): void;
}

/**
 * Per-command wrap options. `filesystem` scopes the per-command read/write jail
 * (the only thing allowed to vary per command — see {@link PerCommandFilesystem}).
 */
export interface WrapOptions {
  readonly filesystem?: PerCommandFilesystem;
  readonly abortSignal?: AbortSignal;
  /**
   * The INNER shell ASRT should run the command under. Cross-platform string
   * surface forwarded verbatim to `wrapWithSandboxArgv(command, binShell, …)`:
   *   - Windows: `'powershell'` | `'pwsh'` | `'cmd'` | an absolute Git Bash /
   *     sh.exe path — ASRT's `parseWindowsBinShell` renders the executable
   *     ITSELF (e.g. `powershell.exe -NoProfile -Command <command>`). The caller
   *     therefore passes the BARE command, NOT a pre-rendered `powershell.exe
   *     -Command '…'` string (pre-rendering + a default `cmd` binShell produced
   *     a `cmd /c "powershell.exe -Command …"` DOUBLE shell).
   *   - macOS/Linux: the POSIX shell to run `-c <wrapped>` under (defaults to
   *     `/bin/bash` inside ASRT when omitted). The Bash tool passes its resolved
   *     Bash executable so sandboxed, foreground and background execution use
   *     the same dialect.
   *
   *   - Windows object form `{ exe, args }`: an absolute shell with the exact
   *     flags, which ASRT passes through unchanged — how the plugin child gets
   *     `cmd.exe /d /v:off /s /c` (`confined-child.ts`, `windowsShell: "cmd"`),
   *     since the bare `'cmd'` token leaves delayed expansion to the registry.
   *
   * TRUST: on Windows the inner shell runs INSIDE the restricted-token sandbox,
   * so an unexpected value is not a sandbox escape; but a bash `path` must still
   * originate from trusted host shell-detection (never workspace content) — it
   * is an arbitrary-exec footgun otherwise. Ave only ever passes the fixed
   * shell-name discriminants here, a trusted resolved shell path, or the
   * System32 `cmd.exe` object above.
   */
  readonly binShell?: string | WindowsBinShell;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKER UDS CONTROL CHANNEL — SHARED-CONFIG, NOT PER-COMMAND
 * A long-lived HTTP plugin worker the HOST connects INBOUND to needs a Unix-
 * domain-socket (UDS) control channel — loopback TCP is unreachable through
 * Linux's bwrap `--unshare-net` namespace. The Unix-socket ALLOW config that
 * lets the worker `bind()` the socket is enforced through ASRT's SHARED config,
 * NOT the per-command `customConfig`:
 *   sandbox-manager.js `getAllowUnixSockets()` / `getAllowAllUnixSockets()` read
 *   the module-level SHARED `config` (lines 555-559), and `wrapWithSandbox`
 *   feeds THOSE into `generateSandboxProfile` (macOS) / `wrapCommandWithSandbox-
 *   Linux` (linux). A per-command `customConfig.network.allowUnixSockets` is
 *   NEVER consulted for the seatbelt/seccomp UDS rules — it is INERT, the SAME
 *   class of inertness as the egress allow-list (see the module header).
 * VERIFIED empirically on darwin (uds probe): a per-command allowUnixSockets ⇒
 * the worker's `listen()` fails with EPERM; the SAME value on the SHARED config
 * ⇒ the bind succeeds and the host reaches /health over the socket.
 *
 * SCOPING (verified): on macOS `allowUnixSockets` must contain the socket's
 * DIRECTORY (the seatbelt rule is `(subpath <dir>)`); the socket-FILE path
 * gives EPERM. On Linux the path is ignored (seccomp is path-blind) — the
 * `--bind` of the writable socketDir (a per-command `allowWrite`, which DOES
 * compose) scopes WHERE the worker can create the socket; the trusted
 * `allowAllUnixSockets` weakening only re-permits the AF_UNIX syscall family.
 *
 * So the worker-UDS allowance is maintained as a LIVE addition to the SHARED
 * config: {@link registerWorkerUnixSocketDir} adds a worker's socketDir and
 * pushes an `updateConfig`; {@link unregisterWorkerUnixSocketDir} removes it.
 * The base trusted settings (the manifest egress union, denyRead floor, etc.)
 * are remembered at init/update so the rebuild is additive, never clobbering.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The trusted settings last applied via {@link initializeAsrtSandbox} /
 * {@link updateAsrtSandboxConfig}. Remembered so worker-UDS register/unregister
 * can rebuild the SHARED config additively (the manifest egress union, denyRead
 * floor, weakening flags, etc. are preserved). Undefined before the first init.
 */
let _baseTrustedSettings: TrustedSandboxSettings | undefined;

/**
 * Live host-allocated socket DIRECTORIES currently registered for UDS access
 * (see the WORKER UDS header), each with the number of holders that registered
 * it. Each entry contributes a macOS `allowUnixSockets` `(subpath <dir>)`
 * allow; their presence also turns on the Linux `allowAllUnixSockets`
 * weakening (path-blind seccomp re-permit).
 *
 * COUNTED, not a set: one directory has more than one holder at a time. A
 * plugin's `sockets/` and `run/` are per PLUGIN, not per generation, so during
 * an update or restart the candidate child registers the same directories the
 * predecessor still holds, and the predecessor retires FIRST
 * (`plugin-bundle-lifecycle.ts` awaits retirement before the candidate's
 * `onPublished`). A set dropped the directory on that release, so every child
 * wrapped afterwards — the candidate's own workers, started from
 * `onPublished` — was generated without the allow while the candidate still
 * held it. Maintained by {@link registerWorkerUnixSocketDir} / its unregister;
 * every caller pairs one unregister with each successful register. A register
 * resolves only after the dir's push has landed, so a resolved holder never
 * wraps a child without the allow.
 */
interface WorkerUnixSocketDirEntry {
  readonly holders: Set<object>;
  registered: boolean;
  /** Settles when the push that first added this dir to the shared config lands or fails. */
  readonly pushed: Promise<void>;
}
const _workerUnixSocketDirs = new Map<string, WorkerUnixSocketDirEntry>();

/**
 * Merge the live worker-UDS state into a base {@link TrustedSandboxSettings} to
 * produce the effective settings for the SHARED config. macOS: union the
 * registered dirs into `allowRead`-independent `allowUnixSockets` via a new
 * field; Linux: when ANY worker dir is registered, force the trusted
 * `allowAllUnixSockets` weakening on (the base value otherwise).
 */
function withWorkerUnixSockets(
  base: TrustedSandboxSettings,
  pendingDir?: string,
): TrustedSandboxSettings {
  const dirs = [..._workerUnixSocketDirs]
    .filter(([dir, entry]) => entry.registered || dir === pendingDir)
    .map(([dir]) => dir);
  if (dirs.length === 0) return base;
  return {
    ...base,
    allowUnixSocketDirs: [
      ...(base.allowUnixSocketDirs ?? []),
      ...dirs,
    ],
    weakening: {
      ...base.weakening,
      // Linux needs the AF_UNIX seccomp re-permit for any worker UDS; macOS
      // ignores this (it uses the path-scoped allowUnixSockets above).
      allowAllUnixSockets:
        process.platform === "linux"
          ? true
          : base.weakening?.allowAllUnixSockets,
    },
  };
}

/**
 * Map the trust-safe {@link PerCommandFilesystem} to the `customConfig` slice
 * ASRT merges for this command. Only the `filesystem` section is ever produced
 * here: network and weakening flags are intentionally unreachable from a
 * per-command call so the trusted-settings gate cannot be bypassed.
 */
export function hasPerExecFilesystemAllowGrants(
  filesystem: PerCommandFilesystem | undefined,
): boolean {
  return (
    (filesystem?.allowRead?.length ?? 0) > 0 ||
    (filesystem?.allowWrite?.length ?? 0) > 0
  );
}

export function assertPerExecFilesystemSupported(
  filesystem: PerCommandFilesystem | undefined,
  caller: string,
): void {
  if (process.platform !== "win32" || !hasPerExecFilesystemAllowGrants(filesystem)) {
    return;
  }
  throw new Error(
    `${caller}: ASRT 0.0.76 on Windows does not support per-exec ` +
      "filesystem.allowRead/allowWrite; only per-exec denyRead/denyWrite " +
      "are supported. Long-lived plugin workers must use the holder-PID " +
      "Windows ACL grant path instead.",
  );
}

/**
 * A name inside each pinned write root that the child may not write. Nothing is
 * ever created there; the deny exists for what ASRT derives from it.
 *
 * WHY A CHILD DENY PINS THE ROOT. A Seatbelt write grant is `(subpath W)`,
 * which covers W's own entry, and the read section re-allows
 * `file-write-unlink`/`file-write-create` on every write root — so a child can
 * `rmdir W` and `ln -s elsewhere W`, or rename W away. For every write deny
 * ASRT also emits `(deny file-write-unlink file-write-create (literal D))` for
 * each ancestor D of the denied path, after those allows, and the last
 * matching rule wins. A deny on `W/<marker>` therefore makes `(literal W)`
 * unremovable and unreplaceable while every other entry inside W stays
 * writable. ASRT 0.0.76 offers no per-command literal rule of its own, so the
 * root is pinned through this one.
 *
 * macOS only. Under bubblewrap each write root is its own bind mount: the
 * child's `rmdir` or `rename` of it fails with EBUSY, so the marker is not
 * added there (the confinement cases in `confined-plugin-child.test.ts`
 * assert both platforms).
 */
const PINNED_WRITE_ROOT_MARKER = ".ave-pinned-write-root";

/**
 * The marker denies for {@link PerCommandFilesystem.pinWriteRoots}. Built here,
 * inside the wrap, after the caller has created every root it grants — the
 * principal's temp directory included ({@link ensureSandboxTempPrincipalDir}) —
 * so each one exists when its marker is computed.
 */
function pinnedWriteRootDenies(writeRoots: readonly string[]): string[] {
  if (process.platform !== "darwin") return [];
  const denies: string[] = [];
  for (const root of writeRoots) {
    // Canonical, because Seatbelt matches real paths and ASRT canonicalises
    // only paths that exist: the marker never does, so `/var/…` would stay
    // `/var/…` and its derived literal would never match `/private/var/…`. A
    // root that does not exist is dropped from the grant by ASRT, so there is
    // nothing to pin.
    let real: string;
    try {
      real = realpathSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    denies.push(join(real, PINNED_WRITE_ROOT_MARKER));
  }
  return denies;
}

/**
 * The read denies as handed to ASRT, with each sandbox private root
 * ({@link appOwnedSandboxPrivateRoots}) spelled so a wrap keeps its own
 * directory under it on macOS.
 *
 * Seatbelt is last-match-wins. ASRT emits the denies, then the allows, then
 * re-emits after the allows every literal deny that sits strictly inside some
 * literal allow — with no carve-outs. A wrap whose reads include any ancestor
 * of a private root (a workspace at HOME, the host temp directory above an
 * `AVE_HOME` there) therefore lost its own HOME and temp directory: measured,
 * a bundled wrap's read-back of its own HOME failed with EPERM. A glob deny is
 * always re-emitted late, minus each allow inside it, so the root is spelled as
 * a one-character class naming the same path (`…/hom[e]`, `…/tm[p]`). The
 * root and every other directory under it stay denied, and the wrap's own
 * directory stays readable whatever else it is granted.
 *
 * The root is canonicalised first: ASRT resolves only a glob's static prefix,
 * and keeps the pattern unresolved when that prefix is a link leaving its
 * boundary, which would leave a deny that never matches the real path. Linux
 * keeps the literal: a deny there is a tmpfs mask with the allows inside it
 * bound back, whatever their order, while a glob is expanded once per wrap.
 */
function asrtReadDenyPaths(denyRead: readonly string[], exactRoots: readonly string[]): string[] {
  if (process.platform !== "darwin") return [...denyRead];
  const roots = new Set(exactRoots);
  return denyRead.map((path) => (roots.has(path) ? exactSeatbeltDenyGlob(path) : path));
}

function exactSeatbeltDenyGlob(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch (error) {
    // Not created yet: nothing is under it to read, and the deny still names it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (/[*?[\]]/.test(real)) {
    throw new Error(`sandbox: ${real} contains glob characters; the read deny cannot name it exactly`);
  }
  return `${real.slice(0, -1)}[${real.slice(-1)}]`;
}

/**
 * The roots {@link PerCommandFilesystem.denyPluginsRoot} refuses, each created
 * (`0o700`) if absent so the deny exists on Linux before anything is installed
 * under it. Their layouts are owned elsewhere: the plugins root by
 * `plugin-paths.ts`; an agent plugin's data by the `agent-plugin-data` feature
 * namespace (`agent-plugin-hook-runtime.ts`, `agent-plugin-mcp-runtime.ts`);
 * its installed versions by the content store's `<packages>/<kind>/<name>/<version>`
 * (`content/store.ts`) under `<AVE_HOME>/packages` (`marketplace-content.ts`).
 * What a wrap owns under them — an agent plugin's generation and data for its
 * hook or bundled server — is re-allowed by the caller, as for the plugins root.
 */
function ensurePluginOwnedReadRoots(): string[] {
  const roots = pluginOwnedReadRoots();
  for (const root of roots) mkdirSync(root, { recursive: true, mode: 0o700 });
  return roots;
}

function pluginOwnedReadRoots(): string[] {
  const home = aveHome();
  return [resolvePluginPaths().pluginsRoot, agentPluginDataRoot(), join(home, "packages", "agent-plugin")];
}

/**
 * Whether `path` lies within `root`, asked the way a filesystem GRANT must ask
 * it. On Windows both sides go through the same canonicaliser admission uses
 * (`canonicalizePathForMatch`: realpath, which expands 8.3 short names and
 * follows links, then `caseFoldForMatch`), so `…\acme\DATA\work` or
 * `C:\Users\RUNNER~1\…` is recognised as inside `…\acme\data` — a lexical,
 * case-sensitive comparison left such a spelling an independent root, and a
 * Windows grant on an independent root below `data\` is a grant on whatever
 * the plugin later puts there. Elsewhere the comparison stays lexical on the
 * resolved paths, unchanged.
 */
export function isGrantPathWithin(root: string, path: string): boolean {
  if (process.platform !== "win32") {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  }
  const foldedRoot = caseFoldForMatch(canonicalizePathForMatch(root));
  const foldedPath = caseFoldForMatch(canonicalizePathForMatch(path));
  return foldedPath === foldedRoot
    || foldedPath.startsWith(foldedRoot.endsWith("/") ? foldedRoot : `${foldedRoot}/`);
}
/**
 * Each of `paths` replaced by the OUTERMOST of `roots` that contains it, in
 * order and without duplicates; a path no root contains is an error (callers
 * check containment first).
 *
 * What a Windows filesystem grant is given instead of the path a plugin named.
 * `srt-win acl grant` canonicalises the path it is handed — it follows a
 * junction or symlink in any component and stamps its `(OI)(CI)` ACE on the
 * TARGET (measured on ASRT 0.0.76: a grant on `data\link` landed on the
 * directory the junction named). A path below an envelope root passes through
 * directories the plugin's own process can replace with a junction between any
 * check and the grant, so no lstat walk closes it. What the outermost root
 * rests on depends on which root it is. `data/` and `sockets/` are directories
 * the host created under `plugins/<id>/`, whose parent no confined process can
 * write, so they cannot be re-pointed. A chosen directory or a `hostDirectory`
 * root is not host-made: it rests on the user's approval and on no confined
 * process holding write on its parent — which one plugin's child does hold
 * when its own chosen directory contains another plugin's, since every
 * confined process runs as the one sandbox account (decision 64). For the same
 * reason granting the root widens nothing on Windows: a worker granted it
 * reaches only what the plugin's own process already does.
 */
export function outermostContainingRoots(paths: readonly string[], roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const containing = roots.filter((root) => isGrantPathWithin(root, path));
    const outermost = containing.find((root) => !containing.some((other) =>
      other !== root && isGrantPathWithin(other, root) && !isGrantPathWithin(root, other)));
    if (outermost === undefined) {
      throw new Error(`[asrt-sandbox] ${path} lies under none of ${roots.join(", ")}`);
    }
    if (!out.includes(outermost)) out.push(outermost);
  }
  return out;
}

/**
 * The paths of a Windows plugin grant that would reach past the plugin's own
 * directories into the roots macOS and Linux refuse every plugin-owned wrap
 * ({@link PerCommandFilesystem.denyPluginsRoot}). Windows has no such deny, so
 * the grant itself is held to it: a path may lie inside the plugins root only
 * under the plugin's own install (`<plugins>/<id>`) or generation cache
 * (`<plugins>/.cache/<id>`); never inside an agent plugin's roots, which no
 * `entry` plugin owns; and never at or above any of the roots, since an
 * inheriting grant there would cover every plugin under it. Empty when the
 * grant is the plugin's own.
 */
export function pluginGrantPathsBeyondOwnRoots(pluginId: string, paths: readonly string[]): string[] {
  const fold = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  const within = (path: string, root: string): boolean => {
    const rel = relative(fold(root), fold(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const roots = pluginOwnedReadRoots();
  const { pluginsRoot, cacheRoot } = resolvePluginPaths();
  const own = [join(pluginsRoot, pluginId), join(cacheRoot, pluginId)];
  return paths.filter((path) =>
    roots.some((root) => within(root, path))
    || (roots.some((root) => within(path, root)) && !own.some((ownRoot) => within(path, ownRoot))));
}

export function buildPerCommandSandboxCustomConfig(
  filesystem: PerCommandFilesystem | undefined,
): Partial<SandboxRuntimeConfig> | undefined {
  if (filesystem === undefined) return undefined;
  if (filesystem.pinWriteRoots === true && filesystem.denyWrite === undefined) {
    throw new Error(
      "buildPerCommandSandboxCustomConfig: pinWriteRoots needs denyWrite restated; a per-command denyWrite "
        + "replaces the shared deny floor",
    );
  }
  if (filesystem.denyPluginsRoot === true) {
    if (process.platform === "win32") {
      throw new Error(
        "buildPerCommandSandboxCustomConfig: denyPluginsRoot is refused on Windows; a deny there is an ACE for the "
          + "one sandbox account every confined process shares, so it would refuse each plugin its own directories",
      );
    }
    if (filesystem.denyRead === undefined) {
      throw new Error(
        "buildPerCommandSandboxCustomConfig: denyPluginsRoot needs denyRead restated; a per-command denyRead "
          + "replaces the shared deny floor",
      );
    }
  }
  const fs: Partial<FilesystemConfig> = {};
  const floor = getProtectedReadDenyPaths();
  // A per-command deny REPLACES the shared one, so the trusted custom denies
  // are restated here once for every wrap rather than by each composer.
  let hiddenSeccompHelper: string | undefined;
  if (filesystem.denyRead !== undefined) {
    const pluginRoots = filesystem.denyPluginsRoot === true ? ensurePluginOwnedReadRoots() : [];
    const denyRead = [...new Set([...filesystem.denyRead, ...pluginRoots, ...(_baseTrustedSettings?.denyRead ?? [])])];
    hiddenSeccompHelper = seccompHelperHiddenBy(denyRead);
    fs.denyRead = asrtReadDenyPaths(
      denyRead,
      // The plugin roots are spelled exactly for the reason the private roots
      // are: a wrap whose reads include an ancestor of one (a worker's or a
      // bundled process's host temp directory, above a test `AVE_HOME`) would
      // otherwise lose its own plugin directories to the re-emitted deny.
      [...appOwnedSandboxPrivateRoots(), ...pluginRoots],
    );
  }
  if (filesystem.allowWrite !== undefined) fs.allowWrite = writeRootsOutsideReadDenies(filesystem.allowWrite, floor);
  if (filesystem.denyWrite !== undefined) {
    fs.denyWrite = [
      ...filesystem.denyWrite,
      ...(filesystem.pinWriteRoots === true ? pinnedWriteRootDenies(filesystem.allowWrite ?? []) : []),
    ];
  }
  if (filesystem.allowRead !== undefined || hiddenSeccompHelper !== undefined) {
    // A per-command allowRead REPLACES the shared one, so a wrap that only
    // restates its denies keeps the shared grants alongside the seccomp helper.
    // The helper joins before the floor filter: a protected deny still wins.
    const grants = filesystem.allowRead ?? _baseTrustedSettings?.allowRead ?? [];
    fs.allowRead = readGrantsOutsideReadDenies(
      hiddenSeccompHelper === undefined || grants.includes(hiddenSeccompHelper) ? grants : [...grants, hiddenSeccompHelper],
      floor,
      // Restated shared grants keep the shared config's pierces (none, as in
      // buildSandboxConfig); a wrap's own pierces cover only its own grants.
      filesystem.allowRead !== undefined ? (filesystem.floorPierces ?? []) : [],
    );
  }
  if (Object.keys(fs).length === 0) return undefined;
  return { filesystem: fs as FilesystemConfig };
}

/** The host spawns this; ASRT never spawns the workload itself. */
export interface SandboxWrapResult {
  readonly argv: string[];
  readonly env: NodeJS.ProcessEnv;
}

function applyLinuxReadMaskWriteFloor(
  wrapped: SandboxWrapResult,
  filesystem: PerCommandFilesystem | undefined,
  cleanupAfterCommand: () => void,
): SandboxWrapResult {
  if (process.platform !== "linux") return wrapped;
  try {
    // The same slice the wrap was built from — the re-allows and write denies
    // ASRT was given, after the floor withheld what it withholds.
    const applied = buildPerCommandSandboxCustomConfig(filesystem)?.filesystem;
    return hardenLinuxSandboxWrap(wrapped, {
      ...(applied?.allowRead !== undefined ? { allowRead: applied.allowRead } : {}),
      ...(applied?.denyWrite !== undefined ? { denyWrite: applied.denyWrite } : {}),
    });
  } catch (error) {
    cleanupAfterCommand();
    throw error;
  }
}

/**
 * Dynamically import the ESM-only ASRT package. Kept in one place so the
 * dynamic-import shape (and the ESM-in-Electron rationale above) lives in a
 * single spot. Resolved lazily — importing this module has no side effects.
 */
async function loadSandboxManager() {
  const mod = await import("@anthropic-ai/sandbox-runtime");
  return mod.SandboxManager;
}

/**
 * Whether {@link initializeAsrtSandbox} has run to completion in this process.
 *
 * This is the host-tool spawn path's gate: tool code (bash.ts/powershell.ts)
 * asks THIS module — not the settings service — whether to route through ASRT,
 * so the gate is decided once at boot and cannot be re-evaluated mid-run. That
 * preserves the seal-after-boot security property the §691 registry had: there
 * is no runtime channel to flip the sandbox on/off after boot. Set to `true`
 * only on a successful `initialize`; stays `false` after {@link resetAsrtSandbox}.
 */
let active = false;

/** Host-tool spawn gate. True once {@link initializeAsrtSandbox} succeeds. */
export function isAsrtSandboxActive(): boolean {
  return active;
}

/**
 * The SINGLE SOURCE OF TRUTH for the host-secret / sensitive read deny-list.
 *
 * ⚠️ HONEST SCOPE — this is a DENY-LIST, NOT a read-ALLOW jail ⚠️
 * ASRT's filesystem READ model is deny-only (sandbox-manager.js
 * `getFsReadConfig` / `wrapWithSandbox`): `filesystem.denyRead` becomes the
 * `denyOnly` set (seatbelt `(deny file-read* (subpath …))` / bwrap path-deny)
 * and `filesystem.allowRead` is `allowWithinDeny` — it only RE-ALLOWS a nested
 * region INSIDE a covering deny, so it is INERT without one. There is no clean
 * "deny everything, allow only X" read jail in ASRT, so we cannot allow-list
 * reads; we can only enumerate the KNOWN-sensitive subpaths to deny. A path not
 * on this list stays readable. Do NOT describe this as a read jail.
 *
 * WHAT IS DENIED — this function restates NOTHING. Every path except the
 * Electron userData dir below is projected from `SENSITIVE_PATH_ENTRIES`
 * (src/permissions/sensitive-paths.ts), the single authority that the
 * in-process host-tool guard projects into globs. Read the table for the
 * contents; do NOT mirror them here, or the mirror becomes the next thing to
 * drift. Add a row THERE and both surfaces deny it.
 *
 * The ONE path this function adds on its own:
 *   - Electron userData dir (productName="Ave") — whole dir, deny-by-default so
 *     future Electron auth artefacts are covered automatically.
 *     Exact path when `userDataDir` is provided by a trusted caller (handles
 *     `--user-data-dir` + XDG_CONFIG_HOME + future renames); falls back to:
 *       macOS: ~/Library/Application Support/Ave
 *       Linux: ${XDG_CONFIG_HOME:-~/.config}/Ave  (mirrors Electron's resolution)
 *       Windows: ~/AppData/Roaming/Ave
 *     Contains: plugin OAuth session cookies/tokens (Partitions/), Cookies (SQLite),
 *     Local/Session Storage, Network Persistent State, Trust Tokens,
 *     ave-secrets.json (safeStorage-encrypted plugin secrets). It is not a
 *     table row because the EXACT dir is only knowable at runtime; the host
 *     guard pins the per-platform DEFAULT locations as static globs instead.
 *
 * WHAT IS DELIBERATELY NOT DENIED (over-deny safety):
 *   - `$HOME` WHOLESALE — denying all of `~` would break most legit shell tools
 *     (a build reading `~/.cargo`, `~/.rustup`, `~/.config`, etc.). We deny
 *     SPECIFIC secret/history subpaths only.
 *   - `~/.config` WHOLESALE — only specific subdirs (~/.config/gcloud, ~/.config/gh,
 *     ~/.config/git) are denied, not all of ~/.config.
 *   - the cwd / working tree, the plugin's own sandbox root, system dirs
 *     (`/usr`, `/lib`, `/bin`), `$TMPDIR` — a legit tool/worker needs these.
 *     They are never on this list.
 *   - macOS Keychain DBs (~/Library/Keychains) and browser cookie stores — these
 *     are encrypted-at-rest and outside ASRT's filesystem threat model; consciously
 *     excluded so a future reader knows they were not forgotten.
 *
 * PLATFORM: every entry is a LITERAL absolute path (NO glob chars). On macOS the
 * stripped path is a recursive seatbelt subpath; on Linux bwrap deny-binds the
 * literal path (bwrap cannot glob — ASRT only `expandGlobPattern`s entries that
 * CONTAIN glob chars, so literals are safe on both). On Windows, ASRT 0.0.76
 * applies filesystem rules through the srt-sandbox user ACL backend.
 *
 * NO-FALLBACK (deny-by-default): paths are derived from `os.homedir()` /
 * {@link aveHome} — host-trusted. A path that does not exist on disk is
 * harmless to list (ASRT denies it regardless; note: Linux bwrap silently
 * skips non-existent deny-bind paths, but this is still safe — a
 * non-existent dir cannot be read). There is deliberately NO "allow if not
 * found" branch.
 *
 * @param userDataDir  The REAL `app.getPath("userData")` from a trusted
 *   main-process caller (boot.ts). When provided, this EXACT path is denied
 *   and handles `--user-data-dir`, XDG_CONFIG_HOME, and future productName
 *   changes correctly. When absent, the path the sandbox was configured with
 *   is used, so a wrap restating this floor (plugin children, workers, bundled
 *   hooks, MCP stdio, the terminal) denies the same directory the shared
 *   config does; before configuration it falls back to a per-platform
 *   os.homedir()-derived path so there is always SOME coverage. Do NOT supply
 *   this from untrusted sources.
 * PLUS, on macOS and Linux, the two roots that hold every confined process's
 * private directories ({@link appOwnedSandboxPrivateRoots}): the per-principal
 * temp directories and the per-process sandbox HOMEs. They are read-denied
 * here, in the floor every wrap restates, because ASRT's reads are deny-only
 * and `0o700` stops no process of the same user — without the deny any
 * confined process could list them and read every other one's files. Each
 * wrap re-allows its OWN directory (`allowRead` is re-allowed inside a
 * covering deny). Not in the WRITE floor: a write deny takes precedence over
 * `allowWrite` and would take the process's own directory away. Windows keeps
 * its deny-only floor unchanged; its sandbox HOME is a per-process directory
 * under the host temp directory reached through ACL grants.
 *
 * @returns deduped, order-stable absolute paths to deny reads of.
 */
export function getDefaultSensitiveReadDenyPaths(userDataDir = _baseTrustedSettings?.userDataDir): string[] {
  return [...getDefaultSensitiveDenyPaths(userDataDir), ...appOwnedSandboxPrivateRoots()];
}

/**
 * Only builtin shell workloads receive primary saved-history read access.
 * Per-command read denies replace the shared runtime floor, so this projection
 * carries every other default deny as well as the grant's nested exclusions.
 */
export function getBuiltinShellSessionReadPolicy(userDataDir = _baseTrustedSettings?.userDataDir): {
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
} {
  const sessionPolicy = getConfiguredSessionReadPolicy();
  const sessionRoot = sessionPolicy.allowRead[0];
  const otherDenies = [
    ...getDefaultSensitiveDenyPaths(userDataDir, sessionRoot),
    ...(_baseTrustedSettings?.denyRead ?? []),
  ];
  // A session allowance must not carve into another protected namespace or a
  // trusted custom deny. The whole-HOME deny added by shell callers is separate.
  if (sessionRoot !== undefined && otherDenies.some((denied) => readDenyCoversPath(denied, sessionRoot))) {
    return Object.freeze({
      allowRead: Object.freeze([]),
      denyRead: Object.freeze([...getDefaultSensitiveReadDenyPaths(userDataDir), ...(_baseTrustedSettings?.denyRead ?? [])]),
    });
  }
  return Object.freeze({
    allowRead: sessionPolicy.allowRead,
    denyRead: Object.freeze([...otherDenies, ...sessionPolicy.denyRead]),
  });
}

/**
 * Compose invocation reads without duplicating a grant above the HOME deny.
 *
 * `sandboxHome` is the invocation's own sandbox HOME. The sandbox private
 * roots are read-denied like the rest of the floor, and a read grant under
 * them is dropped — a working directory there must not reopen another
 * process's HOME — except the invocation's own HOME and what is inside it.
 */
export function getBuiltinShellReadPolicy(
  readPaths: readonly string[],
  hostHome: string | undefined,
  sandboxHome?: string,
): {
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
  /** The saved-session grant, the one read the shell holds inside the floor. */
  readonly floorPierces: readonly string[];
} {
  const sessions = getBuiltinShellSessionReadPolicy();
  const privateRoots = appOwnedSandboxPrivateRoots();
  const ownHome = sandboxHome === undefined ? undefined : canonicalizePathForMatch(sandboxHome);
  const home = hostHome ? caseFoldForMatch(canonicalizePathForMatch(hostHome)) : undefined;
  const allowRead = [...readPaths, ...sessions.allowRead].filter((path) => {
    const resolved = canonicalizePathForMatch(path);
    // An explicit working directory must not reopen protected user data or a
    // custom deny when removing a broader ancestor changes native rule order.
    if (sessions.denyRead.some((denied) => readDenyCoversPath(denied, resolved))) return false;
    const insideOwnHome = ownHome !== undefined && (resolved === ownHome || resolved.startsWith(`${ownHome}/`));
    if (!insideOwnHome && privateRoots.some((root) => readDenyCoversPath(root, resolved))) return false;
    if (home === undefined) return true;
    const canonical = caseFoldForMatch(resolved);
    if (canonical === home) return true;
    const prefix = canonical.endsWith("/") ? canonical : `${canonical}/`;
    // Reads outside HOME are already allowed. An ancestor grant causes the
    // native runtime to re-emit the nested HOME deny after narrower grants,
    // hiding both the working tree and saved history. Keep only grants at or
    // below HOME, or unrelated to it; write grants are composed separately.
    return !home.startsWith(prefix);
  });
  return Object.freeze({
    allowRead: Object.freeze(allowRead),
    denyRead: Object.freeze([...sessions.denyRead, ...privateRoots, ...(hostHome ? [hostHome] : [])]),
    floorPierces: sessions.allowRead,
  });
}

/**
 * The protected read-deny floor every wrap is held to: the sensitive paths,
 * the exact user data directory the sandbox was configured with, and the
 * trusted custom denies. Two things restated with it are not part of it: a
 * shell's whole-HOME deny, and the sandbox private roots
 * ({@link appOwnedSandboxPrivateRoots}), under which every wrap is granted its
 * own temp directory and HOME by design.
 */
function getProtectedReadDenyPaths(
  userDataDir = _baseTrustedSettings?.userDataDir,
  customDenies = _baseTrustedSettings?.denyRead,
): readonly string[] {
  return [...getDefaultSensitiveDenyPaths(userDataDir), ...(customDenies ?? [])];
}

/**
 * The protected read deny covering `path`, if any. A plugin's chosen directory
 * is refused when one does: its read half would re-allow the deny on every
 * platform, and on Linux its write half would too.
 */
export function protectedReadDenyCovering(path: string, floor: readonly string[] = getProtectedReadDenyPaths()): string | undefined {
  const resolved = canonicalizePathForMatch(path);
  return floor.find((denied) => readDenyCoversPath(denied, resolved));
}

/**
 * Keep write roots from reopening reads the floor denies. Seatbelt keeps a
 * write grant write-only, but bubblewrap grants a write by binding the host
 * directory read-write over the deny's tmpfs mask, which exposes everything
 * under it. So on Linux a write root covered by the floor is not granted, for
 * every wrap: the user's shell, plugin children and workers, bundled hooks,
 * MCP stdio servers and the terminal all reach ASRT through
 * {@link buildPerCommandSandboxCustomConfig}, and the shared config through
 * {@link buildSandboxConfig}. macOS keeps the root, since the grant stays
 * write-only there. A shell's whole-HOME deny is not part of the floor:
 * working trees under HOME stay writable because they are read-granted too.
 */
function writeRootsOutsideReadDenies(roots: readonly string[], floor: readonly string[]): string[] {
  if (process.platform !== "linux") return [...roots];
  return withholdUnder(roots, floor, [], "write root");
}

/**
 * The only reads a wrap may ask to hold inside the floor: the configured
 * saved-session root and a host directory catalog row that pierces the floor.
 * Exact user hook files are checked separately when a wrap names its pierces.
 * A ceiling, not a grant — each wrap names its own in `floorPierces`.
 */
function floorPierceCeiling(): string[] {
  return [...getConfiguredSessionReadPolicy().allowRead, ...hostDirectoryFloorPierces()]
    .map((path) => canonicalizePathForMatch(path));
}

/** Only regular files physically beneath the hook directory can pierce its read floor. */
function isHookScriptRead(path: string): boolean {
  const canonical = resolve(canonicalizePathForMatch(path));
  const root = caseFoldForMatch(resolve(defaultHooksDir()));
  if (!caseFoldForMatch(canonical).startsWith(`${root}${sep}`)) return false;
  try {
    return lstatSync(canonical).isFile();
  } catch {
    return false;
  }
}

/**
 * An `allowRead` entry re-allows inside a covering deny on both platforms, so
 * one under the floor re-opens it. It is not granted unless it lies inside one
 * of this wrap's own `floorPierces`. A wrap's own temp directory and HOME sit
 * under the private roots, which are not floor. A pierce outside the ceiling
 * is a composer bug and fails the wrap.
 */
function readGrantsOutsideReadDenies(
  grants: readonly string[],
  floor: readonly string[],
  floorPierces: readonly string[],
): string[] {
  const ceiling = floorPierceCeiling();
  for (const pierce of floorPierces) {
    if (!ceiling.includes(canonicalizePathForMatch(pierce)) && !isHookScriptRead(pierce)) {
      throw new Error(`sandbox: ${pierce} is not a read the host lets re-open the protected floor`);
    }
  }
  return withholdUnder(grants, floor, floorPierces, "read grant");
}

function withholdUnder(
  paths: readonly string[],
  floor: readonly string[],
  pierces: readonly string[],
  kind: string,
): string[] {
  const canonicalPierces = pierces.map((pierce) => canonicalizePathForMatch(pierce));
  return paths.filter((path) => {
    const resolved = canonicalizePathForMatch(path);
    const denied = floor.find((deny) => readDenyCoversPath(deny, resolved));
    if (denied === undefined) return true;
    if (canonicalPierces.some((pierce) => resolved === pierce || resolved.startsWith(`${pierce}/`))) return true;
    // Withheld silently, a later EACCES/EROFS/ENOENT in the child would have no
    // visible cause.
    log.debug({ path, deny: denied }, `sandbox: ${kind} withheld under the protected read floor`);
    return false;
  });
}

/** Use the shared policy grammar; unrepresented runtime patterns keep the deny. */
function readDenyCoversPath(denied: string, canonicalPath: string): boolean {
  // Native patterns additionally support character classes and, on Windows,
  // environment references. Do not claim a safe carve-out from those forms.
  if (/[\[\]]/.test(denied) || (process.platform === "win32" && denied.includes("%"))) return true;
  const pattern = canonicalizePathForMatch(expandLeadingTilde(denied));
  for (let candidate = canonicalPath; ; candidate = dirname(candidate)) {
    if (globMatch(candidate, pattern) || globMatch(`${candidate}/`, pattern)) return true;
    if (dirname(candidate) === candidate) return false;
  }
}

function sensitiveDenyHomes(): string[] {
  return policyHomeAnchors();
}

function getDefaultSensitiveDenyPaths(userDataDir: string | undefined, readablePrimarySessionRoot?: string): string[] {
  const homes = sensitiveDenyHomes();
  const ave = aveHome();
  const aveHomes = [ave, ...homes.map((home) => join(home, ".ave"))];
  // Electron userData dir — exact path when provided by a trusted caller;
  // otherwise derived from each home and platform layout, without a
  // desktop runtime import — safe for any non-renderer context.
  // FIX 1 (security MINOR): Linux base honors XDG_CONFIG_HOME, mirroring
  // Electron's own resolution: `process.env.XDG_CONFIG_HOME || ~/.config`.
  const electronUserData = userDataDir !== undefined
    ? [process.platform === "win32" ? userDataDir.replace(/[/\\]+$/, "") + sep : userDataDir]
    : homes.map((home) =>
    (process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Ave")
      : process.platform === "win32"
        ? join(home, "AppData", "Roaming", "Ave") + sep
        : join(
            // Linux: mirror Electron's XDG_CONFIG_HOME resolution.
            process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
            "Ave",
          )));
  const raw = [
    // ── The sensitive-path table, projected to literal absolute paths ──
    // Projected from the single authority, SENSITIVE_PATH_ENTRIES in
    // src/permissions/sensitive-paths.ts, which the in-process host-tool guard
    // projects into globs. Do NOT hand-add a `join(home, …)` entry here — add a
    // row to that table and BOTH surfaces deny it.
    ...SENSITIVE_PATH_ENTRIES.flatMap((entry) => {
      let paths: string[];
      switch (entry.anchor) {
        case "ave-home":
          paths = aveHomes.map((home) => join(home, ...entry.segments));
          break;
        case "home":
          paths = homes.map((home) => join(home, ...entry.segments));
          break;
        case "root":
          // POSIX-rooted (`/etc/…`). Kept literal rather than `join`ed so the
          // string stays a seatbelt/bwrap subpath on the platforms that have
          // it; on win32 it names nothing and ASRT skips it (No-Fallback: a
          // path that does not exist is harmless to list).
          paths = ["/" + entry.segments.join("/")];
          break;
        default: {
          // Fail closed: an unrecognised anchor must not silently push
          // `undefined` into the deny list ASRT is configured from.
          const exhaustive: never = entry.anchor;
          throw new Error(
            `sensitive-path entry has an unknown anchor: ${String(exhaustive)}`,
          );
        }
      }
      // A missing directory leaf needs its separator to avoid a file placeholder.
      return paths.filter((path) => {
        if (readablePrimarySessionRoot === undefined || entry.anchor !== "ave-home" || entry.access !== "read-only") return true;
        return caseFoldForMatch(canonicalizePathForMatch(path)) !== caseFoldForMatch(readablePrimarySessionRoot);
      }).map((path) => process.platform === "win32" && entry.kind === "dir" ? path + sep : path);
    }),
    // Operator-selected external keys can live inside a granted workspace.
    // Keep the same frozen literal targets as the in-process host guard.
    ...getRuntimeSensitiveKeyPaths(),
    // ── Electron userData dir (whole dir — deny-by-default for future artefacts) ──
    // Contains plugin OAuth session cookies/tokens, Cookies (SQLite), Local/Session
    // Storage, Network Persistent State, Trust Tokens, ave-secrets.json.
    // Not a table row: the EXACT dir is only knowable at runtime from
    // `app.getPath("userData")`. The host guard pins the per-platform DEFAULT
    // locations as static globs in SENSITIVE_PATH_PATTERNS instead.
    ...electronUserData,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    // Lexical key: a link alias is a separate spelling the sandbox must deny.
    const key = caseFoldForMatch(resolve(p));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * The SINGLE SOURCE OF TRUTH for the host WRITE deny-floor — the paths a
 * sandboxed shell/tool must NEVER be able to WRITE, even when its write-jail
 * (`allowWrite`) is anchored somewhere that would otherwise cover them.
 *
 * ⚠️ WHY A WRITE FLOOR IS SEPARATE FROM THE READ FLOOR ⚠️
 * {@link getDefaultSensitiveReadDenyPaths} stops a sandboxed process from
 * READING secrets; it does NOT stop it WRITING. A shell that can write
 * `~/.zshrc` / `~/.ssh/authorized_keys` / a `~/Library/LaunchAgents` plist / a
 * `~/.config/autostart` entry gains code execution OUTSIDE the sandbox on the
 * next login/shell/agent run — a sandbox escape via persistence / re-exec. ASRT's
 * write model is allow-list + `denyWrite` precedence (macOS seatbelt
 * `(deny file-write* (subpath …))`, Linux bwrap deny-bind), so this floor is
 * passed as `filesystem.denyWrite` and TAKES PRECEDENCE over `allowWrite` — even
 * when the write-jail is the whole home the child still cannot touch these.
 *
 * The floor is the UNION of:
 *   1. every sensitive store, including read-only saved conversations; and
 *   2. write-persistence / re-exec vectors that are not secret-READ concerns:
 *      - POSIX shell startup files (sourced on the next interactive/login shell)
 *      - `~/.config` WHOLESALE (XDG autostart, systemd --user units, app config)
 *      - macOS per-user LaunchAgents (launchd runs the plist at login)
 *      - user crontab spool dirs + system cron drop-ins
 *
 * Unlike the read floor (which deliberately does NOT deny `~/.config` wholesale
 * so a build that READS `~/.config/…` still works), the WRITE floor CAN deny
 * `~/.config` wholesale: a sandboxed command has no legitimate need to WRITE
 * arbitrary autostart/app-config under the user's real home — its writes belong
 * in its own cwd / plugin sandbox root.
 *
 * PLATFORM: literal absolute paths (no globs) — same seatbelt-subpath / bwrap
 * deny-bind semantics as the read floor. Windows FS isolation is the srt-win acl
 * stamp path (see {@link initializeAsrtSandbox}); non-existent paths are harmless
 * to list (ASRT/bwrap skip them). No "allow if not found" branch (No-Fallback).
 *
 * The read half is the sensitive table's projection, NOT
 * {@link getDefaultSensitiveReadDenyPaths}: that one also denies the sandbox
 * private roots, which every confined process WRITES its own directory under.
 *
 * @param userDataDir  forwarded to the sensitive table's projection.
 * @returns deduped, order-stable absolute paths to deny writes of.
 */
export function getDefaultSensitiveWriteDenyPaths(userDataDir = _baseTrustedSettings?.userDataDir): string[] {
  const homes = sensitiveDenyHomes();
  const readDeny = getDefaultSensitiveDenyPaths(userDataDir);
  // Non-device default grants are removed at the runtime source, so no compensating cache denies are needed.
  const homeWritePersistence = homes.flatMap((home) => [
    // ── POSIX shell startup files — a write here re-executes on the next shell ──
    join(home, ".zshenv"),
    join(home, ".zprofile"),
    join(home, ".zshrc"),
    join(home, ".zlogin"),
    join(home, ".zlogout"),
    join(home, ".bash_profile"),
    join(home, ".bash_login"),
    join(home, ".bashrc"),
    join(home, ".bash_logout"),
    join(home, ".profile"),
    // ── XDG config root — autostart entries, systemd --user units, app config ──
    join(home, ".config") + (process.platform === "win32" ? sep : ""),
    // ── macOS per-user Launch Agents — launchd runs the plist at login ──
    join(home, "Library", "LaunchAgents") + (process.platform === "win32" ? sep : ""),
  ]);
  const writePersistence = [
    ...homeWritePersistence,
    // ── User crontab spool + system cron drop-ins (a crontab edit re-executes
    //    outside the sandbox) ──
    "/usr/lib/cron/tabs", // macOS user crontab spool
    "/var/spool/cron/crontabs", // Linux (Debian/Ubuntu) user crontab spool
    "/var/spool/cron", // Linux (RHEL/Fedora) user crontab spool
    "/etc/cron.d", // system cron drop-in dir
    // ── ASRT vendored srt-win backend dir (re-exec vector) ──
    // A sandboxed process must never be able to WRITE/overwrite the broker binary
    // it is itself spawned through. 0.0.67's explicit srt-win path closes the
    // IMPLICIT-resolution vector; denying WRITE to the vendored srt-win tree also
    // closes the PLANTED-binary vector (ASRT's own VENDORED_SRT_WIN_EXE doc warns
    // that in a dev checkout this exe can sit inside a write grant). Grandparent
    // of the exe → covers every arch subdir + build script. Inert off win32.
    dirname(dirname(getVendoredSrtWinExePath())),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...readDeny, ...writePersistence]) {
    // Lexical key: a link alias is a separate spelling the sandbox must deny.
    const key = caseFoldForMatch(resolve(p));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * Build a fully-resolved {@link SandboxRuntimeConfig} from TRUSTED settings.
 *
 * Deny-by-default: when no `allowedDomains` are supplied the network section
 * has an empty allow-list, which ASRT treats as "no egress". Weakening flags
 * default to `false`/absent and are only set when explicitly present in the
 * trusted `weakening` object.
 *
 * @internal Exported for unit tests only (the Windows-logic tests assert the
 * win32 `windows.proxyPortRange` emission with `process.platform` forced). Not
 * part of the module's runtime API — boot uses {@link initializeAsrtSandbox}.
 */
export function buildSandboxConfig(trustedSettings: TrustedSandboxSettings): SandboxRuntimeConfig {
  const network: NetworkConfig = {
    // Deny-by-default — empty allow-list ⇒ no network egress.
    allowedDomains: [...(trustedSettings.allowedDomains ?? [])],
    deniedDomains: [...(trustedSettings.deniedDomains ?? [])],
    ...(trustedSettings.strictAllowlist !== undefined
      ? { strictAllowlist: trustedSettings.strictAllowlist }
      : {}),
    // TRUSTED-ONLY weakening: only ever from trusted host/user settings.
    ...(trustedSettings.weakening?.allowAllUnixSockets !== undefined
      ? { allowAllUnixSockets: trustedSettings.weakening.allowAllUnixSockets }
      : {}),
    // macOS worker-UDS control-channel allow (the seatbelt `(subpath <dir>)`
    // rule). Host-allocated worker control-socket dirs only. Emitted whenever
    // present; ASRT ignores it off macOS. See the WORKER UDS header.
    ...(trustedSettings.allowUnixSocketDirs !== undefined &&
    trustedSettings.allowUnixSocketDirs.length > 0
      ? { allowUnixSockets: [...trustedSettings.allowUnixSocketDirs] }
      : {}),
    // parentProxy EXPLICIT. ASRT's
    // resolveParentProxy (dist/sandbox/parent-proxy.js:46) reads
    //   `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`.
    // An EMPTY object `{}` has no `http` key ⇒ `cfg?.http` is `undefined` ⇒ the
    // `??` chain STILL falls through to the host `process.env.HTTP_PROXY`
    // (identical to passing no parentProxy at all). Only an EXPLICIT EMPTY
    // STRING short-circuits the `??` chain (`'' ?? x` ⇒ `''`), yielding genuine
    // direct-connect with NO host-proxy chaining. So the secure floor is
    // `{ http: '', https: '' }`, NOT `{}`.
    //
    // We therefore always set http/https explicitly:
    //   - default (no trusted corporateProxy): empty strings ⇒ direct-connect,
    //     the secure floor — ASRT never inherits the ambient host proxy;
    //   - present: only the explicit, trusted corporate-proxy URLs are used.
    // `noProxy` carries no inheritance hazard (its only effect is to BYPASS the
    // proxy, never to add egress), so it is set only when explicitly supplied.
    parentProxy: {
      http: trustedSettings.corporateProxy?.http ?? "",
      https: trustedSettings.corporateProxy?.https ?? "",
      ...(trustedSettings.corporateProxy?.noProxy !== undefined
        ? { noProxy: trustedSettings.corporateProxy.noProxy }
        : {}),
    },
  };

  // denyRead floor: ALWAYS union the centralized host-secret / sensitive read
  // deny-list ({@link getDefaultSensitiveReadDenyPaths}) onto any caller-supplied
  // denyRead. This is the SHARED config's read deny — the floor ASRT applies when
  // a per-command wrap supplies NO `customConfig.filesystem.denyRead` of its own
  // (ASRT's wrapWithSandbox does `customConfig?.filesystem?.denyRead ??
  // config.filesystem.denyRead` — a per-command denyRead REPLACES this, it does
  // not union, so wraps that need this floor must restate it; see openWrapped in
  // mcp-client.ts). Deduped, order-stable (sensitive floor first, then caller's).
  const sensitiveDenyRead = getDefaultSensitiveReadDenyPaths(trustedSettings.userDataDir);
  const denyReadUnion: string[] = [];
  const denyReadSeen = new Set<string>();
  for (const p of [...sensitiveDenyRead, ...(trustedSettings.denyRead ?? [])]) {
    if (!denyReadSeen.has(p)) {
      denyReadSeen.add(p);
      denyReadUnion.push(p);
    }
  }
  // denyWrite floor: same boot-level belt as denyRead for callers that do not
  // supply per-command filesystem.denyWrite. Per-command wraps still restate
  // this SOT because ASRT's customConfig filesystem section replaces the shared
  // arrays, but the session config now has a real persistence-vector floor too.
  const sensitiveDenyWrite = getDefaultSensitiveWriteDenyPaths(trustedSettings.userDataDir);
  const denyWriteUnion: string[] = [];
  const denyWriteSeen = new Set<string>();
  for (const p of [...sensitiveDenyWrite, ...(trustedSettings.denyWrite ?? [])]) {
    if (!denyWriteSeen.has(p)) {
      denyWriteSeen.add(p);
      denyWriteUnion.push(p);
    }
  }
  const sharedFloor = getProtectedReadDenyPaths(trustedSettings.userDataDir, trustedSettings.denyRead);
  const filesystem: FilesystemConfig = {
    denyRead: asrtReadDenyPaths(denyReadUnion, appOwnedSandboxPrivateRoots()),
    allowWrite: writeRootsOutsideReadDenies(trustedSettings.allowWrite ?? [], sharedFloor),
    denyWrite: denyWriteUnion,
    ...(trustedSettings.allowRead !== undefined
      ? { allowRead: readGrantsOutsideReadDenies(trustedSettings.allowRead, sharedFloor, []) }
      : {}),
  };

  // Windows-only: pin the egress proxy bind range so it matches the WFP permit
  // (the install flow permits the SAME range — see DEFAULT_WINDOWS_PROXY_PORT_RANGE).
  // Always emitted on win32 (default range when not supplied) so the runtime
  // config and the WFP rule never desync. Inert on mac/linux — ASRT ignores the
  // `windows` section off Windows, but we only emit it on win32 to keep the
  // config minimal and the non-Windows config shape unchanged.
  const windows: WindowsConfig | undefined =
    process.platform === "win32"
      ? {
          proxyPortRange: [
            ...(trustedSettings.windows?.proxyPortRange ??
              DEFAULT_WINDOWS_PROXY_PORT_RANGE),
          ] as [number, number],
          // ASRT 0.0.76: srt-win path is REQUIRED — no implicit vendored
          // resolution. Supply the explicit SoT path so SandboxManager.initialize
          // (+ wrapWithSandboxArgv + the in-initialize dependency check) can spawn
          // the backend instead of throwing. See getVendoredSrtWinExePath.
          srtWin: { path: getVendoredSrtWinExePath() },
        }
      : undefined;
  // Linux-only: pin the helper bwrap execs to the one path each wrap is
  // granted (see getVendoredApplySeccompPath); ASRT's own search would find an
  // `app.asar` virtual path in a packaged build.
  const applySeccompPath = getVendoredApplySeccompPath();

  return {
    network,
    filesystem,
    ...(windows !== undefined ? { windows } : {}),
    ...(applySeccompPath !== undefined ? { seccomp: { applyPath: applySeccompPath } } : {}),
    ...(process.platform === "darwin" || process.platform === "linux"
      ? { javaAgentJarPath: getVendoredJavaProxyAgentJarPath() }
      : {}),
    // TRUSTED-ONLY weakening flags (see TrustedSandboxSettings trust-boundary
    // note). Only set when explicitly supplied by trusted settings.
    ...(trustedSettings.weakening?.allowAppleEvents !== undefined
      ? { allowAppleEvents: trustedSettings.weakening.allowAppleEvents }
      : {}),
    ...(trustedSettings.weakening?.enableWeakerNetworkIsolation !== undefined
      ? {
          enableWeakerNetworkIsolation:
            trustedSettings.weakening.enableWeakerNetworkIsolation,
        }
      : {}),
  };
}

/**
 * A fixed, no-I/O workload used only to prove that Linux can actually start the
 * configured ASRT/bwrap wrapper. ASRT 0.0.76's dependency check verifies
 * binaries, but cannot detect hosts that prohibit the wrapper's user namespace
 * / seccomp setup until a wrapped process starts.
 *
 * This command has no arguments, performs no writes, and makes no network
 * request. It is passed through the SAME initialized ASRT config that tools use
 * (no custom config), so a successful probe proves the real wrapper path rather
 * than merely the presence of `bwrap` on PATH.
 */
const ASRT_LINUX_RUNTIME_PROBE_COMMAND = "true";
const ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
// A SIGKILL request is not proof that bwrap has released its mount state. Give
// the child a short, bounded chance to emit `close` before ASRT cleanup/reset.
const ASRT_LINUX_RUNTIME_PROBE_CLOSE_GRACE_MS = 1_000;

/** Stable machine code for a Linux ASRT wrapper that cannot actually execute. */
export const ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE = "asrt-linux-runtime-probe-failed";

/**
 * Typed boot-time degradation signal for a Linux ASRT wrapper runtime failure.
 *
 * Boot catches this separately from generic initialization failures so audit
 * telemetry can distinguish a missing binary from a host policy that blocks the
 * configured bwrap/user-namespace/seccomp path. The message is deliberately
 * bounded and never includes child stdout/stderr or environment data.
 */
export class AsrtLinuxRuntimeProbeError extends Error {
  readonly code = ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE;

  constructor(detail: string) {
    super(`ASRT Linux runtime probe failed: ${detail}`);
    this.name = "AsrtLinuxRuntimeProbeError";
  }
}

export function isAsrtLinuxRuntimeProbeError(
  error: unknown,
): error is AsrtLinuxRuntimeProbeError {
  return error instanceof AsrtLinuxRuntimeProbeError;
}

/**
 * Spawn the exact argv returned by ASRT for the fixed runtime-probe command.
 * There is intentionally no host-shell/plain-spawn retry: the caller needs a
 * real ASRT execution or a typed boot degradation, never a false active state.
 */
function executeLinuxAsrtRuntimeProbe(
  wrapped: SandboxWrapResult,
  abortController: AbortController,
): Promise<void> {
  const [executable, ...args] = wrapped.argv;
  if (typeof executable !== "string" || executable.length === 0) {
    return Promise.reject(
      new AsrtLinuxRuntimeProbeError("configured ASRT wrapper returned no executable"),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutFailure: AsrtLinuxRuntimeProbeError | undefined;
    const finish = (error?: AsrtLinuxRuntimeProbeError) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (closeGraceTimeout !== undefined) clearTimeout(closeGraceTimeout);
      if (error !== undefined) reject(error);
      else resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Use ASRT's exact descriptor and shell:false. `true` is the only workload
      // here; this probe never falls back to a plain host shell command.
      child = spawn(executable, args, {
        cwd: process.cwd(),
        env: wrapped.env,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      finish(
        new AsrtLinuxRuntimeProbeError("configured ASRT wrapper could not be spawned"),
      );
      return;
    }

    child.once("error", () => {
      // Once SIGKILL has been requested, wait for `close` (or the bounded
      // grace) so cleanup cannot race bwrap's exit/mount teardown.
      if (timeoutFailure !== undefined) return;
      finish(
        new AsrtLinuxRuntimeProbeError("configured ASRT wrapper could not be spawned"),
      );
    });
    child.once("close", (code, signal) => {
      if (timeoutFailure !== undefined) {
        finish(timeoutFailure);
        return;
      }
      if (code === 0 && signal == null) {
        finish();
        return;
      }
      finish(
        new AsrtLinuxRuntimeProbeError(
          signal != null
            ? `configured ASRT wrapper terminated by ${signal}`
            : `configured ASRT wrapper exited with status ${code ?? "unknown"}`,
        ),
      );
    });
    timeout = setTimeout(() => {
      // Mark the timeout before kill so a synchronous `close` is still
      // classified as timeout, then wait for exit before cleanup/reset.
      timeoutFailure = new AsrtLinuxRuntimeProbeError(
        `configured ASRT wrapper timed out after ${ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS}ms`,
      );
      closeGraceTimeout = setTimeout(() => {
        // Do not wait forever for a broken ChildProcess implementation. The
        // probe remains failed; this merely bounds boot before best-effort
        // cleanup/reset runs.
        finish(timeoutFailure);
      }, ASRT_LINUX_RUNTIME_PROBE_CLOSE_GRACE_MS);
      abortController.abort();
      try {
        child.kill("SIGKILL");
      } catch {
        // The grace still bounds the failed probe before best-effort cleanup.
      }
    }, ASRT_LINUX_RUNTIME_PROBE_TIMEOUT_MS);
  });
}

/**
 * Linux-only post-initialize probe. ASRT's regular dependency check is
 * intentionally binary-only; this validates the exact live configuration's
 * bwrap invocation before the adapter exposes `active=true` to host tools.
 */
async function verifyLinuxAsrtRuntime(
  SandboxManager: Awaited<ReturnType<typeof loadSandboxManager>>,
): Promise<void> {
  if (process.platform !== "linux") return;

  const abortController = new AbortController();
  let wrapped = false;
  try {
    // No binShell/customConfig override: this is the exact initialized wrapper
    // configuration used by regular tool execution, with the fixed `true` probe.
    const probe = await SandboxManager.wrapWithSandboxArgv(
      ASRT_LINUX_RUNTIME_PROBE_COMMAND,
      undefined,
      undefined,
      abortController.signal,
      process.cwd(),
    );
    wrapped = true;
    await executeLinuxAsrtRuntimeProbe(hardenLinuxSandboxWrap(probe), abortController);
  } catch (error) {
    if (isAsrtLinuxRuntimeProbeError(error)) throw error;
    throw new AsrtLinuxRuntimeProbeError("configured ASRT wrapper could not be prepared");
  } finally {
    abortController.abort();
    if (wrapped) {
      try {
        // bwrap may leave mount-point artifacts even for this no-I/O command.
        SandboxManager.cleanupAfterCommand();
      } catch {
        // Cleanup failure means the configured runtime path is not healthy
        // enough to publish. The initialize caller resets the singleton before
        // surfacing this typed degradation.
        throw new AsrtLinuxRuntimeProbeError("configured ASRT wrapper cleanup failed");
      }
    }
  }
}

/**
 * Forget a just-initialized ASRT singleton after the runtime probe fails.
 * `active` is not set until after the probe, but the manager may already own
 * proxy/helper state; reset it best-effort without masking the typed failure.
 */
async function discardFailedAsrtInitialization(
  SandboxManager: Awaited<ReturnType<typeof loadSandboxManager>>,
): Promise<void> {
  active = false;
  _baseTrustedSettings = undefined;
  _workerUnixSocketDirs.clear();
  try {
    await SandboxManager.reset();
  } catch {
    // The caller must still receive the probe error and boot must remain
    // degraded; a reset failure cannot make the capability verified.
  }
}

/**
 * Initialize the ASRT {@link SandboxManager} singleton from TRUSTED settings.
 *
 * Builds the config from trusted settings (network `allowedDomains` is the
 * manifest UNION via {@link computeUnionAllowedDomains}; the WEAKENING flags
 * come from trusted host/user settings ONLY — see {@link TrustedSandboxSettings})
 * and calls `initialize`, which starts ASRT's proxy/helper machinery and
 * assigns the SHARED `config` that `filterNetworkRequest` enforces against.
 * Idempotent re-initialization is the caller's responsibility; prefer
 * {@link updateAsrtSandboxConfig} to change a live config.
 *
 * askCb SUPERSESSION (corrects WIRING-A #1356): the enforced model is GLOBAL
 * strict hard-deny — boot sets `strictAllowlist: true`. Under strict,
 * `filterNetworkRequest` NEVER calls the askCb (it hard-denies on any
 * out-of-union host: `if (!sandboxAskCallback || config.network.strictAllowlist)
 * return false`). The interactive host-tool askCb prompt added in WIRING-A is
 * therefore inert under strict and is NOT passed at boot anymore. `askCb` stays
 * an optional param only for a NON-strict configuration (not used by the
 * shipped enforced model); when `strictAllowlist` is true it is dead weight by
 * design.
 *
 * @param askCb  RESERVED FOR NON-STRICT; INERT UNDER STRICT. The shipped model
 *               always sets `strictAllowlist: true`, where ASRT bypasses the
 *               callback entirely (hard-deny). Kept so a future non-strict
 *               configuration has a hook; boot does not pass it. The wiring
 *               test passes a recording callback purely to PROVE strict never
 *               consults it.
 * @param enableLogMonitor  Forwarded to ASRT (violation log monitor). Default
 *                          off to avoid surprising background activity.
 */
export async function initializeAsrtSandbox(
  trustedSettings: TrustedSandboxSettings,
  askCb?: SandboxAskCallback,
  enableLogMonitor = false,
): Promise<void> {
  // Idempotency guard. The boot gate must decide exactly once;
  // a double-initialize means two boot paths raced or a runtime channel tried
  // to re-seal the sandbox with a different config. Fail loud rather than
  // silently overwriting the live config — use updateAsrtSandboxConfig to
  // change a live config.
  if (active) {
    throw new Error(
      "initializeAsrtSandbox: already active — refusing to re-initialize (use updateAsrtSandboxConfig to change a live config)",
    );
  }
  const SandboxManager = await loadSandboxManager();
  // Remember the base settings so worker-UDS register/unregister can rebuild
  // the SHARED config additively (see the WORKER UDS header). On a fresh init
  // there are no registered worker sockets yet, so the effective config equals
  // the base; withWorkerUnixSockets is a no-op until a worker registers.
  _baseTrustedSettings = trustedSettings;
  _workerUnixSocketDirs.clear();
  useAppOwnedSandboxTempRoot();
  const config = buildSandboxConfig(withWorkerUnixSockets(trustedSettings));
  await SandboxManager.initialize(config, askCb, enableLogMonitor);
  try {
    // Linux's ASRT dependency check only proves executables are installed. Run
    // the configured wrapper once before publishing the adapter as active so a
    // host that blocks user namespaces/seccomp cannot appear "verified".
    await verifyLinuxAsrtRuntime(SandboxManager);
  } catch (error) {
    await discardFailedAsrtInitialization(SandboxManager);
    throw error;
  }
  active = true;
}

/**
 * Check that the platform's sandbox dependencies are present:
 *   - Linux: bwrap + socat + ripgrep (via `SandboxManager.checkDependenciesAsync`);
 *   - Windows: the srt-win backend is spawnable + the WFP/sandbox-user state is
 *     usable, via ASRT's `checkWindowsDependenciesAsync` with the EXPLICIT
 *     srt-win path (0.0.67 no longer resolves it implicitly);
 *   - macOS: no external deps (Seatbelt is built in).
 *
 * Returns ASRT's `{ errors, warnings }` — a non-empty `errors` means the sandbox
 * CANNOT run on this host. Boot uses this to fail-closed (refuse to run
 * unsandboxed) when the gate is ON but the deps are missing, rather than silently
 * downgrading to isolation=none.
 *
 * Adopts the ASYNC dependency twins (`checkDependenciesAsync` /
 * `checkWindowsDependenciesAsync`) so the boot gate never blocks the event loop
 * on the underlying srt-win / binary probes.
 */
export async function checkAsrtDependencies(): Promise<{
  errors: string[];
  warnings: string[];
}> {
  if (process.platform === "win32") {
    const mod = await import("@anthropic-ai/sandbox-runtime");
    return mod.checkWindowsDependenciesAsync({
      srtWin: mod.resolveSrtWin({ path: getVendoredSrtWinExePath() }),
    });
  }
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.checkDependenciesAsync();
}

/**
 * Wrap a TOOL command for sandboxed execution, returning the `{ argv, env }`
 * the host must spawn. Uses `wrapWithSandboxArgv` (the cross-platform form;
 * unlike `wrapWithSandbox` it does not throw on Windows).
 */
export async function wrapToolCommand(
  command: string,
  options: WrapOptions = {},
): Promise<SandboxWrapResult> {
  // Self-enforcing gate. Do not depend on the caller to check
  // isAsrtSandboxActive() first — a wrap with no initialized SandboxManager is
  // a bug, so throw rather than silently wrapping against an uninitialized
  // singleton.
  if (!isAsrtSandboxActive()) {
    throw new Error("wrapToolCommand: ASRT sandbox is not active (initialize at boot first)");
  }
  // A wrapped command is a confined process that may write a plugin tree.
  noteConfinedProcessesMayRun();
  // Publish before wrapping: the runtime sets TMPDIR inside the command,
  // ahead of any environment the spawning caller supplies. Idempotent.
  useAppOwnedSandboxTempRoot();
  assertPerExecFilesystemSupported(options.filesystem, "wrapToolCommand");
  const SandboxManager = await loadSandboxManager();
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    options.binShell,
    buildPerCommandSandboxCustomConfig(options.filesystem),
    options.abortSignal,
  );
  return applyLinuxReadMaskWriteFloor(wrapped, options.filesystem, () => SandboxManager.cleanupAfterCommand());
}


/**
 * The host-owned root used for the runtime's inline TMPDIR assignment.
 * Non-device write roots come only from caller policy; setting TMPDIR alone
 * grants no access. Confined principals receive their own directory below this
 * root, with the root read-denied and only their own directory granted.
 */
export function appOwnedSandboxTempRoot(): string {
  return join(sandboxPrivateBase(), "tmp");
}

/**
 * The directory the sandbox private roots live in: `<AVE_HOME>/sandbox`.
 *
 * Under the test runner with no `AVE_HOME` of its own, it is the per-run
 * directory `vitest.globalSetup.ts` makes instead. These roots hold every
 * confined process's HOME and temp directory, and the boot sweep empties them,
 * so a test resolving them to the developer's real `~/.ave` would put its
 * directories where a running app's boot deletes them — and a test that swept
 * would delete the running app's. A test process without that directory is
 * refused rather than defaulted to the real one. The app's seam answers
 * nothing (`ave-home-test-guard.ts`); only the test runner's guard does.
 */
function sandboxPrivateBase(): string {
  return testSandboxPrivateBase() ?? join(aveHome(), "sandbox");
}

/**
 * Where every confined process's throwaway sandbox HOME is created on macOS
 * and Linux (`sandbox-process-home.ts`), one `mkdtemp` directory each.
 *
 * App-owned, beside the temp root, rather than under the host's temp
 * directory: there, nothing denied reading it, so any confined process could
 * list the host temp directory and read another one's HOME. Under this root
 * the read floor denies it ({@link getDefaultSensitiveReadDenyPaths}) and each
 * wrap re-allows its own HOME alone.
 */
export function appOwnedSandboxHomeRoot(): string {
  return join(sandboxPrivateBase(), "home");
}

/**
 * Where the workspace terminal hands its sandboxed shell command to the
 * trampoline it spawned on the pty (`terminal-tty-handoff.ts`): one `mkdtemp`
 * directory with one fifo per spawn. The host alone writes here. No wrap
 * grants it, so no confined process can write the fifo (which the trampoline
 * runs unsandboxed), and the read floor denies it, so none can read the
 * command and environment out of it either.
 */
export function appOwnedTerminalHandoffRoot(): string {
  return join(sandboxPrivateBase(), "handoff");
}

/**
 * The roots of the confined processes' private directories, read-denied by
 * the floor on macOS and Linux. Empty on Windows, whose floor is unchanged.
 */
export function appOwnedSandboxPrivateRoots(): string[] {
  if (process.platform === "win32") return [];
  return [appOwnedSandboxTempRoot(), appOwnedSandboxHomeRoot(), appOwnedTerminalHandoffRoot()];
}

/**
 * Create a sandbox private root `0o700` if it is absent, and refuse one that is
 * not a real directory. Its ancestors may be links (`AVE_HOME` may be one);
 * the root itself is the host's, and every directory a wrap grants is made
 * inside it, so a link here would put them somewhere the read floor does not
 * name.
 */
export function ensureSandboxPrivateRoot(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entry = lstatSync(root);
  if (!entry.isDirectory()) {
    throw new Error(`sandbox: ${root} is not a directory the host created; refusing to create sandbox directories in it`);
  }
  return root;
}

let appOwnedTempRootReady = false;

/**
 * Whose temp directory a confined process gets: a plugin, covering its child,
 * its workers and its bundled hooks, one MCP stdio server, or a user command hook.
 */
export interface SandboxTempPrincipal {
  readonly kind: "plugin" | "mcp" | "hook";
  readonly id: string;
}

const SANDBOX_TEMP_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(["plugin", "mcp", "hook"]);

/**
 * The longest id, in UTF-8 bytes, that names a temp directory. Its hex form
 * after the longest kind prefix stays under the 255-byte name limit every
 * supported filesystem has.
 */
const MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES = 120;

/**
 * The directory name a principal's temp directory has under the shared root:
 * `<kind>-<hex of the id's UTF-8 bytes>`. Lowercase hex is one spelling per id
 * on case-insensitive and case-sensitive filesystems alike, carries no
 * separator, dot or link-like segment whatever the id holds (an agent plugin's
 * id contains `/`), and the kind prefix keeps a plugin and an MCP server with
 * the same id apart. An id that is empty, longer than
 * {@link MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES}, or not well-formed text (whose
 * UTF-8 bytes would be shared with another id's) is refused.
 */
export function sandboxTempPrincipalDirName(principal: SandboxTempPrincipal): string {
  if (!SANDBOX_TEMP_PRINCIPAL_KINDS.has(principal.kind)) {
    throw new Error(`sandbox temp: unknown principal kind ${JSON.stringify(principal.kind)}`);
  }
  const bytes = Buffer.from(principal.id, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES || bytes.toString("utf8") !== principal.id) {
    throw new Error(
      `sandbox temp: ${principal.kind} id ${JSON.stringify(principal.id)} cannot name a temp directory `
        + `(empty, longer than ${MAX_SANDBOX_TEMP_PRINCIPAL_ID_BYTES} UTF-8 bytes, or not well-formed text)`,
    );
  }
  return `${principal.kind}-${bytes.toString("hex")}`;
}

const createdSandboxTempPrincipalDirs = new Set<string>();

/**
 * The principal temp directories this process has handed to a wrap. The boot
 * sweep keeps them: a directory a process started during this boot is using is
 * never removed, whatever order boot and the first wrap run in.
 */
export function sandboxTempPrincipalDirsInUse(): ReadonlySet<string> {
  return createdSandboxTempPrincipalDirs;
}

/**
 * Create (or take back) a principal's temp directory and return it with the
 * root it sits in.
 *
 * A wrap that uses it grants read and write on `dir` alone, sets
 * `TMPDIR`/`TMP`/`TEMP` to it inside the wrap ({@link sandboxTempEnvLaunch});
 * the read floor denies `root` ({@link getDefaultSensitiveReadDenyPaths}).
 * ASRT reads are deny-only, so without that deny
 * every confined process could list the root and read every other
 * principal's files in it; the deny is what makes the directory private, and
 * `0o700` adds nothing against a process of the same user.
 *
 * The directory must be a real directory: a link here is refused, never
 * followed. Nothing confined can write the root, so nothing confined can put
 * one there; one left by a version that still granted the root is removed by
 * the boot sweep before any wrap.
 */
export function ensureSandboxTempPrincipalDir(principal: SandboxTempPrincipal): { readonly dir: string; readonly root: string } {
  const root = ensureSandboxPrivateRoot(appOwnedSandboxTempRoot());
  const dir = join(root, sandboxTempPrincipalDirName(principal));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(dir);
  if (!entry.isDirectory()) {
    throw new Error(`sandbox temp: ${dir} is not a directory the host created; refusing to grant it`);
  }
  // A principal may have narrowed its own directory's mode; the host decides it.
  if ((entry.mode & 0o7777) !== 0o700) chmodSync(dir, 0o700);
  createdSandboxTempPrincipalDirs.add(dir);
  return { dir, root };
}

/**
 * The launcher that sets a principal's temp directory: `/usr/bin/env
 * TMPDIR=<dir> TMP=<dir> TEMP=<dir> <command> <args>`, run INSIDE the wrap.
 * ASRT writes its own `TMPDIR=` (from `CLAUDE_CODE_TMPDIR`) ahead of the
 * sandboxed command on both platforms — `env` arguments on macOS, a bwrap
 * `--setenv` on Linux — so a value in the spawn environment never reaches the
 * child; one assigned by a process already inside the sandbox does.
 *
 * `env` reads an operand containing `=` as an assignment, so a command with
 * one would be split rather than run; it is refused.
 */
export function sandboxTempEnvLaunch(
  dir: string,
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: string[] } {
  if (command.includes("=")) {
    throw new Error(
      `sandbox temp: the command '${command}' contains '=', which env(1) would read as an assignment; `
        + "move it to a path without '='",
    );
  }
  return {
    command: SANDBOX_TEMP_ENV_LAUNCHER,
    args: [`TMPDIR=${dir}`, `TMP=${dir}`, `TEMP=${dir}`, command, ...args],
  };
}

/** `env(1)`, never a `PATH` lookup: both platforms that wrap ship it here. */
const SANDBOX_TEMP_ENV_LAUNCHER = "/usr/bin/env";


export function useAppOwnedSandboxTempRoot(): string {
  const root = appOwnedSandboxTempRoot();
  if (appOwnedTempRootReady) return root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The current name and the one ASRT keeps for compatibility. Both, because
  // reading which one a given ASRT version prefers is a fact that can change
  // under us, and disagreeing with ourselves would put the child somewhere
  // neither we nor the reader expects.
  process.env.CLAUDE_CODE_TMPDIR = root;
  process.env.CLAUDE_TMPDIR = root;
  appOwnedTempRootReady = true;
  return root;
}

/**
 * Wrap a WORKER command (the long-lived plugin worker — MCP/python — that
 * actually performs runtime network egress) for sandboxed execution, returning
 * the `{ argv, env }` the host must spawn. Same wrapping primitive as
 * {@link wrapToolCommand}: the per-command channel carries ONLY the filesystem
 * jail (scoped to the worker's plugin sandbox root + needed dirs).
 *
 * Caller: `StdioTransport.openWrapped` in `mcp-client.ts`
 * wraps every external MCP stdio worker when {@link isAsrtSandboxActive}. The
 * Python SETUP spawns (`python-runtime.ts` `runUv`/`runPython`) are NOT
 * wrapped — they run at boot before the gate is active and legitimately need
 * PyPI egress, so they plain-spawn.
 *
 * EGRESS: workers do NOT carry a per-command egress override — the
 * `allowedDomains`/`deniedDomains` channel is INERT per command
 * (`filterNetworkRequest` reads the SHARED config, not `customConfig`; see the
 * module header). Worker egress is ENFORCED by the shared config set at boot:
 * `strictAllowlist: true` + the UNION of every loaded plugin's manifest
 * allow-list. Workers are NON-INTERACTIVE; strict hard-denies any out-of-union
 * host with no askCb fallthrough. The owning plugin's declared domains reach
 * the worker only by being part of that union.
 *
 * UDS CONTROL CHANNEL: a worker the HOST connects INBOUND to (an HTTP worker)
 * needs a Unix-domain-socket control channel — loopback TCP is unreachable
 * through Linux's bwrap `--unshare-net` namespace. The per-command channel
 * here ONLY carries the filesystem jail, whose `allowWrite` includes the
 * worker's host-allocated socketDir → that becomes the Linux `--bind <dir>
 * <dir>` mount (host-visible from both namespaces) and, on macOS, the writable
 * region where the socket file may be created. The Unix-socket ALLOW config
 * (macOS `allowUnixSockets` / Linux `allowAllUnixSockets`) is INERT per-command
 * in current ASRT — it MUST live on the SHARED config and is managed by
 * {@link registerWorkerUnixSocketDir} (see the WORKER UDS header). The
 * {@link spawnWorker} primitive (worker-spawn.ts) drives both: it registers the
 * socketDir on the shared config, then wraps with the FS jail here.
 */
export async function wrapWorkerCommand(
  command: string,
  options: WrapOptions = {},
): Promise<SandboxWrapResult> {
  return wrapLongLivedCommand("wrapWorkerCommand", command, options, undefined);
}

/**
 * Wrap the workspace terminal's login shell. The same wrap as
 * {@link wrapWorkerCommand}, plus ONE terminal grant: macOS `file-ioctl` on
 * `ownTty`, the pty slave the shell is spawned on, and on no other terminal.
 * Without it the shell cannot turn off echo or take the terminal for a
 * foreground job (every command is printed twice, job control is off), and
 * ASRT's only other grant, `allowPty: true`, covers every `/dev/ttys*` of the
 * user. ASRT refuses an `ownTty` that is not `/dev/ttys` + 3 or more digits.
 *
 * Only the terminal passes a tty: tool and worker wraps never get one.
 */
export async function wrapTerminalCommand(
  command: string,
  options: WrapOptions & { readonly ownTty: string },
): Promise<SandboxWrapResult> {
  return wrapLongLivedCommand("wrapTerminalCommand", command, options, { ttys: [options.ownTty] });
}

async function wrapLongLivedCommand(
  caller: string,
  command: string,
  options: WrapOptions,
  wrapOptions: { readonly ttys: readonly string[] } | undefined,
): Promise<SandboxWrapResult> {
  // Self-enforcing gate — same rationale as wrapToolCommand.
  if (!isAsrtSandboxActive()) {
    throw new Error(`${caller}: ASRT sandbox is not active (initialize at boot first)`);
  }
  noteConfinedProcessesMayRun();
  // Publish before wrapping: the runtime sets TMPDIR inside the command,
  // ahead of any environment the spawning caller supplies. Idempotent.
  useAppOwnedSandboxTempRoot();
  assertPerExecFilesystemSupported(options.filesystem, caller);
  const SandboxManager = await loadSandboxManager();
  // `wrapOptions` is undefined for every wrap but the terminal's.
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    options.binShell,
    buildPerCommandSandboxCustomConfig(options.filesystem),
    options.abortSignal,
    undefined,
    wrapOptions,
  );
  return applyLinuxReadMaskWriteFloor(wrapped, options.filesystem, () => SandboxManager.cleanupAfterCommand());
}

/**
 * Compute the SHARED, enforced egress allow-list as the UNION of every loaded,
 * host-validated plugin manifest's `networkAccess.allowedDomains` plus an
 * optional TRUSTED host baseline (default empty). Deduped, order-stable.
 *
 * This is the trusted seam for the network enforcement model: the host
 * validated these manifests at install, so the union is a trusted input to the
 * SHARED ASRT config (set via {@link initializeAsrtSandbox} /
 * {@link updateAsrtSandboxConfig}). Because ASRT's `filterNetworkRequest` reads
 * that shared config, the union is genuinely enforced for BOTH workers and host
 * tools under `strictAllowlist: true`.
 *
 * TRADE-OFF: this is a union, NOT per-worker isolation — see the module header.
 *
 * @param manifestAllowLists  one entry per loaded plugin: its
 *                            `manifest.networkAccess.allowedDomains` (or `[]`).
 * @param trustedBaseline     optional trusted host-settings allow-list for host
 *                            tools; defaults to empty (no baseline egress).
 */
export function computeUnionAllowedDomains(
  manifestAllowLists: readonly (readonly string[])[],
  trustedBaseline: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const domain of trustedBaseline) {
    if (typeof domain === "string" && domain.length > 0 && !seen.has(domain)) {
      seen.add(domain);
      union.push(domain);
    }
  }
  for (const list of manifestAllowLists) {
    for (const domain of list) {
      if (typeof domain === "string" && domain.length > 0 && !seen.has(domain)) {
        seen.add(domain);
        union.push(domain);
      }
    }
  }
  return union;
}

/**
 * Align an allow-list with ASRT's domain-matching semantics so it enforces the
 * SAME hosts Ave's host-fetch allow-list does.
 *
 * SEMANTICS DIVERGENCE: ASRT's `matchesDomainPattern`
 * (dist/sandbox/domain-pattern.js:23) matches a BARE `example.com` EXACTLY —
 * `h === pattern` — so `sub.example.com` is NOT covered; a strict subdomain
 * needs the explicit `*.example.com` pattern (`h.endsWith('.' + base)`). Ave's
 * own `urlHostMatchesAllowList` (host-allow-list.ts) instead treats a bare
 * `example.com` as a DOT-BOUNDARY SUFFIX — it allows `sub.example.com` too.
 * Passing the manifest union RAW would therefore enforce a STRICTER set under
 * ASRT than the host fetch path advertises (a plugin that declared
 * `example.com` and reaches `api.example.com` via hostFetch would be silently
 * hard-denied by the sandbox).
 *
 * Normalization: for each BARE domain `d` we emit BOTH `d` (the apex, exact
 * match) AND `*.d` (every strict subdomain) so ASRT's two matcher branches
 * together reproduce Ave's dot-boundary suffix match. Entries already in
 * wildcard form (`*.d`) pass through unchanged; the deny-all `*` (only valid in
 * deniedDomains) and empty entries are dropped. Deduped, order-stable (apex
 * before its wildcard).
 */
export function normalizeUnionForAsrt(
  domains: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  };
  for (const raw of domains) {
    if (typeof raw !== "string") continue;
    const d = raw.trim().toLowerCase();
    if (d.length === 0 || d === "*") continue;
    if (d.startsWith("*.")) {
      // Already a wildcard — pass through (no apex implied by a bare `*.d`).
      add(d);
      continue;
    }
    // Bare domain: emit apex + every strict subdomain to mirror Ave's
    // dot-boundary suffix match against ASRT's exact/`*.` two-branch matcher.
    add(d);
    add(`*.${d}`);
  }
  return out;
}

/**
 * The TRUSTED host-settings slice {@link computeDynamicEndpointHosts} reads.
 * Intentionally a structural subset of `AppSettings` (not an import of it) so
 * the function is pure, unit-testable in isolation, and tolerant of partial
 * settings shapes (test doubles, pre-migration files). Only the LLM vendor
 * blocks' user-configured `baseUrl`s are consulted — the dynamic endpoints a
 * sandboxed worker actually reaches.
 */
export interface DynamicEndpointSettings {
  readonly llm?: {
    readonly vendors?: Record<string, { readonly baseUrl?: string } | undefined>;
    /**
     * The active marketplace provider preset. Its endpoint is NOT stored in
     * `vendors["openai-compatible"]` — that block is the generic custom
     * provider's own — so without this the host chat is actually talking to
     * would be missing from the union and hard-denied.
     */
    readonly marketplaceProviderPresetId?: string;
  };
  readonly marketplace?: {
    readonly installedProviderPresets?:
      | readonly { readonly providerId: string; readonly baseUrl?: string }[]
      | undefined;
  };
}

/**
 * Extract the host-resolved DYNAMIC endpoint HOSTNAMES from TRUSTED settings, so
 * the shared strict-union allow-list reflects not just static manifest domains
 * but ALSO the user-configured endpoints a sandboxed worker actually reaches.
 *
 * WHY THIS EXISTS — the union gap this closes:
 * The boot union is built from each loaded plugin's
 * `manifest.networkAccess.allowedDomains`. But some plugins' REAL egress host is
 * NOT a static manifest domain — it is USER-CONFIGURED. The concrete case:
 * local-indexer's embedding + image-caption calls go to the host's Azure OpenAI
 * resource, resolved host-side as `settings.llm.vendors["azure-foundry"].baseUrl`
 * (the same value `hostApi.resolveApiKey({ vendor: "azure-openai" })` returns —
 * see main/host-api/resolve-api-key.ts, where "azure-openai" maps to
 * "azure-foundry"). The indexer's manifest `networkAccess` is null, so it
 * contributes NOTHING to the static union — its endpoint would be hard-denied
 * under strict enforcement. The host-resolved endpoint string is the DYNAMIC
 * source of truth that must feed the union. A user-set custom `baseUrl` on ANY
 * vendor block is treated the same way (a custom endpoint a worker would reuse).
 *
 * DYNAMIC SOURCE: every endpoint {@link llmRouteBaseUrls} reports — each
 * `llm.vendors[*].baseUrl` in trusted settings, PLUS the active marketplace
 * provider preset's address, which lives in the preset registry rather than in
 * a vendor block. These are the only places the host holds a
 * configured-endpoint URL string that a worker would reach; there is no
 * separate host-side embedding/caption endpoint setting (the indexer resolves
 * both through the same Azure resource baseUrl).
 *
 * NO-FALLBACK (deny-by-default): each URL is reduced to `new URL(s).hostname`.
 * A malformed/empty/whitespace `baseUrl` (or a parse that yields no hostname)
 * contributes NOTHING — it is NOT a wildcard and NOT an "allow all" fallback. A
 * missing endpoint simply isn't in the union, so strict enforcement hard-denies
 * it and the plugin surfaces its own "endpoint not configured" error. Deduped,
 * order-stable.
 *
 * RESOLVED-ADDRESS CHECK: being on this list admits a NAME, not whatever it
 * resolves to. ASRT 0.0.76 resolves an allow-listed hostname once at dial time
 * and refuses it when every answer is loopback, unspecified, link-local,
 * multicast, a cloud-metadata endpoint, or an address on one of this host's own
 * interfaces. `localhost` / `*.localhost` may still reach loopback, an IP
 * literal entry is never re-judged, and private ranges (RFC 1918, ULA) stay
 * reachable because Ave sets no `network.deniedResolvedAddresses`. So a user
 * endpoint that names THIS machine by any other hostname (a `.local` mDNS name,
 * a hosts-file alias for 127.0.0.1) is refused inside the sandbox with
 * "resolved to denied address"; write it as `localhost` or as the IP literal.
 * The check is skipped for traffic ASRT hands to an upstream `parentProxy`.
 *
 * @param settings  TRUSTED host/user settings (or a structural subset). Never a
 *                  plugin/project/MCP-influenced surface — these hosts widen the
 *                  enforced allow-list, so they must originate from trusted
 *                  settings only (same trust seam as the manifest union).
 * @returns bare hostnames (e.g. `my-resource.openai.azure.com`), ready to feed
 *          {@link computeUnionAllowedDomains} alongside the manifest allow-lists
 *          (then {@link normalizeUnionForAsrt} for ASRT's matcher).
 */
export function computeDynamicEndpointHosts(
  settings: DynamicEndpointSettings | undefined,
): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  const baseUrls = llmRouteBaseUrls({
    vendors: settings?.llm?.vendors,
    marketplaceProviderPresetId: settings?.llm?.marketplaceProviderPresetId,
    installedProviderPresets: settings?.marketplace?.installedProviderPresets,
  });
  for (const trimmed of baseUrls) {
    let hostname: string;
    try {
      // Strip trailing dot from FQDN-style URLs (e.g. `res.openai.azure.com.`)
      // so they normalize to the bare hostname the ASRT matcher expects.
      hostname = new URL(trimmed).hostname.replace(/\.$/, "");
    } catch {
      // Malformed endpoint — NOT a wildcard, NOT an allow-all fallback. It
      // simply contributes no host (deny-by-default per the no-fallback rule).
      continue;
    }
    const host = hostname.trim().toLowerCase();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

/**
 * Replace the live ASRT config (TRUSTED settings only). Pass-through to
 * `SandboxManager.updateConfig`. Remembers these as the new base settings so a
 * subsequent worker-UDS register/unregister rebuilds additively, and re-applies
 * the CURRENTLY-registered worker UDS dirs onto the new base (a live config
 * refresh must not drop a running worker's control-socket allowance).
 */
export async function updateAsrtSandboxConfig(
  trustedSettings: TrustedSandboxSettings,
): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  _baseTrustedSettings = trustedSettings;
  SandboxManager.updateConfig(
    buildSandboxConfig(withWorkerUnixSockets(trustedSettings)),
  );
}

/**
 * Register a host-allocated worker control-socket DIRECTORY for UDS access and
 * push the rebuilt SHARED config (worker-confinement PR D-1). The per-command
 * `customConfig.network.allowUnixSockets` is INERT in current ASRT (see the
 * WORKER UDS header), so the allowance MUST live on the shared config — this is
 * the additive mutator {@link spawnWorker} calls right before it spawns a
 * wrapped HTTP worker.
 *
 * macOS: adds the dir to `network.allowUnixSockets` (the seatbelt `(subpath
 * <dir>)` allow — the dir, NOT the socket file, which gives EPERM). Linux: the
 * dir is path-ignored by seccomp; its presence forces the trusted
 * `allowAllUnixSockets` weakening on (the `--bind` of the writable dir scopes
 * WHERE). A directory another holder already registered only gains a holder;
 * the config is pushed when the first one arrives.
 *
 * TRUSTED-ONLY: `socketDir` must be a host-allocated path (a plugin sandbox-root
 * subtree), never a plugin/manifest/MCP-supplied value.
 */
export async function registerWorkerUnixSocketDir(socketDir: string, holder: object): Promise<void> {
  if (!active || _baseTrustedSettings === undefined) {
    throw new Error(
      "registerWorkerUnixSocketDir: ASRT sandbox is not active (initialize at boot first)",
    );
  }
  const existing = _workerUnixSocketDirs.get(socketDir);
  if (existing !== undefined) {
    // A later holder resolves only once the FIRST holder's push has landed: it
    // is about to wrap a child, and a wrap generated before the push would
    // carry no allow. If that push fails, the whole entry is rolled back and
    // every waiter fails with it, so no caller believes it holds a dir that
    // was never pushed.
    existing.holders.add(holder);
    await existing.pushed;
    if (!existing.holders.has(holder) || _workerUnixSocketDirs.get(socketDir) !== existing) {
      throw new Error("Socket directory registration was released before acquisition completed");
    }
    return;
  }
  let resolvePushed!: () => void;
  let rejectPushed!: (error: unknown) => void;
  const pushed = new Promise<void>((resolvePush, rejectPush) => {
    resolvePushed = resolvePush;
    rejectPushed = rejectPush;
  });
  // Observed here so a failed push with no waiter is not an unhandled rejection.
  pushed.catch(() => undefined);
  const entry: WorkerUnixSocketDirEntry = { holders: new Set([holder]), registered: false, pushed };
  _workerUnixSocketDirs.set(socketDir, entry);
  try {
    const SandboxManager = await loadSandboxManager();
    if (_workerUnixSocketDirs.get(socketDir) !== entry || !active || _baseTrustedSettings === undefined) {
      throw new Error("Socket directory registration was released before acquisition completed");
    }
    // Other pending dirs belong to their own push. Including them here could
    // retain an allowance after that dir's push fails and its holders reject.
    SandboxManager.updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings, socketDir)));
    entry.registered = true;
  } catch (error) {
    // Every holder of this entry — this caller and any waiter — sees the
    // throw, treats the dir as not registered, and will not release it.
    if (_workerUnixSocketDirs.get(socketDir) === entry) _workerUnixSocketDirs.delete(socketDir);
    rejectPushed(error);
    throw error;
  }
  resolvePushed();
  if (!entry.holders.has(holder)) {
    throw new Error("Socket directory registration was released before acquisition completed");
  }
}

/**
 * Release one holder of a socket dir's UDS allowance; the last release drops it
 * and pushes the rebuilt SHARED config. Unknown dirs are a no-op. Called by
 * {@link spawnWorker} on worker exit/stop and by a plugin child's teardown, so
 * a dead holder's allowance does not linger and a live one's is not dropped.
 */
export async function unregisterWorkerUnixSocketDir(socketDir: string, holder: object): Promise<void> {
  const entry = _workerUnixSocketDirs.get(socketDir);
  if (entry === undefined || !entry.holders.delete(holder)) return;
  if (entry.holders.size > 0) return;
  _workerUnixSocketDirs.delete(socketDir);
  // If the sandbox was already torn down, there is nothing to update — the
  // reset cleared the live config and the worker set; this is a no-op.
  if (!active || _baseTrustedSettings === undefined) return;
  const SandboxManager = await loadSandboxManager();
  if (!active || _baseTrustedSettings === undefined) return;
  SandboxManager.updateConfig(
    buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings)),
  );
}

/**
 * Apply a Windows-only, worker-lifetime filesystem grant under a dedicated
 * holder PID. ASRT 0.0.76 cannot carry per-exec allowRead/allowWrite through
 * `wrapWithSandboxArgv()`, and `updateConfig()` explicitly does not apply
 * Windows filesystem changes live. The supported live primitive is therefore
 * srt-win's refcounted ACL grant/revoke path, keyed by a holder PID that the
 * caller owns for exactly one worker.
 *
 * ASRT 0.0.76: every srt-win-backed helper (status query, grant, revoke) takes
 * an EXPLICIT `srtWin` spawn descriptor — there is no implicit vendored fallback.
 * We resolve it ONCE here (from the SoT {@link getVendoredSrtWinExePath}) and
 * thread it through the status probe, the grant, and BOTH revoke paths (the
 * grant-failure rollback and the returned release() closure).
 */
export async function grantWindowsWorkerFilesystemAccess(opts: {
  readonly holderPid: number;
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
}): Promise<WindowsWorkerFilesystemGrant> {
  if (!active || _baseTrustedSettings === undefined) {
    throw new Error(
      "grantWindowsWorkerFilesystemAccess: ASRT sandbox is not active (initialize at boot first)",
    );
  }
  if (process.platform !== "win32") {
    throw new Error("grantWindowsWorkerFilesystemAccess is only valid on win32");
  }
  const {
    getWindowsSandboxUserStatus,
    grantWindowsAcl,
    revokeWindowsAcl,
    expandWindowsFsPaths,
    resolveSrtWin,
  } = await import("@anthropic-ai/sandbox-runtime");

  const srtWin = resolveSrtWin({ path: getVendoredSrtWinExePath() });
  const user = getWindowsSandboxUserStatus({ srtWin });
  const sandboxUserSid = user.sid;
  if (!user.provisioned || !user.credPresent || sandboxUserSid === undefined) {
    throw new Error(
      "grantWindowsWorkerFilesystemAccess: Windows sandbox user is not provisioned",
    );
  }

  const allowWrite = [
    ...new Set(expandWindowsFsPaths([...(opts.allowWrite ?? [])])),
  ];
  const allowRead = [
    ...new Set(expandWindowsFsPaths([
      ...(opts.allowRead ?? []),
      ...allowWrite,
    ])),
  ];

  if (allowRead.length > 0 || allowWrite.length > 0) {
    try {
      grantWindowsAcl({
        sandboxUserSid,
        holderPid: opts.holderPid,
        read: allowRead,
        write: allowWrite,
        srtWin,
      });
    } catch (err) {
      revokeWindowsAcl({ sandboxUserSid, holderPid: opts.holderPid, srtWin });
      throw err;
    }
  }

  let released = false;
  return {
    allowRead,
    allowWrite,
    release: () => {
      if (released) return;
      released = true;
      // Capture srtWin in the closure — the release may run long after the
      // dynamic import scope has gone; it still needs the explicit spawn
      // descriptor (0.0.67 has no implicit vendored fallback).
      revokeWindowsAcl({ sandboxUserSid, holderPid: opts.holderPid, srtWin });
    },
  };
}

/**
 * Per-command cleanup pass-through (`SandboxManager.cleanupAfterCommand`).
 * Call after a wrapped command finishes.
 */
export async function cleanupAsrtSandboxAfterCommand(): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  SandboxManager.cleanupAfterCommand();
}

/**
 * Full teardown pass-through (`SandboxManager.reset`). Stops proxy servers and
 * clears state.
 */
export async function resetAsrtSandbox(): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  await SandboxManager.reset();
  active = false;
  // worker-confinement PR D-1: drop the remembered base settings + live worker
  // UDS dirs so a fresh init starts from a clean slate (no stale socket allow).
  _baseTrustedSettings = undefined;
  _workerUnixSocketDirs.clear();
  // Drop every wrapped-worker marker (MCP servers AND host-spawned plugin
  // workers) so a torn-down sandbox cannot leave a stale `asrt` signal the
  // reviewer would honour. Lazy import keeps the module-load edge one-way
  // (sandbox-capability is renderer-safe and never imports back into this
  // main-only module).
  const { clearWrappedMcpServers, clearWrappedPluginWorkers, clearConfinedPluginChildren } =
    await import("./sandbox-capability.js");
  clearWrappedMcpServers();
  clearWrappedPluginWorkers();
  clearConfinedPluginChildren();
}

/**
 * Introspection: whether the current platform supports ASRT sandboxing.
 * Pass-through to `SandboxManager.isSupportedPlatform`.
 */
export async function isAsrtSandboxSupported(): Promise<boolean> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.isSupportedPlatform();
}
