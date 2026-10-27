/** Validate manifest, protocol and source drift; teardown always reports and releases owned child resources. */
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
  HOST_PROTOCOL_VERSIONS_SERVED,
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

const FAST_BOUND_MS = 1_000;

/** Bound the wait for stdin closure to end the child. */
const STDIN_CLOSE_EXIT_MS = 5_000;

/** Teardown waits through signal escalation; fast mode must not cut it shorter. */
export const VALIDATION_TEARDOWN_WAIT_MS = 5_000;

/** Bound post-exit pipe draining so descendants cannot hold the CLI open. */
const VALIDATION_OUTPUT_DRAIN_MS = 500;

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

const UNKNOWN_METHOD = "ave/host/validate.unknownMethod";

const MCP_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "tools/call",
  "resources/read",
]);

export interface ValidationLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Use the production launch union so construct names the same executable or module. */
type PluginLaunch = OutOfProcessPluginSpec["launch"];

/** Construct names the plugin module for entry launches and executable for process launches. */
function constructEntryPath(launch: PluginLaunch): string {
  return launch.kind === "entry" ? launch.entryPath : launch.command;
}

export type ToolArguments = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface ProtocolCheckOptions {
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly pluginLaunch: PluginLaunch;
  readonly fast: boolean;
  readonly toolArgs: ToolArguments;
  /** Stderr is child diagnostics, never report output; always drain it. */
  readonly onChildStderr?: (chunk: Buffer) => void;
}

export interface ProtocolRun {
  readonly rows: readonly ReportRow[];
  readonly record: ValidationChildRecord;
  readonly signal: AbortSignal;
}

class RunHalted extends Error {}

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

function startBoundMs(manifest: PluginManifest): number {
  return Math.min(
    manifest.startupTimeoutMs ?? TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
    TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
  );
}

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

function requiresArguments(inputSchema: unknown): boolean {
  const required = (inputSchema as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) && required.length > 0;
}

/** Accept an already-spawned child so callers can observe or inject signal behavior on that exact instance. */
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

  /** Deadline failure records a row, aborts the session and stops later checks. */
  const bounded = async <T>(check: string, boundMs: number, operation: () => Promise<T>): Promise<T> => {
    const ms = options.fast ? Math.min(boundMs, FAST_BOUND_MS) : boundMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<{ readonly expired: true }>((settle) => {
      timer = setTimeout(() => settle({ expired: true }), ms);
    });
    const work = operation();
    // Observe settlement after abort even when the caller stopped waiting.
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
      // Unsatisfied construct requirements fail at the session boundary.
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
    // Only validation bounds onPublished; production runtime intentionally awaits it without this ceiling.
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

    // Stop runs the hook without closing or terminating the channel.
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

    // Stdin EOF simulates host loss; the child must exit without another action.
    record.note("close-input");
    session.channel.closeInput();
    const exit = await bounded("protocol.stdin-close", STDIN_CLOSE_EXIT_MS, () => session.channel.exited);
    report(passed("protocol.stdin-close", `exited on stdin close: ${exit}`));
    // After observed exit release host resources without signaling.
    await session.teardown("validation finished");

    await bounded("protocol.stdout-discipline", STDIN_CLOSE_EXIT_MS, () => record.stdoutEnded);
    report(stdoutDisciplineRow(record.stdout));
    report(requestMetaRow(record.hostFrames));
  };

  /** Release every owned handle so descendant-held pipes cannot keep the CLI alive. */
  const releaseChild = (): void => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  };

  /** Always abort, initiate one termination, await bounded exit, drain remaining bytes and release pipes. */
  const finalize = async (): Promise<ReportRow> => {
    controller.abort(new Error("validation finished"));
    if (record.exitObserved() === undefined) link.terminate("validation finished");
    const exit = await within(record.exited, VALIDATION_TEARDOWN_WAIT_MS);
    if (exit !== undefined) {
      // Bound draining because exited-child pipes can remain open in descendants.
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

function extensionPointer(...segments: string[]): string {
  return `#/extensions/${AVE_EXTENSION_NAMESPACE}/${segments.join("/")}`;
}

/** Apply realpath containment to relative entry files inside the plugin directory. */
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

/** Resolve process launch with the runtime builder so rooted files and environment obey production rules. */
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
          ? "declares no host protocol; this validator serves protocol(s) " + HOST_PROTOCOL_VERSIONS_SERVED.join(", ")
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
      minAppVersion !== undefined && (floor === undefined || compareSemver(minAppVersion, floor) >= 0)
        ? passed("manifest.min-app-version", floor === undefined
            ? `host protocol ${declared} availability is negotiated; no published app floor is recorded`
            : `${minAppVersion} ≥ ${floor}`, versionPath)
        : failed(
            "manifest.min-app-version",
            (floor === undefined ? `host protocol ${declared} requires an explicit minAppVersion; `
              : `host protocol ${declared} was first served by app ${floor}; `) + "minAppVersion " +
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

/** Source-directory validation proves neither runtime confinement nor pinned provenance; report both as unmeasured. */
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

/** Never apply declared sandbox grants during validation. */
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
  readonly childEntry: string;
  readonly childExecArgs: readonly string[];
  readonly fast: boolean;
  readonly toolArgs: ToolArguments;
  readonly onChildStderr?: (chunk: Buffer) => void;
}

/** Run unconfined with node-mode enabled when the executable is the desktop binary. */
function validationLaunch(options: ValidateOptions, launch: PluginLaunch): ValidationLaunch {
  if (launch.kind === "entry") {
    return {
      command: process.execPath,
      args: [...options.childExecArgs, options.childEntry, launch.entryPath],
      env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    };
  }
  // Use declared pairs followed by authoritative host root/data pairs over the safe launch environment.
  return { command: launch.command, args: launch.args, env: buildSafeChildEnv({ ...launch.env }) };
}

/** Process validation without runtime support leaves protocol unmeasured while manifest and source checks still run. */
export async function validatePluginDirectory(dir: string, options: ValidateOptions): Promise<ReportRow[]> {
  const pluginRoot = realpathSync(dir);
  // Create temporary data before resolving process placeholder paths.
  const pluginDataDir = mkdtempSync(join(tmpdir(), "ave-plugin-validate-"));
  // Leave data if exit was not observed; deleting a live child-writable tree permits link-swap escapes.
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
