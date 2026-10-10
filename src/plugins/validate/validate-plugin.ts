/**
 * Validate a plugin directory without the app
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P2, §10.2).
 *
 * Three steps, each a list of report rows:
 *
 *  1. THE MANIFEST — the host's own schema and hardening pass, the protocol
 *     this build serves, and the first app version that served it.
 *  2. THE PROTOCOL — the plugin spawned as a plain child process the validator
 *     owns, attached to the validation-only session entry with the validation
 *     host, and driven through the sequence the host itself uses: construct
 *     first, then start, `onPublished`, `server/discover`, `tools/list`, each
 *     tool, an unknown-method probe, the stop hook alone, and stdin closed with
 *     no termination. An `entry` plugin runs in the reference runtime; a
 *     `process` plugin runs its own executable, launched as P3's
 *     `resolveProcessLaunch` builds it. No sandbox (decision 30): confinement
 *     is the host suite's to prove, and the report says so for a `process`
 *     plugin rather than implying it.
 *  3. SOURCE DRIFT — what the code names against what the manifest declares.
 *
 * EVERY AWAITED STEP IS BOUNDED, HERE. The session is driven directly, so the
 * runtime's own timeout owners never run, and the transport sets no timer on a
 * call without a deadline: without these bounds one silent child would hang
 * the validator and the CI job running it. The values are the runtime's
 * (`TOOL_TIMEOUT_POLICY`), so a plugin that passes here fits inside the bounds
 * the app applies. An expiry fails its row, aborts the run — which tears the
 * session down and ends the child — and every later row is reported not
 * exercised.
 *
 * CLEANUP IS UNCONDITIONAL. Whatever happened — a construct that never
 * answered, an opener that refused before any frame, a spawn that produced no
 * process — the finalizer ends the child through the CLI's own link, waits a
 * bounded time for its exit, and reports `protocol.teardown`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PluginManifest } from "../types.js";
import { AVE_EXTENSION_NAMESPACE } from "../public-contract.js";
import { resolveProcessLaunch } from "../process-entry.js";
import type { OutOfProcessPluginSpec } from "../isolation/out-of-process-plugin.js";
import { buildManifestValidator, parsePluginJson } from "../runtime/manifest-validation.js";
import {
  HOST_PROTOCOL_FIRST_APP_VERSION,
  IncompatibleHostProtocolError,
  isServedHostProtocolVersion,
} from "../isolation/host-api-wire.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { errorMessage } from "../../shared/error-message.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import {
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  RPC_METHOD_NOT_FOUND,
} from "../../mcp/protocol-constants.js";
import { createValidationHost } from "./validation-host.js";
import { openValidationSession, type ValidationSession } from "./validation-session.js";
import {
  createValidationChildLink,
  type ValidationChildRecord,
} from "./validation-child-link.js";
import { failed, notExercised, passed, type ReportRow } from "./report.js";
import { scanSourceDrift } from "./source-drift.js";

/** What `--fast` caps every protocol bound at, except the teardown wait. */
const FAST_BOUND_MS = 1_000;

/** How long a closed stdin may take to end the child (§10.1 item 3). */
const STDIN_CLOSE_EXIT_MS = 5_000;

/**
 * How long the finalizer waits for the exit after starting termination: the
 * kill grace plus 2 s for the SIGKILL and its `exit` event. Not capped by
 * `--fast` — a shorter wait would end before the escalation it reports on.
 */
export const VALIDATION_TEARDOWN_WAIT_MS = 5_000;

/**
 * How long the finalizer collects output still in flight on an exited child's
 * pipes before releasing them. Short: it waits only on bytes already written,
 * or on a descendant that holds a pipe and is never waited for.
 */
const VALIDATION_OUTPUT_DRAIN_MS = 500;

/** `promise`'s value, or `undefined` once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((settle) => {
        timer = setTimeout(() => settle(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The method the unknown-method probe sends; no host or child serves it. */
const UNKNOWN_METHOD = "ave/host/validate.unknownMethod";

/** The MCP requests whose frames must carry MCP's per-request metadata. */
const MCP_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "tools/call",
  "resources/read",
]);

/** A command line the validator spawns, unconfined. */
export interface ValidationLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How the plugin's process is produced: the production factory's own launch
 * union (decision 33), so construct's `entryPath` is derived here exactly as
 * the factory derives it.
 */
type PluginLaunch = OutOfProcessPluginSpec["launch"];

/**
 * What construct carries as `entryPath`: the plugin's real JS module for an
 * `entry` launch, the resolved command path for a `process` launch.
 */
function constructEntryPath(launch: PluginLaunch): string {
  return launch.kind === "entry" ? launch.entryPath : launch.command;
}

/** `tools/call` arguments by tool name, from `--tool-args`. */
export type ToolArguments = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface ProtocolCheckOptions {
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  /** How the child was produced; construct's `entryPath` comes from it. */
  readonly pluginLaunch: PluginLaunch;
  readonly fast: boolean;
  readonly toolArgs: ToolArguments;
  /** The child's stderr — its diagnostics, never the report. Drained when absent. */
  readonly onChildStderr?: (chunk: Buffer) => void;
}

export interface ProtocolRun {
  readonly rows: readonly ReportRow[];
  /** What the CLI's link recorded, from the spawn on. */
  readonly record: ValidationChildRecord;
  /** The run's one cancellation, as handed to the session. */
  readonly signal: AbortSignal;
}

/** Thrown into the step sequence to stop it; the rows say why. */
class RunHalted extends Error {}

/** The protocol rows, in the order they run, before the always-reported teardown. */
function plannedProtocolRows(manifest: PluginManifest): string[] {
  return [
    "protocol.construct",
    "construct.requires",
    "lifecycle.start",
    "lifecycle.on-published",
    "discover.capabilities",
    "tools.list",
    ...manifest.tools.map((tool) => `tools.call:${tool.name}`),
    "protocol.unknown-method",
    "lifecycle.stop",
    "protocol.stdin-close",
    "protocol.stdout-discipline",
    "protocol.request-meta",
  ];
}

/** The runtime's `start` bound: the declared timeout clamped to the maximum, else the default. */
function startBoundMs(manifest: PluginManifest): number {
  return Math.min(
    manifest.startupTimeoutMs ?? TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
    TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
  );
}

/** Every line is one JSON object ended by `0x0A`, and nothing else is on stdout. */
function stdoutDisciplineRow(stdout: readonly Buffer[]): ReportRow {
  const check = "protocol.stdout-discipline";
  const bytes = Buffer.concat(stdout);
  const lines = bytes.toString("utf-8").split("\n");
  const unterminated = lines.pop() ?? "";
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return failed(
        check,
        `stdout line ${index + 1} is not a JSON object: ${JSON.stringify(line.slice(0, 80))}`,
      );
    }
  }
  if (unterminated.length > 0) {
    return failed(check, `stdout ends without 0x0A after ${JSON.stringify(unterminated.slice(0, 80))}`);
  }
  return passed(check, `${lines.length} line(s), each one JSON object ended by 0x0A`);
}

/** Every MCP request frame the host sent carries both keys MCP requires. */
function requestMetaRow(hostFrames: ReadonlyArray<Record<string, unknown>>): ReportRow {
  const check = "protocol.request-meta";
  const requests = hostFrames.filter(
    (frame) => "id" in frame && typeof frame.method === "string" && MCP_REQUEST_METHODS.has(frame.method),
  );
  for (const frame of requests) {
    const meta = (frame.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const capabilities = meta?.[META_CLIENT_CAPABILITIES];
    if (
      meta?.[META_PROTOCOL_VERSION] !== MCP_PROTOCOL_VERSION ||
      typeof capabilities !== "object" ||
      capabilities === null
    ) {
      return failed(
        check,
        `the host's ${String(frame.method)} request lacks _meta "${META_PROTOCOL_VERSION}": ` +
          `"${MCP_PROTOCOL_VERSION}" and "${META_CLIENT_CAPABILITIES}": {}`,
      );
    }
  }
  return passed(check, `${requests.length} MCP request frame(s), each with both _meta keys`);
}

/** `server/discover` speaks this MCP revision and advertises tools when there are any. */
function discoverRow(manifest: PluginManifest, result: unknown): ReportRow {
  const check = "discover.capabilities";
  const body = result as { supportedVersions?: unknown; capabilities?: { tools?: unknown } } | undefined;
  const versions = Array.isArray(body?.supportedVersions) ? body.supportedVersions : [];
  if (!versions.includes(MCP_PROTOCOL_VERSION)) {
    return failed(check, `supportedVersions ${JSON.stringify(body?.supportedVersions)} lacks "${MCP_PROTOCOL_VERSION}"`);
  }
  if (manifest.tools.length > 0 && body?.capabilities?.tools === undefined) {
    return failed(check, "the manifest declares tools but capabilities.tools is absent");
  }
  return passed(check, `speaks ${MCP_PROTOCOL_VERSION}`);
}

/** `tools/list` returns exactly the manifest's tools. */
function toolsListRow(manifest: PluginManifest, result: unknown): ReportRow {
  const check = "tools.list";
  const listed = (result as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(listed)) return failed(check, "tools/list returned no tools array");
  const names = listed.map((tool) => String((tool as { name?: unknown }).name)).sort();
  const declared = manifest.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(declared)) {
    return failed(check, `listed ${JSON.stringify(names)}, the manifest declares ${JSON.stringify(declared)}`);
  }
  return passed(check, `${names.length} tool(s), exactly the manifest's`);
}

/** Whether a tool's input schema requires any property. */
function requiresArguments(inputSchema: unknown): boolean {
  const required = (inputSchema as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) && required.length > 0;
}

/**
 * Drive the protocol over a child that was spawned in the same turn.
 *
 * Takes the child rather than a command so a caller can hold the one
 * instance — which is how a test replaces its `kill` with Node's refusal path.
 */
export async function runProtocolChecksOnChild(
  child: ChildProcess,
  manifest: PluginManifest,
  options: ProtocolCheckOptions,
): Promise<ProtocolRun> {
  const { link, record } = createValidationChildLink(child);
  const forwardStderr = options.onChildStderr ?? (() => undefined);
  child.stderr?.on("data", (chunk: Buffer) => forwardStderr(chunk));
  const stderrEnded = new Promise<void>((resolve) => {
    if (!child.stderr) resolve();
    else child.stderr.once("end", () => resolve());
  });

  const controller = new AbortController();
  const rows = new Map<string, ReportRow>();
  let halted: string | undefined;
  const report = (row: ReportRow): void => {
    rows.set(row.check, row);
    record.note(`row:${row.check}:${row.ok === null ? "not-exercised" : row.ok ? "ok" : "failed"}`);
  };
  const halt = (why: string): never => {
    halted = why;
    throw new RunHalted(why);
  };

  /**
   * Race one operation against its bound. On expiry the row fails, the run is
   * aborted — the session turns that into its teardown — and the sequence
   * stops. A rejection is the caller's to read.
   */
  const bounded = async <T>(check: string, boundMs: number, operation: () => Promise<T>): Promise<T> => {
    const ms = options.fast ? Math.min(boundMs, FAST_BOUND_MS) : boundMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<{ readonly expired: true }>((settle) => {
      timer = setTimeout(() => settle({ expired: true }), ms);
    });
    const work = operation();
    // Settles after an abort, with nobody waiting for it any more.
    work.catch(() => undefined);
    try {
      const outcome = await Promise.race([work.then((value) => ({ value })), expired]);
      if ("expired" in outcome) {
        report(failed(check, `timed out after ${ms} ms`));
        controller.abort(new Error(`validation deadline: ${check}`));
        return halt(`${check} timed out`);
      }
      return outcome.value;
    } finally {
      clearTimeout(timer);
    }
  };

  const steps = async (): Promise<void> => {
    let session: ValidationSession;
    try {
      session = await bounded("protocol.construct", TOOL_TIMEOUT_POLICY.pluginFactoryMs, () =>
        openValidationSession({
          manifest,
          host: createValidationHost(),
          link,
          entryPath: constructEntryPath(options.pluginLaunch),
          pluginRoot: options.pluginRoot,
          pluginDataDir: options.pluginDataDir,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (error instanceof RunHalted) throw error;
      // The session refuses a construct reply whose `pluginProtocol.requires`
      // names a method it did not advertise: construct answered, and what it
      // answered is the failure.
      if (error instanceof IncompatibleHostProtocolError && "missingCapabilities" in error.detail) {
        report(passed("protocol.construct", "construct answered"));
        report(
          failed(
            "construct.requires",
            `pluginProtocol.requires names ${JSON.stringify(error.detail.missingCapabilities)}, ` +
              "which the validation host does not advertise",
          ),
        );
        return halt("construct.requires failed");
      }
      report(failed("protocol.construct", errorMessage(error)));
      return halt("protocol.construct failed");
    }
    report(passed("protocol.construct", "construct answered"));
    report(
      passed(
        "construct.requires",
        `requires ${session.construction.pluginProtocol.requires.length} method(s), all among the ` +
          `${session.capabilities.length} advertised`,
      ),
    );

    const lifecycle = async (
      check: string,
      hook: (() => Promise<void> | void) | undefined,
      name: string,
    ): Promise<void> => {
      if (hook === undefined) {
        report(notExercised(check, `the plugin implements no ${name} hook`));
        return;
      }
      try {
        await bounded(check, startBoundMs(manifest), async () => await hook());
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        report(failed(check, errorMessage(error)));
        halt(`${check} failed`);
      }
      report(passed(check, `${name} answered`));
    };
    await lifecycle("lifecycle.start", session.instance.start?.bind(session.instance), "start");
    // Validator-only policy: the runtime awaits `onPublished` unbounded, so
    // this bound is the validator refusing to hang on it, not parity.
    await lifecycle(
      "lifecycle.on-published",
      session.instance.onPublished?.bind(session.instance),
      "onPublished",
    );

    const mcp = async (check: string, method: "server/discover" | "tools/list", read: (result: unknown) => ReportRow) => {
      try {
        report(read(await bounded(check, TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs, () => session.channel.requestMcp(method, {}))));
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        report(failed(check, errorMessage(error)));
      }
    };
    await mcp("discover.capabilities", "server/discover", (result) => discoverRow(manifest, result));
    await mcp("tools.list", "tools/list", (result) => toolsListRow(manifest, result));

    for (const tool of manifest.tools) {
      const check = `tools.call:${tool.name}`;
      const handler = session.instance.handlers[tool.name];
      if (handler === undefined) {
        report(failed(check, "the manifest declares the tool and the plugin implements no handler for it"));
        continue;
      }
      const args = options.toolArgs[tool.name] ?? (requiresArguments(tool.inputSchema) ? undefined : {});
      if (args === undefined) {
        report(notExercised(check, "its inputSchema requires arguments and --tool-args gives none"));
        continue;
      }
      try {
        await bounded(check, TOOL_TIMEOUT_POLICY.globalCeilingMs, async () => await handler(args));
        report(passed(check, "answered"));
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        report(failed(check, errorMessage(error)));
      }
    }

    try {
      const reply = await bounded("protocol.unknown-method", TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs, () =>
        session.channel.probe(UNKNOWN_METHOD),
      );
      report(
        "error" in reply && reply.error.code === RPC_METHOD_NOT_FOUND
          ? passed("protocol.unknown-method", `${UNKNOWN_METHOD} answered ${RPC_METHOD_NOT_FOUND}`)
          : failed(
              "protocol.unknown-method",
              `${UNKNOWN_METHOD} answered ${JSON.stringify(reply)}, not error ${RPC_METHOD_NOT_FOUND}`,
            ),
      );
    } catch (error) {
      if (error instanceof RunHalted) throw error;
      report(failed("protocol.unknown-method", errorMessage(error)));
    }

    // The stop hook alone: it neither closes the channel nor terminates.
    if (!session.construction.lifecycleHooks.includes("stop")) {
      report(notExercised("lifecycle.stop", "the plugin implements no stop hook"));
    } else {
      try {
        await bounded("lifecycle.stop", TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs, () => session.channel.runStopHook());
        report(passed("lifecycle.stop", "stop answered"));
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        report(failed("lifecycle.stop", errorMessage(error)));
      }
    }

    // What a crashed host looks like to the child: stdin ends, and nothing
    // else happens. The child must leave on its own.
    record.note("close-input");
    session.channel.closeInput();
    const exit = await bounded("protocol.stdin-close", STDIN_CLOSE_EXIT_MS, () => session.channel.exited);
    report(passed("protocol.stdin-close", `exited on stdin close: ${exit}`));
    // After an observed exit this releases the host side and terminates nothing.
    await session.teardown("validation finished");

    // `exit` can arrive before the last of stdout has been read.
    await bounded("protocol.stdout-discipline", STDIN_CLOSE_EXIT_MS, () => record.stdoutEnded);
    report(stdoutDisciplineRow(record.stdout));
    report(requestMetaRow(record.hostFrames));
  };

  /**
   * Give up every handle the run holds on the child, so the run's end never
   * waits on anyone else's. A descendant the plugin started inherits the
   * child's pipes, and holds them open after the child itself has left: the
   * CLI must not stay alive for as long as that descendant does.
   */
  const releaseChild = (): void => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  };

  /**
   * Runs on every path, including an opener that rejected with no session:
   * abort the run (a live session tears down), start the link's one
   * termination sequence unless the child already left, wait a bounded time
   * for the exit, collect what is still in flight on its pipes for a bounded
   * time, and release them.
   */
  const finalize = async (): Promise<ReportRow> => {
    controller.abort(new Error("validation finished"));
    if (record.exitObserved() === undefined) link.terminate("validation finished");
    const exit = await within(record.exited, VALIDATION_TEARDOWN_WAIT_MS);
    if (exit !== undefined) {
      // The last bytes of an exited child are read after its `exit`; a pipe a
      // descendant still holds never ends, and is cut at the bound.
      await within(Promise.all([record.stdoutEnded, stderrEnded]), VALIDATION_OUTPUT_DRAIN_MS);
    }
    releaseChild();
    if (exit !== undefined) return passed("protocol.teardown", exit);
    return failed(
      "protocol.teardown",
      `child did not exit after termination; signals sent: ${record.signalsSent.join(", ") || "none"}; ` +
        `termination faults: ${record.terminationFaults.join("; ") || "none"}`,
    );
  };

  try {
    await steps();
  } catch (error) {
    if (!(error instanceof RunHalted)) {
      await finalize();
      throw error;
    }
  }
  const teardownRow = await finalize();

  const ordered = plannedProtocolRows(manifest).map(
    (check) => rows.get(check) ?? notExercised(check, halted ?? "the run stopped before it"),
  );
  return { rows: [...ordered, teardownRow], record, signal: controller.signal };
}

/** Spawn `launch` as a plain, unconfined child and drive the protocol over it. */
export async function runProtocolChecks(
  launch: ValidationLaunch,
  manifest: PluginManifest,
  options: ProtocolCheckOptions,
): Promise<ProtocolRun> {
  const child = spawn(launch.command, [...launch.args], {
    env: { ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return await runProtocolChecksOnChild(child, manifest, options);
}

/** A JSON pointer into `plugin.json` for a field of the Ave extension. */
function extensionPointer(...segments: string[]): string {
  return `#/extensions/${AVE_EXTENSION_NAMESPACE}/${segments.join("/")}`;
}

/**
 * The runtime's containment rule for an `entry`, on real paths: a relative
 * path to a file inside the plugin's own directory.
 */
function entryLaunchRow(pluginRoot: string, entry: string): { row: ReportRow; launch?: PluginLaunch } {
  const entryPointer = extensionPointer("entry");
  const candidate = resolve(pluginRoot, entry);
  const inside = (path: string): boolean => {
    const rel = relative(pluginRoot, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (isAbsolute(entry) || !inside(candidate) || !existsSync(candidate)) {
    return { row: failed("manifest.entry", `"${entry}" is not a file inside the plugin directory`, entryPointer) };
  }
  const entryPath = realpathSync(candidate);
  if (!inside(entryPath) || !statSync(entryPath).isFile()) {
    return {
      row: failed("manifest.entry", `"${entry}" resolves outside the plugin directory or to a non-file`, entryPointer),
    };
  }
  return { row: passed("manifest.entry", entry, entryPointer), launch: { kind: "entry", entryPath } };
}

/**
 * A `process` entry resolved by the runtime's own builder against this
 * directory and the run's data directory: the command a regular file inside
 * the plugin, every `${PLUGIN_ROOT}/…` path an existing file or directory
 * inside it, every `${PLUGIN_DATA}…` path inside the data directory, the
 * declared names outside the reserved set — the rules hardening cannot check
 * without the files.
 */
function processLaunchRow(
  manifest: PluginManifest,
  pluginRoot: string,
  pluginDataDir: string,
): { row: ReportRow; launch?: PluginLaunch } {
  const processPointer = extensionPointer("process");
  try {
    const launch = resolveProcessLaunch(manifest, pluginRoot, pluginDataDir);
    return {
      row: passed("manifest.process", `runs ${relative(pluginRoot, launch.command)}`, processPointer),
      launch: { kind: "process", ...launch },
    };
  } catch (error) {
    return { row: failed("manifest.process", errorMessage(error), processPointer) };
  }
}

/** The manifest step: rows, and the manifest when it parsed. */
async function checkManifest(
  pluginRoot: string,
  pluginDataDir: string,
): Promise<{ rows: ReportRow[]; manifest?: PluginManifest; launch?: PluginLaunch }> {
  let manifest: PluginManifest;
  try {
    manifest = await parsePluginJson(join(pluginRoot, "plugin.json"), await buildManifestValidator());
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = typeof code === "string" ? `${code}: ${errorMessage(error)}` : errorMessage(error);
    return { rows: [failed("manifest.schema", message, "plugin.json")] };
  }
  const rows: ReportRow[] = [passed("manifest.schema", "plugin.json passes the host's schema and hardening")];

  const declared = manifest.requires?.hostProtocol;
  const protocolPath = extensionPointer("requires", "hostProtocol");
  if (!isServedHostProtocolVersion(declared)) {
    rows.push(
      failed(
        "manifest.host-protocol",
        declared === undefined
          ? "declares no host protocol; this validator serves protocol(s) " + Object.keys(HOST_PROTOCOL_FIRST_APP_VERSION).join(", ")
          : `declares host protocol "${declared}", which this validator does not serve`,
        protocolPath,
      ),
    );
  } else {
    rows.push(passed("manifest.host-protocol", `host protocol ${declared}`, protocolPath));
    const floor = HOST_PROTOCOL_FIRST_APP_VERSION[declared];
    const minAppVersion = manifest.requires?.minAppVersion;
    const versionPath = extensionPointer("requires", "minAppVersion");
    rows.push(
      minAppVersion !== undefined && compareSemver(minAppVersion, floor) >= 0
        ? passed("manifest.min-app-version", `${minAppVersion} ≥ ${floor}`, versionPath)
        : failed(
            "manifest.min-app-version",
            `host protocol ${declared} was first served by app ${floor}; minAppVersion ` +
              `${minAppVersion === undefined ? "is absent" : `"${minAppVersion}" is lower`}`,
            versionPath,
          ),
    );
  }

  const resolved =
    manifest.process === undefined
      ? entryLaunchRow(pluginRoot, manifest.entry)
      : processLaunchRow(manifest, pluginRoot, pluginDataDir);
  rows.push(resolved.row);
  return resolved.launch === undefined ? { rows, manifest } : { rows, manifest, launch: resolved.launch };
}

/**
 * What a `process` plugin's report says the validator did not prove, as rows
 * that are never passed: the app runs that executable only under an OS
 * sandbox that confines processes, and only from a sha256-pinned install —
 * neither of which a source directory run outside the app can show.
 */
function processEntryRows(): ReportRow[] {
  const processPointer = extensionPointer("process");
  return [
    notExercised(
      "process.confinement",
      process.platform === "win32"
        ? "process entries do not run on win32; the app refuses them there"
        : "the validator runs the process entry unconfined (decision 30); the app runs it only under an OS " +
            "sandbox that confines processes, on macOS and Linux",
      processPointer,
    ),
    notExercised(
      "process.provenance",
      "the sha256 pin is checked at install: the app runs a process entry only from a release or archive " +
        "artifact its install receipt pins, which a source directory does not have",
      processPointer,
    ),
  ];
}

/** The `sandbox.grants` row: declared grants are never applied here. */
function sandboxGrantsRow(manifest: PluginManifest): ReportRow {
  const grants = [...(manifest.sandbox?.read ?? []), ...(manifest.sandbox?.write ?? [])];
  if (grants.length === 0) {
    return passed("sandbox.grants", "declares no sandbox grant; the base envelope is its whole authority");
  }
  return notExercised(
    "sandbox.grants",
    `the validator applies the base envelope only, so ${grants.length} declared grant(s) were not applied`,
    extensionPointer("sandbox"),
  );
}

export interface ValidateOptions {
  /** The reference runtime's child entry (`ave-plugin-child-main.js`). */
  readonly childEntry: string;
  /** Prepended to the child's `process.execPath` invocation. */
  readonly childExecArgs: readonly string[];
  readonly fast: boolean;
  readonly toolArgs: ToolArguments;
  readonly onChildStderr?: (chunk: Buffer) => void;
}

/**
 * The command line that runs the plugin, unconfined. An `entry` plugin runs in
 * the reference runtime, which constructs the plugin from the entry construct
 * names; a `process` plugin is its own resolved command and arguments.
 *
 * `ELECTRON_RUN_AS_NODE` because `process.execPath` is the Electron binary
 * when the validator itself runs under Electron, as it does in the app's test
 * runner; plain Node ignores it.
 */
function validationLaunch(options: ValidateOptions, launch: PluginLaunch): ValidationLaunch {
  if (launch.kind === "entry") {
    return {
      command: process.execPath,
      args: [...options.childExecArgs, options.childEntry, launch.entryPath],
      env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }
  // The pairs `resolveProcessLaunch` built — the declared ones, then the
  // host-owned PLUGIN_ROOT and PLUGIN_DATA — over the same safe base the app's
  // `env(1)` applies them to inside its wrap.
  return { command: launch.command, args: launch.args, env: buildSafeChildEnv({ ...launch.env }) };
}

/**
 * Validate the plugin in `dir`: the manifest, then the protocol over a child
 * the validator spawns, then the source drift.
 *
 * Both entry kinds reach the protocol step. A `process` plugin's own
 * executable is spawned unconfined, as decision 30 has the validator do, and
 * its report says confinement and provenance were not exercised; on win32,
 * where the app never runs one, its protocol step is not exercised and the
 * manifest and source checks still run.
 */
export async function validatePluginDirectory(dir: string, options: ValidateOptions): Promise<ReportRow[]> {
  const pluginRoot = realpathSync(dir);
  // Created before the manifest step: a `process` entry's `${PLUGIN_DATA}`
  // paths resolve against it there, and the protocol step runs against it.
  const pluginDataDir = mkdtempSync(join(tmpdir(), "ave-plugin-validate-"));
  // The child writes this directory. Until its exit is observed it may still
  // be running, and a recursive delete would race it (a link swapped in
  // mid-walk turns the delete onto outside files); the directory is then left.
  let childMayStillRun = false;
  try {
    const checked = await checkManifest(pluginRoot, pluginDataDir);
    const rows = [...checked.rows];
    const { manifest, launch } = checked;
    if (manifest === undefined) {
      rows.push(notExercised("protocol", "the manifest did not parse"));
      rows.push(notExercised("source-drift", "the manifest did not parse"));
      return rows;
    }
    rows.push(sandboxGrantsRow(manifest));
    if (manifest.process !== undefined) rows.push(...processEntryRows());
    if (launch === undefined || rows.some((row) => row.ok === false)) {
      rows.push(notExercised("protocol", "the manifest checks failed"));
    } else if (launch.kind === "process" && process.platform === "win32") {
      rows.push(notExercised("protocol", "process entries do not run on win32"));
    } else {
      childMayStillRun = true;
      const run = await runProtocolChecks(validationLaunch(options, launch), manifest, {
        pluginRoot,
        pluginDataDir,
        pluginLaunch: launch,
        fast: options.fast,
        toolArgs: options.toolArgs,
        ...(options.onChildStderr ? { onChildStderr: options.onChildStderr } : {}),
      });
      rows.push(...run.rows);
      childMayStillRun = run.record.exitObserved() === undefined;
      if (childMayStillRun) {
        rows.push(failed("protocol.data-dir", `left ${pluginDataDir} in place: the child did not exit, so deleting it could race the child`));
      }
    }
    rows.push(...scanSourceDrift(pluginRoot, manifest));
    return rows;
  } finally {
    if (!childMayStillRun) rmSync(pluginDataDir, { recursive: true, force: true });
  }
}
