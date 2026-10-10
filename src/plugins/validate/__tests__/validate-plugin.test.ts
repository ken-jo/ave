/**
 * The plugin validator, row by row (`docs/design/plugin-hostapi-protocol.md`
 * §9.7 P2).
 *
 * Three kinds of child. The five protocol-2 golden fixtures are complete
 * plugins run by the reference runtime, from source, exactly as
 * `bun run plugin:validate` runs them. The raw fixtures under
 * `fixtures/raw/` are plain scripts that speak the protocol by hand and
 * depart from it at one place each — the behaviours the reference runtime
 * cannot produce — handed to `runProtocolChecks` below the manifest step.
 * `fixtures/process/` is a `process` plugin: its own `#!/bin/sh` launcher
 * that execs `node` on a protocol script, validated from its directory.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginManifest } from "../../types.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { FRAME_BYTES_MAX } from "../../isolation/host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../../isolation/plugin-instance-wire.js";
import {
  runProtocolChecks,
  runProtocolChecksOnChild,
  validatePluginDirectory,
  VALIDATION_TEARDOWN_WAIT_MS,
  type ProtocolCheckOptions,
  type ProtocolRun,
  type ValidateOptions,
  type ValidationLaunch,
} from "../validate-plugin.js";
import { VALIDATION_KILL_GRACE_MS } from "../validation-child-link.js";
import { reportExitCode, type ReportRow } from "../report.js";
import { openValidationSession } from "../validation-session.js";
import { installPythonSmoke } from "../../isolation/__tests__/python-smoke-harness.js";

vi.mock("../validation-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation-session.js")>();
  return { ...actual, openValidationSession: vi.fn(actual.openValidationSession) };
});

const RAW = fileURLToPath(new URL("./fixtures/raw/", import.meta.url));
const PROCESS_PLUGIN = fileURLToPath(new URL("./fixtures/process/", import.meta.url));
const GOLDEN_PLUGINS = fileURLToPath(
  new URL("../../isolation/__tests__/fixtures/host-protocol/2/plugins/", import.meta.url),
);
const CHILD_MAIN = fileURLToPath(new URL("../../isolation/plugin-child-main.ts", import.meta.url));
const LOGGER_HOOK = fileURLToPath(
  new URL("../../../../scripts/lib/stub-app-logger-hook.mjs", import.meta.url),
);
const GOLDEN_IDS = ["orion-api", "local-indexer", "meeting", "lyra-mail", "vega-helper"] as const;

/** The reference runtime from source, as `plugin:validate` runs it. */
const SOURCE_MODE: ValidateOptions = {
  childEntry: CHILD_MAIN,
  childExecArgs: ["--import", "tsx", "--import", pathToFileURL(LOGGER_HOOK).href],
  fast: false,
  toolArgs: {},
};

/** `process.execPath` is Electron under this suite's runner; the variable makes it Node. */
const CHILD_ENV = buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" });

let scratch: string;
let dataDir: string;
const spawnedPids: number[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "validate-plugin-"));
  dataDir = join(scratch, "data");
  mkdirSync(dataDir);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  // A child whose signals were refused is still alive when its run returns.
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function rawManifest(tools: string[] = [], entry = "raw.mjs"): PluginManifest {
  return {
    id: "raw-fixture",
    name: "Raw Fixture",
    version: "1.0.0",
    entry,
    requires: { hostProtocol: "2", minAppVersion: "0.12.0" },
    description: "a child that speaks the protocol by hand",
    tools: tools.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  };
}

function rawLaunch(fixture: string): ValidationLaunch {
  return { command: process.execPath, args: [join(RAW, `${fixture}.mjs`)], env: CHILD_ENV };
}

function rawOptions(fixture: string, fast = true): ProtocolCheckOptions {
  return {
    pluginRoot: RAW,
    pluginDataDir: dataDir,
    pluginLaunch: { kind: "entry", entryPath: join(RAW, `${fixture}.mjs`) },
    fast,
    toolArgs: {},
  };
}

function row(rows: readonly ReportRow[], check: string): ReportRow {
  const found = rows.find((candidate) => candidate.check === check);
  if (!found) throw new Error(`no row '${check}' in ${JSON.stringify(rows.map((r) => r.check))}`);
  return found;
}

/** Every row after `check`, but the always-reported teardown. */
function rowsAfter(rows: readonly ReportRow[], check: string): ReportRow[] {
  const index = rows.findIndex((candidate) => candidate.check === check);
  return rows.slice(index + 1).filter((candidate) => candidate.check !== "protocol.teardown");
}

function eventAt(run: ProtocolRun, prefix: string): number {
  return run.record.timeline.findIndex((entry) => entry.event.startsWith(prefix));
}

/** A copy of a golden plugin, or of the process fixture, with its `plugin.json` edited. */
function editedPlugin(id: string, edit: (extension: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(scratch, `${id}-`));
  cpSync(id === "process" ? PROCESS_PLUGIN : join(GOLDEN_PLUGINS, id), dir, { recursive: true });
  const path = join(dir, "plugin.json");
  const document = JSON.parse(readFileSync(path, "utf-8")) as {
    extensions: Record<string, Record<string, unknown>>;
  };
  edit(document.extensions["ai.agent-connector.ave"]!);
  writeFileSync(path, JSON.stringify(document, null, 2));
  return dir;
}

describe("the manifest step", () => {
  for (const id of GOLDEN_IDS) {
    it(`passes the self-contained golden plugin '${id}' on every check`, async () => {
      const rows = await validatePluginDirectory(join(GOLDEN_PLUGINS, id), SOURCE_MODE);
      expect(rows.filter((candidate) => candidate.ok === false)).toEqual([]);
      expect(reportExitCode(rows)).toBe(0);
      expect(row(rows, "protocol.construct").ok).toBe(true);
      expect(row(rows, "protocol.stdin-close").ok).toBe(true);
      expect(row(rows, "protocol.teardown").ok).toBe(true);
    }, 30_000);
  }

  it("fails an unserved host protocol at its JSON pointer", async () => {
    const dir = editedPlugin("local-indexer", (extension) => {
      extension.requires = { minAppVersion: "0.12.0", hostProtocol: "1" };
    });
    const rows = await validatePluginDirectory(dir, SOURCE_MODE);
    expect(row(rows, "manifest.host-protocol")).toMatchObject({
      ok: false,
      path: "#/extensions/ai.agent-connector.ave/requires/hostProtocol",
    });
    expect(row(rows, "protocol").ok).toBeNull();
    expect(reportExitCode(rows)).toBe(1);
  });

  it("fails a minAppVersion below the first app that served the protocol", async () => {
    const dir = editedPlugin("local-indexer", (extension) => {
      extension.requires = { minAppVersion: "0.11.0", hostProtocol: "2" };
    });
    const rows = await validatePluginDirectory(dir, SOURCE_MODE);
    expect(row(rows, "manifest.min-app-version")).toMatchObject({
      ok: false,
      path: "#/extensions/ai.agent-connector.ave/requires/minAppVersion",
    });
    expect(reportExitCode(rows)).toBe(1);
  });

  it("fails an emitEvent literal the manifest does not declare", async () => {
    const dir = editedPlugin("local-indexer", () => undefined);
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "index.ts"),
      `export const fire = (hostApi: { emitEvent(type: string): void }) => hostApi.emitEvent("x");\n`,
    );
    const rows = await validatePluginDirectory(dir, SOURCE_MODE);
    expect(row(rows, "events.emit-undeclared")).toMatchObject({ ok: false, path: "src/index.ts" });
    expect(reportExitCode(rows)).toBe(1);
  }, 30_000);
});

describe("the process arm", () => {
  /** The manifest step's rows, which run on every platform. */
  const MANIFEST_ROWS = [
    "manifest.schema",
    "manifest.host-protocol",
    "manifest.min-app-version",
    "manifest.process",
  ] as const;

  /** What the fixture's protocol script was handed, from its stderr line. */
  function launchSeen(stderr: string): Record<string, unknown> {
    const line = /^launch=(.*)$/m.exec(stderr)?.[1];
    if (line === undefined) throw new Error(`the process fixture reported no launch: ${JSON.stringify(stderr)}`);
    return JSON.parse(line) as Record<string, unknown>;
  }

  function expectProcessEntryRows(rows: readonly ReportRow[]): void {
    for (const check of ["process.confinement", "process.provenance"]) {
      expect(row(rows, check)).toMatchObject({ ok: null, path: "#/extensions/ai.agent-connector.ave/process" });
      expect(row(rows, check).message).toMatch(/^not exercised: /);
    }
    expect(row(rows, "process.provenance").message).toContain("checked at install");
  }

  it("validates a process plugin end to end through the launch resolveProcessLaunch builds", async () => {
    let stderr = "";
    const sessions = vi.mocked(openValidationSession).mock.calls.length;
    const rows = await validatePluginDirectory(PROCESS_PLUGIN, {
      ...SOURCE_MODE,
      onChildStderr: (chunk) => {
        stderr += chunk.toString("utf-8");
      },
    });
    const root = realpathSync(PROCESS_PLUGIN);
    for (const check of MANIFEST_ROWS) expect(row(rows, check).ok).toBe(true);
    expectProcessEntryRows(rows);
    expect(rows.filter((candidate) => candidate.ok === false)).toEqual([]);
    expect(reportExitCode(rows)).toBe(0);
    if (process.platform === "win32") {
      expect(row(rows, "protocol")).toMatchObject({ ok: null, message: "not exercised: process entries do not run on win32" });
      expect(vi.mocked(openValidationSession).mock.calls).toHaveLength(sessions);
      return;
    }
    for (const check of [
      "protocol.construct",
      "construct.requires",
      "discover.capabilities",
      "tools.list",
      "tools.call:report_launch",
      "protocol.unknown-method",
      "protocol.stdin-close",
      "protocol.stdout-discipline",
      "protocol.request-meta",
      "protocol.teardown",
    ]) {
      expect(row(rows, check).ok).toBe(true);
    }
    // Construct carries the resolved command path, as the factory's does.
    expect(vi.mocked(openValidationSession).mock.calls.at(-1)?.[0].entryPath).toBe(join(root, "bin", "plugin"));
    // The declared pairs, resolved, then the host-owned pair: the plugin
    // root, and the run's own data directory.
    const seen = launchSeen(stderr);
    expect(seen.PLUGIN_ROOT).toBe(root);
    expect(seen.SMOKE_VENDOR_DIR).toBe(join(root, "vendor"));
    expect(typeof seen.PLUGIN_DATA).toBe("string");
    expect(seen.PLUGIN_DATA).not.toBe(root);
    expect(seen.SMOKE_STATE_DIR).toBe(join(String(seen.PLUGIN_DATA), "state"));
    expect(seen.argv).toEqual([join(root, "server.mjs"), "--stdio"]);
  }, 30_000);

  it("on win32 reports the protocol not exercised and still runs the manifest and source checks", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const sessions = vi.mocked(openValidationSession).mock.calls.length;
    let rows: ReportRow[];
    try {
      rows = await validatePluginDirectory(PROCESS_PLUGIN, SOURCE_MODE);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    for (const check of MANIFEST_ROWS) expect(row(rows, check).ok).toBe(true);
    expectProcessEntryRows(rows);
    expect(row(rows, "process.confinement").message).toContain("do not run on win32");
    expect(row(rows, "protocol")).toMatchObject({ ok: null, message: "not exercised: process entries do not run on win32" });
    expect(rows.some((candidate) => candidate.check.startsWith("protocol."))).toBe(false);
    expect(vi.mocked(openValidationSession).mock.calls).toHaveLength(sessions);
    expect(row(rows, "events.emit-undeclared")).toBeDefined();
    expect(reportExitCode(rows)).toBe(0);
  });

  for (const [why, edit, check, message] of [
    [
      "a ${PLUGIN_ROOT}/ path the package does not contain",
      (process: Record<string, unknown>) => {
        process.args = ["${PLUGIN_ROOT}/nope.mjs"];
      },
      "manifest.process",
      "names a path the plugin package does not contain",
    ],
    [
      "a command that is a directory, not a file inside the root",
      (process: Record<string, unknown>) => {
        process.command = "./vendor";
      },
      "manifest.process",
      "command path",
    ],
    [
      "an environment name the host reserves",
      (process: Record<string, unknown>) => {
        process.env = { BASH_ENV: "${PLUGIN_ROOT}/vendor" };
      },
      "manifest.schema",
      "BASH_ENV",
    ],
    [
      "a command outside the plugin root",
      (process: Record<string, unknown>) => {
        process.command = "../outside";
      },
      "manifest.schema",
      "command",
    ],
  ] as const) {
    it(`fails ${why} before any child is spawned`, async () => {
      const dir = editedPlugin("process", (extension) => edit(extension.process as Record<string, unknown>));
      const sessions = vi.mocked(openValidationSession).mock.calls.length;
      const rows = await validatePluginDirectory(dir, SOURCE_MODE);
      expect(row(rows, check).ok).toBe(false);
      expect(row(rows, check).message).toContain(message);
      // A hardening refusal leaves no manifest; a resolution failure fails a check of one.
      expect(row(rows, "protocol")).toMatchObject({
        ok: null,
        message: `not exercised: the manifest ${check === "manifest.schema" ? "did not parse" : "checks failed"}`,
      });
      expect(vi.mocked(openValidationSession).mock.calls).toHaveLength(sessions);
      expect(reportExitCode(rows)).toBe(1);
    });
  }

  // The cross-language smoke (§9.7 P5): a Python plugin on the stock `mcp`
  // library, which answers `server/discover` and refuses an MCP request that
  // lacks the per-request metadata. A process entry never runs on win32.
  it.runIf(process.platform !== "win32")("validates the Python smoke plugin end to end", async () => {
    const root = installPythonSmoke(join(scratch, "python-smoke"));
    const rows = await validatePluginDirectory(root, SOURCE_MODE);
    expect(rows.filter((candidate) => candidate.ok === false)).toEqual([]);
    for (const check of [
      ...MANIFEST_ROWS,
      "protocol.construct",
      "construct.requires",
      "lifecycle.start",
      "discover.capabilities",
      "tools.list",
      "tools.call:echo",
      "protocol.unknown-method",
      "lifecycle.stop",
      "protocol.stdin-close",
      "protocol.stdout-discipline",
      "protocol.request-meta",
      "protocol.teardown",
    ]) {
      expect(row(rows, check).ok, check).toBe(true);
    }
    expect(reportExitCode(rows)).toBe(0);
  }, 600_000);
});

describe("the session-level rows", () => {
  it("sends construct first, and every MCP request with both _meta keys", async () => {
    const run = await runProtocolChecks(rawLaunch("bare-stdout-line"), rawManifest(["echo"]), rawOptions("bare-stdout-line"));
    expect(run.record.hostFrames[0]?.method).toBe(PLUGIN_INSTANCE_METHODS.construct);
    const mcp = run.record.hostFrames.filter((frame) =>
      ["server/discover", "tools/list", "tools/call"].includes(String(frame.method)),
    );
    expect(mcp.map((frame) => frame.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
    for (const frame of mcp) {
      // A tools/call also names the host invocation it serves (protocol §3.3).
      expect((frame.params as { _meta: unknown })._meta).toEqual({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        ...(frame.method === "tools/call" ? { "ave/invocation": expect.any(String) } : {}),
      });
    }
    expect(row(run.rows, "protocol.request-meta").ok).toBe(true);
  });

  it("reports a declared sandbox grant not exercised, and the protocol rows still pass", async () => {
    const dir = editedPlugin("local-indexer", (extension) => {
      extension.sandbox = {
        read: [{ kind: "hostDirectory", segments: ["certs"], why: "Reads the host's trust anchors." }],
      };
    });
    const rows = await validatePluginDirectory(dir, SOURCE_MODE);
    expect(row(rows, "sandbox.grants")).toMatchObject({
      ok: null,
      path: "#/extensions/ai.agent-connector.ave/sandbox",
    });
    expect(row(rows, "sandbox.grants").message).toMatch(/^not exercised: /);
    const protocolRows = rows.filter((candidate) => /^(protocol|lifecycle|tools|discover|construct)\./.test(candidate.check));
    expect(protocolRows.filter((candidate) => candidate.ok === false)).toEqual([]);
    expect(reportExitCode(rows)).toBe(0);
  }, 30_000);

  it("closes stdin after the stop hook and terminates nothing before the child's exit", async () => {
    const dir = mkdtempSync(join(scratch, "stops-"));
    writeFileSync(
      join(dir, "entry.mjs"),
      `export const createPlugin = async () => ({ handlers: {}, stop: async () => undefined });\n`,
    );
    const manifest = rawManifest([], "entry.mjs");
    const run = await runProtocolChecks(
      {
        command: process.execPath,
        args: [...SOURCE_MODE.childExecArgs, CHILD_MAIN, join(dir, "entry.mjs")],
        env: CHILD_ENV,
      },
      manifest,
      {
        pluginRoot: dir,
        pluginDataDir: dataDir,
        pluginLaunch: { kind: "entry", entryPath: join(dir, "entry.mjs") },
        fast: false,
        toolArgs: {},
      },
    );
    expect(row(run.rows, "lifecycle.stop").ok).toBe(true);
    expect(row(run.rows, "protocol.stdin-close").ok).toBe(true);
    const exit = eventAt(run, "exit:");
    const terminate = eventAt(run, "terminate:");
    expect(exit).toBeGreaterThan(eventAt(run, "row:lifecycle.stop:ok"));
    expect(terminate === -1 || terminate > exit).toBe(true);
    expect(run.record.terminations).toEqual([]);
    expect(run.record.signalsSent).toEqual([]);
  }, 30_000);

  it("fails construct.requires when construct names a method the host does not advertise", async () => {
    const run = await runProtocolChecks(rawLaunch("requires-unserved"), rawManifest(), rawOptions("requires-unserved"));
    expect(row(run.rows, "protocol.construct").ok).toBe(true);
    expect(row(run.rows, "construct.requires")).toMatchObject({ ok: false });
    expect(row(run.rows, "construct.requires").message).toContain("ave/host/notServedAnywhere");
    expect(reportExitCode(run.rows)).toBe(1);
  });
});

describe("the raw child-process fixtures", () => {
  it("ignores-stdin-close: fails protocol.stdin-close, recorded before the kill", async () => {
    const run = await runProtocolChecks(rawLaunch("ignores-stdin-close"), rawManifest(), rawOptions("ignores-stdin-close"));
    expect(row(run.rows, "protocol.stdin-close")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
    const recorded = eventAt(run, "row:protocol.stdin-close:failed");
    const killed = eventAt(run, "signal:");
    expect(recorded).toBeGreaterThan(eventAt(run, "close-input"));
    expect(killed).toBeGreaterThan(recorded);
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
  });

  it("bare-stdout-line: fails stdout discipline although the decoder keeps every frame", async () => {
    const run = await runProtocolChecks(rawLaunch("bare-stdout-line"), rawManifest(), rawOptions("bare-stdout-line"));
    expect(row(run.rows, "protocol.stdout-discipline")).toMatchObject({ ok: false });
    expect(row(run.rows, "protocol.stdout-discipline").message).toContain('"ready"');
    const lines = Buffer.concat(run.record.stdout).toString("utf-8").split("\n").filter(Boolean);
    const frames = new StdioFrameDecoder(FRAME_BYTES_MAX).push(Buffer.concat(run.record.stdout));
    expect(frames).toHaveLength(lines.length - 1);
    expect(row(run.rows, "protocol.stdin-close").ok).toBe(true);
  });

  it("content-length-header: fails stdout discipline although the decoder keeps every frame", async () => {
    const run = await runProtocolChecks(
      rawLaunch("content-length-header"),
      rawManifest(),
      rawOptions("content-length-header"),
    );
    expect(row(run.rows, "protocol.construct").ok).toBe(true);
    expect(row(run.rows, "protocol.stdout-discipline")).toMatchObject({ ok: false });
    expect(row(run.rows, "protocol.stdout-discipline").message).toContain("Content-Length:");
  });

  it("withholds-start-reply: fails lifecycle.start at 1 s and ends the child once", async () => {
    const began = performance.now();
    const run = await runProtocolChecks(rawLaunch("withholds-start-reply"), rawManifest(), rawOptions("withholds-start-reply"));
    expect(performance.now() - began).toBeLessThan(5_000);
    expect(row(run.rows, "lifecycle.start")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
    expect(run.record.terminations).toHaveLength(1);
    for (const later of rowsAfter(run.rows, "lifecycle.start")) {
      expect(later.message).toBe("not exercised: lifecycle.start timed out");
    }
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
    expect(reportExitCode(run.rows)).toBe(1);
  });

  it("withholds-tool-reply: fails tools.call:echo at 1 s and ends the child once", async () => {
    const began = performance.now();
    const run = await runProtocolChecks(
      rawLaunch("withholds-tool-reply"),
      rawManifest(["echo"]),
      rawOptions("withholds-tool-reply"),
    );
    expect(performance.now() - began).toBeLessThan(5_000);
    expect(row(run.rows, "tools.list").ok).toBe(true);
    expect(row(run.rows, "tools.call:echo")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
    expect(run.record.terminations).toHaveLength(1);
    for (const later of rowsAfter(run.rows, "tools.call:echo")) {
      expect(later.message).toBe("not exercised: tools.call:echo timed out");
    }
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
    expect(reportExitCode(run.rows)).toBe(1);
  });

  it("withholds-construct: fails protocol.construct at 1 s, long before the 20 s cleanup deadline", async () => {
    const began = performance.now();
    const run = await runProtocolChecks(rawLaunch("withholds-construct"), rawManifest(), rawOptions("withholds-construct"));
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(row(run.rows, "protocol.construct")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
    expect(run.record.terminations).toHaveLength(1);
    expect(run.record.exitObserved()).toBeDefined();
    for (const later of rowsAfter(run.rows, "protocol.construct")) {
      expect(later.message).toBe("not exercised: protocol.construct timed out");
    }
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
    expect(reportExitCode(run.rows)).toBe(1);
    // The session received the run's own signal, so it existed while
    // construct was still pending.
    const calls = vi.mocked(openValidationSession).mock.calls;
    expect(calls.at(-1)?.[0].signal).toBe(run.signal);
    // The reply the fixture would have written at 2 s finds nothing to answer.
    const timeline = run.record.timeline.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500 - (performance.now() - began)));
    expect(run.record.timeline).toHaveLength(timeline);
  });

  it("slow-construct: fails protocol.construct at the runtime's 10 s activation bound", async () => {
    const began = performance.now();
    const run = await runProtocolChecks(rawLaunch("slow-construct"), rawManifest(), rawOptions("slow-construct", false));
    expect(performance.now() - began).toBeLessThan(10_500);
    expect(row(run.rows, "protocol.construct")).toMatchObject({ ok: false, message: "timed out after 10000 ms" });
    for (const later of rowsAfter(run.rows, "protocol.construct")) {
      expect(later.message).toBe("not exercised: protocol.construct timed out");
    }
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
  }, 20_000);

  it("ignores-sigterm: the escalation ends the child and protocol.teardown passes", async () => {
    const run = await runProtocolChecks(rawLaunch("ignores-sigterm"), rawManifest(), rawOptions("ignores-sigterm"));
    expect(row(run.rows, "lifecycle.start")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
    const signals = run.record.timeline.filter((entry) => entry.event.startsWith("signal:"));
    const exit = run.record.timeline.find((entry) => entry.event.startsWith("exit:"));
    expect(exit).toBeDefined();
    if (process.platform === "win32") {
      // Node ends a Windows process on the first signal, whatever it handles:
      // one SIGTERM, no SIGKILL, and the exit inside the teardown wait.
      expect(run.record.signalsSent).toEqual(["SIGTERM"]);
      expect(exit!.at - signals[0]!.at).toBeLessThan(VALIDATION_TEARDOWN_WAIT_MS);
    } else {
      expect(run.record.signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
      const grace = signals[1]!.at - signals[0]!.at;
      expect(grace).toBeGreaterThanOrEqual(VALIDATION_KILL_GRACE_MS - 50);
      expect(grace).toBeLessThan(VALIDATION_KILL_GRACE_MS + 500);
    }
    expect(row(run.rows, "protocol.teardown").ok).toBe(true);
    expect(reportExitCode(run.rows)).toBe(1);
  }, 15_000);
});

describe("a descendant that holds the child's pipes", () => {
  for (const [fixture, outcome] of [
    ["leaves-grandchild", "a clean run"],
    ["leaves-grandchild-withholds-start", "a failed run"],
  ] as const) {
    it(`${fixture}: ${outcome} releases the pipes and returns, while the descendant lives on`, async () => {
      const child = spawn(process.execPath, [join(RAW, `${fixture}.mjs`)], {
        env: CHILD_ENV,
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawnedPids.push(child.pid!);
      let stderr = "";
      const began = performance.now();
      const run = await runProtocolChecksOnChild(child, rawManifest(), {
        ...rawOptions(fixture),
        onChildStderr: (chunk) => {
          stderr += chunk.toString("utf-8");
        },
      });
      const elapsed = performance.now() - began;
      const descendant = Number(/descendant-pid=(\d+)/.exec(stderr)?.[1]);
      expect(Number.isInteger(descendant)).toBe(true);
      spawnedPids.push(descendant);
      // Still alive, still holding the inherited pipes: the run did not wait
      // for it, and nothing of the run is left open on its account.
      expect(() => process.kill(descendant, 0)).not.toThrow();
      expect([child.stdin?.destroyed, child.stdout?.destroyed, child.stderr?.destroyed]).toEqual([true, true, true]);
      expect(elapsed).toBeLessThan(VALIDATION_TEARDOWN_WAIT_MS);
      expect(row(run.rows, "protocol.teardown").ok).toBe(true);
      if (fixture === "leaves-grandchild") {
        expect(run.rows.filter((candidate) => candidate.ok === false)).toEqual([]);
        expect(row(run.rows, "protocol.stdin-close").ok).toBe(true);
        expect(reportExitCode(run.rows)).toBe(0);
      } else {
        expect(row(run.rows, "lifecycle.start")).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
        expect(reportExitCode(run.rows)).toBe(1);
      }
    });
  }
});

describe("refused signals", () => {
  /** One child whose `kill` takes Node's refusal path: `error` with EPERM, synchronously. */
  function refusingChild(fixture: string): ChildProcess {
    const child = spawn(process.execPath, [join(RAW, `${fixture}.mjs`)], {
      env: CHILD_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnedPids.push(child.pid!);
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
      child.emit(
        "error",
        Object.assign(new Error(`kill ${String(signal)} EPERM`), { code: "EPERM", syscall: "kill" }),
      );
      return false;
    };
    return child;
  }

  for (const [fixture, timedOut] of [
    ["withholds-construct", "protocol.construct"],
    ["withholds-start-reply", "lifecycle.start"],
  ] as const) {
    it(`${fixture}: an unexited child bounds the run and fails protocol.teardown`, async () => {
      const began = performance.now();
      const run = await runProtocolChecksOnChild(refusingChild(fixture), rawManifest(), rawOptions(fixture));
      const elapsed = performance.now() - began;
      expect(row(run.rows, timedOut)).toMatchObject({ ok: false, message: "timed out after 1000 ms" });
      for (const later of rowsAfter(run.rows, timedOut)) {
        expect(later.message).toBe(`not exercised: ${timedOut} timed out`);
      }
      const teardown = row(run.rows, "protocol.teardown");
      expect(teardown.ok).toBe(false);
      expect(teardown.message).toMatch(/^child did not exit after termination/);
      expect(run.record.signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
      expect(run.record.terminationFaults).toHaveLength(2);
      expect(run.record.exitObserved()).toBeUndefined();
      expect(reportExitCode(run.rows)).toBe(1);
      const waitEnded = run.record.timeline.find((entry) => entry.event.startsWith("terminate:"))!.at
        + VALIDATION_TEARDOWN_WAIT_MS;
      expect(performance.now() - waitEnded).toBeLessThan(1_000);
      if (fixture === "withholds-construct") expect(elapsed).toBeLessThan(7_000);
    }, 15_000);
  }
});
