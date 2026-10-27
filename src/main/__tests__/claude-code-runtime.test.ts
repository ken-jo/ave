import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { pinClaudeCodeExecutable, type ClaudeCodeExecutable } from "../claude-code-executable.js";
import * as authenticity from "../claude-code-authenticity.js";
import { NATIVE_LOCATION_WAIT, NATIVE_PROBE_HEAVY_TEST, normalizeFixtureAncestorPermissions, writeNativeExecutable } from "../../__tests__/support/native-executable.js";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, ToolSchema } from "../../engine/llm/types.js";
import { ClaudeCodeConversationRuntime } from "../claude-code-conversation-runtime.js";
import {
  claudeCodeExecutableCandidates,
  ClaudeCodeSubscriptionClient,
  resolveClaudeCodeSubscriptionExecutable,
  missingClaudeCodeAuthCommands,
  parseClaudeCodeVersion,
} from "../claude-code-subscription-client.js";
import { CLAUDE_CODE_MAX_OUTPUT_BYTES } from "../claude-code-stream.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import * as managed from "../managed-child-processes.js";
import * as subscriptionClient from "../claude-code-subscription-client.js";
import * as executableLocation from "../codex-executable-location.js";
import { CodexExecutableLocationError } from "../codex-executable-location.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import { claudeCodeSubscriptionStatus } from "../../shared/claude-code-subscription.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../__tests__/support/native-executable.js")).maskFixtureAncestorAcl(await importOriginal()));

const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const HOST_TOOL = "mcp__ave-host-tools__read_project_file";
const TOOL: ToolSchema = {
  name: "read_project_file", description: "Read a file through the host",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const init = (tools: string[] = []) => ({ type: "system", subtype: "init", session_id: SESSION,
  tools, mcp_servers: tools.length ? [{ name: "ave-host-tools", status: "connected" }] : [], plugins: [] });
const assistant = (content: unknown[] = [{ type: "text", text: "hello" }]) => ({
  type: "assistant", session_id: SESSION, parent_tool_use_id: null, message: { content },
});
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false,
  result: "hello", session_id: SESSION, ...extra });
const auth = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = -1;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  input = "";
  constructor() { super(); this.stdin.on("data", (chunk) => { this.input += String(chunk); }); }
  send(event: unknown): void { this.stdout.write(`${JSON.stringify(event)}\n`); }
  close(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  dispose(): void { for (const stream of [this.stdin, this.stdout, this.stderr]) stream.destroy(); }
}

const roots: string[] = [];
const children: FakeChild[] = [];
const owners: Array<{ stop(): Promise<void> }> = [];
beforeEach(() => {
  // Block the complete tree-kill boundary, not just ChildProcess.kill: fake children must never trigger native PID discovery or process signalling.
  vi.spyOn(managed, "forceKillManagedChildProcess").mockImplementation((child) => { child.kill(); });
  vi.spyOn(managed, "spawnManaged").mockImplementation(() => { throw new Error("Unexpected real process launch"); });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const child of children.splice(0)) child.dispose();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function readyClientHarness() {
  return clientHarness((child, args) => {
    if (args[0] === "auth") child.send(auth);
    else { child.send(init()); child.send(result()); }
    child.close();
  });
}

async function paths() {
  const root = mkdtempSync(join(tmpdir(), "ave-claude-runtime-"));
  roots.push(root);
  normalizeFixtureAncestorPermissions(root);
  return {
    runtimeHome: await executableLocation.createPrivateDirectory(join(root, "home")),
    workspaceDir: await executableLocation.createPrivateDirectory(join(root, "workspace")),
    runtimeTempDir: await executableLocation.createPrivateDirectory(join(root, "tmp")),
  };
}

const QUALIFYING_AUTH_HELP = "Commands:\n  login [options]   Sign in\n  logout            Log out\n  status [options]  Show status\n";

interface Qualification {
  version?: string;
  authHelp?: string;
}

function isQualificationProbe(args: readonly string[]): boolean {
  return (args.length === 2 && args[0] === "--bare" && args[1] === "--version")
    || (args.length === 2 && args[0] === "auth" && args[1] === "--help");
}

// Fake CLI processes. With `qualification`, the discovery probes (`--bare --version`, `auth --help`) are answered here and recorded in `probes`, so
// `calls` and `started` describe only the account and chat commands a test drives.
function spawnHarness(
  script?: (child: FakeChild, args: readonly string[]) => void,
  qualification?: Qualification,
) {
  let ready!: (child: FakeChild) => void;
  const started = new Promise<FakeChild>((resolve) => { ready = resolve; });
  const calls: Array<{ child: FakeChild; args: readonly string[]; options: SpawnOptions }> = [];
  const probes: string[][] = [];
  const spawn = vi.fn((_command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild(); children.push(child);
    if (qualification && isQualificationProbe(args)) {
      probes.push([...args]);
      setImmediate(() => {
        const output = args.includes("--version")
          ? `${qualification.version ?? "2.1.0"} (Claude Code)\n`
          : qualification.authHelp ?? QUALIFYING_AUTH_HELP;
        child.stdout.write(output);
        child.close();
      });
      return child as unknown as ChildProcess;
    }
    calls.push({ child, args, options }); ready(child);
    if (script) setImmediate(() => script(child, args));
    return child as unknown as ChildProcess;
  });
  return { spawn, calls, started, probes };
}

async function conversation(tools: readonly ToolSchema[] = [], resolveExecutable?: (path: string) => Promise<string>) {
  const directories = await paths();
  const harness = spawnHarness();
  const bridge = new SubscriptionToolBridge(tools);
  vi.spyOn(bridge, "startMcpServer").mockResolvedValue({
    name: "ave-host-tools", command: "/host/mcp", args: [], env: { TEST_BRIDGE_TOKEN: "ephemeral-only" },
  });
  const runtime = new ClaudeCodeConversationRuntime({ ...directories, bridge, ...harness,
    resolveRuntime: async () => ({
      executable: await (resolveExecutable ?? (async (path: string) => path))("/approved/claude"),
      identity: "approved", verify: async () => {
        if (resolveExecutable && await resolveExecutable("/approved/claude") !== "/approved/claude") {
          throw new Error("Executable changed");
        }
      }, discard: async () => undefined,
    }) });
  owners.push(runtime);
  return { ...harness, ...directories, runtime, bridge };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// The turn's rejection reason, observed from the moment the turn starts. A test that fails while it drives the fake CLI then reports that failure alone,
// not also an unawaited assertion or an unhandled turn rejection.
function rejection(turn: Promise<unknown>): Promise<unknown> {
  return turn.then(
    (value) => { throw new Error(`Expected the turn to reject, but it resolved with ${JSON.stringify(value)}`); },
    (error: unknown) => error,
  );
}

describe("CLI conversation boundary", () => {
  it("retains native ancestor rules and reports a location rejection before spawning", async () => {
    const directories = await paths();
    const harness = spawnHarness();
    const validate = vi.spyOn(subscriptionClient, "validateClaudeCodeRuntimeDirectories").mockResolvedValue();
    const runtime = new ClaudeCodeConversationRuntime({ ...directories, ...harness, bridge: new SubscriptionToolBridge([]),
      resolveRuntime: async () => ({
        executable: "/approved/runtime", identity: "approved",
        verify: async () => { throw new CodexExecutableLocationError("Rejected fixture location"); },
        discard: async () => undefined,
      }),
    });
    owners.push(runtime);
    await expect(collect(runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-runtime-unsafe-location" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("keeps prompts off argv, disables built-ins, verifies result, and cleans its config", async () => {
    const h = await conversation();
    const done = collect(h.runtime.streamTurn("private prompt"));
    const child = await h.started;
    expect(child.input).toBe("private prompt");
    const { args, options } = h.calls[0]!;
    expect(args).not.toContain("private prompt");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("bypassPermissions");
    expect(options).toMatchObject({ cwd: h.workspaceDir, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.send(init()); child.send(assistant()); child.send(result()); child.close();
    expect(await done).toEqual([{ type: "text_delta", text: "hello" }, { type: "message_complete", stopReason: "end_turn" }]);
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
    // A closed root may still own a live descendant group. Its exact handle must reach the registry, which decides whether a group remains.
    expect(managed.forceKillManagedChildProcess).toHaveBeenCalledWith(child, "claude-code-turn-cancel");
  });

  it("reads stdout arriving after exit and a valid final frame without newline", async () => {
    const h = await conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init()); child.emit("exit", 0, null); child.send(assistant());
    child.stdout.write(JSON.stringify(result())); child.emit("close", 0, null);
    expect((await done).at(-1)).toEqual({ type: "message_complete", stopReason: "end_turn" });
  });

  it.each([
    ["empty output", []],
    ["missing result", [init(), assistant()]],
    ["errored assistant", [init(), { ...assistant(), error: "authentication_failed" }]],
    ["failed result", [init(), result({ subtype: "error_during_execution", is_error: true })]],
    ["missing is_error", [init(), result({ is_error: undefined })]],
    ["native tool", [init(), assistant([{ type: "tool_use", id: "call", name: "Bash", input: {} }])]],
    ["native catalog", [init(["Bash"])]],
    ["missing init", [result()]],
    ["session changed", [init(), result({ session_id: "another-session" })]],
    ["denied permission", [init(), result({ permission_denials: [{ tool_name: "Bash" }] })]],
    ["startup hook", [{ type: "system", subtype: "hook_started", session_id: SESSION }]],
    ["plugin", [{ ...init(), plugins: [{ name: "unexpected" }] }]],
    ["extra result", [init(), result(), result()]],
  ])("rejects %s instead of synthesizing success", async (name, records) => {
    const h = await conversation(); const failure = rejection(collect(h.runtime.streamTurn("hello")));
    const child = await h.started; for (const record of records) child.send(record); child.close();
    expect(await failure).toMatchObject({ code: ["native catalog", "plugin"].includes(name)
      ? "claude-code-runtime-incompatible" : "claude-code-operation-failed" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["not json\n", "{\"type\":", "garbage"]) ("rejects malformed tail %s after a valid result", async (tail) => {
    const h = await conversation(); const failure = rejection(collect(h.runtime.streamTurn("hello")));
    const child = await h.started; child.send(init()); child.send(result()); child.stdout.write(tail); child.close();
    expect(await failure).toMatchObject({ code: "claude-code-operation-failed" });
  });

  it("preserves split Unicode and refuses a truncated UTF-8 character", async () => {
    for (const invalid of [false, true]) {
      const h = await conversation(); const done = collect(h.runtime.streamTurn("hello"));
      const failure = invalid ? rejection(done) : null;
      const child = await h.started; child.send(init());
      const message = Buffer.from(`${JSON.stringify(assistant([{ type: "text", text: "한글" }]))}\n`);
      for (const byte of message) child.stdout.write(Buffer.from([byte]));
      child.send(result()); if (invalid) child.stdout.write(Buffer.from([0xed])); child.close();
      if (failure) expect(await failure).toMatchObject({ code: "claude-code-operation-failed" });
      else expect((await done)[0]).toEqual({ type: "text_delta", text: "한글" });
    }
  });

  it("only a validated bridge call produces a host tool event", async () => {
    const h = await conversation([TOOL]); const done = collect(h.runtime.streamTurn("read file")); const child = await h.started;
    const { args } = h.calls[0]!;
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", HOST_TOOL]);
    const config = args[args.indexOf("--mcp-config") + 1]!;
    expect(readFileSync(config, "utf8")).toContain("ephemeral-only");
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
    child.send(init([HOST_TOOL, "EndConversation"]));
    child.send(assistant([{ type: "tool_use", id: "announced", name: HOST_TOOL, input: { path: "a" } }]));
    expect(child.kill).not.toHaveBeenCalled();
    await h.bridge.invoke("read_project_file", { path: "a" });
    const events = await done;
    expect(events).toEqual([{ type: "tool_call", id: expect.any(String), name: "read_project_file", input: { path: "a" } },
      { type: "message_complete", stopReason: "tool_use" }]);
    expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
    await expect(h.bridge.invoke("read_project_file", { path: "b" })).rejects.toThrow();
  });

  it("does not treat an announced but uncalled MCP tool as completion", async () => {
    const h = await conversation([TOOL]); const failure = rejection(collect(h.runtime.streamTurn("read file")));
    const child = await h.started;
    child.send(init([HOST_TOOL])); child.send(assistant([{ type: "tool_use", id: "call", name: HOST_TOOL, input: {} }]));
    child.send(result()); child.close(); expect(await failure).toBeInstanceOf(Error);
  });

  it("allows the CLI termination control without turning it into a host call", async () => {
    const h = await conversation([TOOL]); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init([HOST_TOOL, "EndConversation"]));
    child.send(assistant([{ type: "tool_use", id: "end", name: "EndConversation", input: {} }]));
    child.send(result({ result: "" })); child.close(); expect(await done).toEqual([{ type: "message_complete", stopReason: "end_turn" }]);
  });

  it("rejects a second stream, cancels the first, and drops late output", async () => {
    const h = await conversation(); const controller = new AbortController();
    const failure = rejection(collect(h.runtime.streamTurn("hello", controller.signal)));
    const child = await h.started;
    await expect(collect(h.runtime.streamTurn("concurrent"))).rejects.toThrow();
    controller.abort(); child.send(init()); child.send(result()); expect(await failure).toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not spawn after cancellation during asynchronous executable validation", async () => {
    let release!: (path: string) => void;
    const ready = new Promise<string>((resolve) => { release = resolve; });
    const h = await conversation([], () => ready); const controller = new AbortController();
    const failure = rejection(collect(h.runtime.streamTurn("hello", controller.signal)));
    controller.abort(); release("/approved/claude"); expect(await failure).toMatchObject({ name: "AbortError" });
    expect(h.spawn).not.toHaveBeenCalled(); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["stdin", "stdout", "stderr", "process"])("owns %s errors and cleanup", async (surface) => {
    const h = await conversation(); const failure = rejection(collect(h.runtime.streamTurn("hello")));
    const child = await h.started;
    const target: EventEmitter = surface === "process" ? child : child[surface as "stdin" | "stdout" | "stderr"];
    target.emit("error", new Error("private failure"));
    expect(await failure).toBeInstanceOf(Error); expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("bounds actual combined output bytes and queued events", async () => {
    for (const flood of ["bytes", "events"]) {
      const h = await conversation(); const failure = rejection(collect(h.runtime.streamTurn("hello")));
      const child = await h.started; child.send(init());
      if (flood === "bytes") child.stderr.write(Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
      else for (let index = 0; index < 300; index++) child.send(assistant());
      expect(await failure).toBeInstanceOf(Error); expect(child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects unsupported attachments before creating a process", async () => {
    const h = await conversation(); await expect(collect(h.runtime.streamTurn("hello", undefined, [{}])))
      .rejects.toMatchObject({ code: "subscription-attachment-not-supported" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("cancels timed-out children through the owned process boundary", async () => {
    vi.useFakeTimers();
    const h = await conversation(); const failure = rejection(collect(h.runtime.streamTurn("hello")));
    const child = await h.started; vi.advanceTimersByTime(TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
    expect(await failure).toBeInstanceOf(Error); expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not replay a native session when supplied the next full history envelope", async () => {
    const h = await conversation();
    for (const text of ["complete history: first request", "complete history: first request, first answer, second request"]) {
      const completed = collect(h.runtime.streamTurn(text));
      await vi.waitFor(() => expect(h.calls.at(-1)?.child.input).toBe(text), NATIVE_LOCATION_WAIT);
      const call = h.calls.at(-1)!; call.child.send(init()); call.child.send(result()); call.child.close(); await completed;
      expect(call.args).not.toContain("--resume"); expect(call.args).toContain("--no-session-persistence");
      expect(call.child.input).toBe(text);
    }
  });

  it("aborts buffered output even after the process completed", async () => {
    const h = await conversation(); const controller = new AbortController();
    const iterator = h.runtime.streamTurn("hello", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next(); const child = await h.started;
    child.send(init()); child.send(assistant()); child.send(result()); child.close(); await first;
    controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cleans a config and handler when spawn throws", async () => {
    const h = await conversation(); h.spawn.mockImplementationOnce(() => { throw new Error("private spawn path"); });
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("preserves terminal-only text and the provider's length stop", async () => {
    const h = await conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init()); child.send(result({ result: "actual final text", stop_reason: "max_tokens" })); child.close();
    expect(await done).toEqual([{ type: "text_delta", text: "actual final text" }, { type: "message_complete", stopReason: "max_tokens" }]);
  });

  it("refuses an executable whose canonical target changed", async () => {
    const h = await conversation([], async () => "/replacement/claude");
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

// An installed `claude`, and the one place this client is told to look.
function installedCli(root: string, install = true): { executable: string; candidates: () => string[] } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "claude");
  if (install) writeCli(executable);
  return { executable, candidates: () => [join(root, "missing", "claude"), executable] };
}

async function pinForTest(executable: string): Promise<ClaudeCodeExecutable> {
  const hash = () => createHash("sha256").update(readFileSync(executable)).digest("hex");
  const identity = hash();
  return { executable, identity, verify: async () => {
    if (hash() !== identity) throw new Error("Executable changed");
  }, discard: async () => undefined };
}

function writeCli(path: string, body = "#!/bin/sh\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function clientHarness(
  script: (child: FakeChild, args: readonly string[]) => void,
  qualification: Qualification = {},
) {
  const directories = await paths(); const harness = spawnHarness(script, qualification);
  const cli = installedCli(directories.runtimeHome);
  const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
    candidates: cli.candidates, resolveExecutable: async (path) => path, _pinExecutableForTest: pinForTest });
  owners.push(client); return { ...directories, ...harness, ...cli, client };
}

describe("CLI account and verification boundary", () => {
  it("classifies the documented logged-out exit 1 as signed out", async () => {
    const h = await clientHarness((child) => { child.send({ loggedIn: false }); child.close(1); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "signed-out" });
    expect(managed.forceKillManagedChildProcess).toHaveBeenCalledWith(h.calls[0]!.child, "claude-code-command-complete");
  });

  it.each([
    ["API key", { ...auth, authMethod: "api_key" }, 0],
    ["unknown auth", { loggedIn: true }, 0],
    ["missing subscription", { ...auth, subscriptionType: null }, 0],
    ["inconsistent exit", auth, 1],
    ["malformed JSON", "not-json", 0],
  ])("does not claim connected for %s", async (_name, payload, code) => {
    const h = await clientHarness((child) => { child.send(payload); child.close(code); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("does not parse credential-bearing stderr as an auth response", async () => {
    const h = await clientHarness((child) => { child.stderr.write(JSON.stringify(auth)); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("detects and verifies a connected account without any model prompt or account-home capability probe", async () => {
    const h = await clientHarness((child, args) => {
      expect(args).toEqual(["auth", "status"]);
      child.send(auth);
      child.close();
    });
    const spawn = h.spawn.getMockImplementation()!;
    h.spawn.mockImplementation((command, args, options) => {
      if (isQualificationProbe(args)) {
        const home = options.env!.HOME!;
        expect(home).not.toBe(h.runtimeHome);
        expect(home.startsWith(join(h.runtimeTempDir, "probe-"))).toBe(true);
        expect(options.env!.CLAUDE_CONFIG_DIR).toBe(home);
        expect(readdirSync(home)).toEqual([]);
        if (process.platform !== "win32") expect(statSync(home).mode & 0o777).toBe(0o700);
      }
      return spawn(command, args, options);
    });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "connected" });
    expect(await h.client.verify()).toMatchObject({ runtime: "ready", connection: "connected", version: "2.1.0" });
    expect(h.probes).toEqual([["--bare", "--version"], ["auth", "--help"]]);
    for (const [, args, options] of h.spawn.mock.calls) {
      expect(args).not.toContain("-p"); expect(args).not.toContain("--print");
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    }
    for (const call of h.calls) {
      expect(call.args).toEqual(["auth", "status"]);
      expect(call.options.env!.HOME).toBe(h.runtimeHome);
      expect(call.child.input).toBe("");
    }
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not retain verification after the account signs out", async () => {
    let loggedIn = true;
    const h = await clientHarness((child) => {
      child.send(loggedIn ? auth : { loggedIn: false }); child.close(loggedIn ? 0 : 1);
    });
    await h.client.verify();
    loggedIn = false;
    expect(await h.client.verify()).toMatchObject({ runtime: "unverified", connection: "signed-out" });
    await expect(h.client.verifiedRuntime()).rejects.toMatchObject({ code: "claude-code-runtime-unverified" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["none", "directories", "artifact"] as const)(
    "admits directories and verifies the executable before sign-in (%s rejected)",
    async (rejected) => {
      const directories = await paths();
      const harness = spawnHarness((child) => { child.send({ loggedIn: false }); child.close(1); }, {});
      const cli = installedCli(directories.runtimeHome);
      const events: string[] = [];
      let preparingLogin = false;
      const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
        candidates: cli.candidates, resolveExecutable: async (path) => path,
        _pinExecutableForTest: async (path) => {
          const artifact = await pinForTest(path);
          return { ...artifact, verify: async () => {
            if (preparingLogin) {
              events.push("artifact");
              if (rejected === "artifact") throw new Error("Rejected executable");
            }
            await artifact.verify();
          } };
        },
      });
      owners.push(client);
      expect(await client.getStatus()).toMatchObject({ runtime: "unverified", connection: "signed-out" });
      events.length = 0;
      const directoryRequests: string[][] = [];
      const assertLocations = executableLocation.assertCodexLocations;
      vi.spyOn(executableLocation, "assertCodexLocations").mockImplementation(async (requests, trustInputs) => {
        if (requests.length > 0 && requests.every((request) => request.kind === "private-directory")) {
          events.push("directories");
          preparingLogin = true;
          directoryRequests.push(requests.map((request) => request.path));
          if (rejected === "directories") throw new CodexExecutableLocationError("Rejected directories");
        }
        await assertLocations(requests, trustInputs);
      });
      const spawn = harness.spawn.getMockImplementation()!;
      harness.spawn.mockImplementation((command, args, options) => {
        events.push("spawn");
        return spawn(command, args, options);
      });
      harness.spawn.mockClear();
      harness.calls.length = 0;
      if (rejected === "none") {
        expect(await client.startBrowserLogin()).toMatchObject({ connection: "pending" });
        expect(events).toEqual(["directories", "artifact", "spawn"]);
        expect(harness.spawn).toHaveBeenCalledOnce();
        expect(harness.calls).toHaveLength(1);
        expect(harness.calls[0]!.args).toEqual(["auth", "login"]);
        await expect(client.verifiedRuntime()).rejects.toMatchObject({ code: "claude-code-runtime-unverified" });
      } else {
        await expect(client.startBrowserLogin()).rejects.toMatchObject({ code: rejected === "directories"
          ? "claude-code-runtime-unsafe-location" : "claude-code-runtime-unverified" });
        expect(events).toEqual(rejected === "directories" ? ["directories"] : ["directories", "artifact"]);
        expect(harness.spawn).not.toHaveBeenCalled();
        expect(harness.calls).toHaveLength(0);
      }
      expect(directoryRequests).toEqual([[directories.runtimeHome, directories.workspaceDir, directories.runtimeTempDir]]);
    },
  );

  it("stop cancels captured commands and prevents future launches", async () => {
    const h = await clientHarness(() => undefined); const pending = h.client.getStatus(); const child = await h.started;
    await h.client.stop(); expect(await pending).toMatchObject({ runtime: "unavailable" });
    await expect(h.client.verify()).rejects.toThrow(); expect(h.calls).toHaveLength(1); expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid captured UTF-8 rather than replacing protocol bytes", async () => {
    const h = await clientHarness((child) => { child.stdout.write(Buffer.from([0xed])); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("opens a complete trusted login URL once and ignores cancelled output", async () => {
    const directories = await paths(); const h = spawnHarness(undefined, {}); const openAuthorizationUrl = vi.fn();
    const cli = installedCli(directories.runtimeHome);
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...h, candidates: cli.candidates,
      resolveExecutable: async (path) => path, _pinExecutableForTest: pinForTest, openAuthorizationUrl }); owners.push(client);
    await client.startBrowserLogin(); const child = await h.started;
    expect(h.calls[0]!.args).toEqual(["auth", "login"]);
    child.stdout.write("See https://untrusted.invalid/help\nhttps://user:secret@claude.ai/oauth\n");
    child.stdout.write("https://claude.ai/oauth/"); await Promise.resolve(); expect(openAuthorizationUrl).not.toHaveBeenCalled();
    child.stdout.write("authorize?code=private\n"); await Promise.resolve();
    child.stderr.write("https://claude.ai/oauth/authorize?code=second\n"); await Promise.resolve();
    expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
    const login = openAuthorizationUrl.mock.calls[0][1] as import("../oauth-login.js").OAuthLoginOptions;
    await client.stop(); child.stdout.write("https://claude.ai/oauth/authorize?code=late\n");
    await expect(login.completion).resolves.toBeUndefined();
    await Promise.resolve(); expect(openAuthorizationUrl).toHaveBeenCalledTimes(1);
  });

  it("terminates the CLI and reports failure when its login window cancels", async () => {
    const directories = await paths();
    const h = spawnHarness(undefined, {});
    const openAuthorizationUrl = vi.fn();
    const cli = installedCli(directories.runtimeHome);
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...h, candidates: cli.candidates,
      resolveExecutable: async (path) => path, _pinExecutableForTest: pinForTest, openAuthorizationUrl });
    owners.push(client);
    await client.startBrowserLogin();
    const child = await h.started;
    child.stdout.write("https://claude.ai/oauth/authorize?state=cancel\n");
    await vi.waitFor(() => expect(openAuthorizationUrl).toHaveBeenCalledOnce());
    const login = openAuthorizationUrl.mock.calls[0][1] as import("../oauth-login.js").OAuthLoginOptions;
    login.onCancel();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-login-failed" });
  });
});

describe("Claude Code CLI discovery", () => {
  it.runIf(process.platform === "win32")("refuses an earlier package shim without selecting a later native executable", async () => {
    const directories = await paths();
    const npm = join(directories.runtimeHome, "npm");
    const native = join(directories.runtimeHome, "native");
    mkdirSync(npm); mkdirSync(native);
    const executable = join(native, "claude.exe");
    writeCli(join(npm, "claude.cmd")); writeNativeExecutable(executable);
    const harness = spawnHarness((child) => { child.send({ loggedIn: false }); child.close(1); }, {});
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
      candidates: () => claudeCodeExecutableCandidates({ platform: "win32", env: { PATH: `${npm};${native}` }, homeDir: directories.runtimeHome }),
      resolveExecutable: async (path) => path });
    owners.push(client);
    await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-native-required" });
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(readdirSync(directories.runtimeTempDir)).toEqual([]);
  });

  it("preserves directory precedence when enumerating native and package launchers", () => {
    const candidates = claudeCodeExecutableCandidates({ platform: "win32",
      env: { PATH: "C:\\npm;C:\\native", USERPROFILE: "C:\\Users\\example", APPDATA: "C:\\Users\\example\\AppData\\Roaming" },
      homeDir: "C:\\Users\\example" });
    expect(candidates.indexOf("C:\\npm\\claude.cmd")).toBeLessThan(candidates.indexOf("C:\\native\\claude.exe"));
    expect(candidates.indexOf("C:\\npm\\claude.cmd")).toBeLessThan(candidates.indexOf("C:\\Users\\example\\.local\\bin\\claude.exe"));
  });

  async function discoveryHarness(qualification: Qualification = {}, install = true) {
    const directories = await paths();
    const harness = spawnHarness((child) => { child.send({ loggedIn: false }); child.close(1); }, qualification);
    const cli = installedCli(directories.runtimeHome, install);
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
      candidates: cli.candidates, resolveExecutable: async (path) => path, _pinExecutableForTest: pinForTest });
    owners.push(client);
    return { ...directories, ...harness, ...cli, client };
  }

  it("looks on PATH first, then in the official install locations", () => {
    expect(claudeCodeExecutableCandidates({
      platform: "darwin", env: { PATH: "/opt/tools:relative/bin:/usr/bin" }, homeDir: "/Users/example",
    })).toEqual([
      "/opt/tools/claude",
      "/usr/bin/claude",
      "/Users/example/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(claudeCodeExecutableCandidates({
      platform: "win32", env: { Path: "C:\\Tools;relative", USERPROFILE: "C:\\Users\\example" }, homeDir: "C:\\ignored",
    })).toEqual(["C:\\Tools\\claude.exe", "C:\\Tools\\claude.cmd", "C:\\Users\\example\\.local\\bin\\claude.exe"]);
  });

  it("checks the runtime version identity and advertised auth commands", () => {
    expect(parseClaudeCodeVersion("2.1.303 (Claude Code)\n")).toBe("2.1.303");
    expect(parseClaudeCodeVersion("claude 2.1.303\n")).toBeNull();
    expect(missingClaudeCodeAuthCommands(QUALIFYING_AUTH_HELP)).toEqual([]);
    expect(missingClaudeCodeAuthCommands("Commands:\n  login\n  status\n")).toEqual(["logout"]);
  });

  it("reports a missing CLI as not configured without running anything", async () => {
    const h = await discoveryHarness({}, false);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "not-configured" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("finds a CLI installed after it reported none, without being pointed at it", async () => {
    const h = await discoveryHarness({}, false);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "not-configured" });
    writeCli(h.executable);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "signed-out", version: "2.1.0" });
  });

  it("probes a found CLI once and again only when the file changes", async () => {
    const h = await discoveryHarness();
    await h.client.getStatus();
    await h.client.getStatus();
    expect(h.probes).toEqual([["--bare", "--version"], ["auth", "--help"]]);
    writeCli(h.executable, "#!/bin/sh\n# updated\n");
    await h.client.getStatus();
    expect(h.probes).toHaveLength(4);
  });

  it.each<[string, Qualification, boolean]>([
    ["is not Claude Code", {}, true],
    ["lacks an auth command", { authHelp: "Commands:\n  login\n  status\n" }, false],
  ])("reports a CLI that %s as incompatible and remembers that verdict", async (_name, qualification, foreignVersion) => {
    const h = await discoveryHarness(qualification);
    if (foreignVersion) {
      // A version line in another format is not Claude Code's.
      h.spawn.mockImplementationOnce((_command, args) => {
        const child = new FakeChild(); children.push(child); h.probes.push([...args]);
        setImmediate(() => { child.stdout.write("claude 9.9.9\n"); child.close(); });
        return child as unknown as ChildProcess;
      });
    }
    await expect(h.client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-incompatible" });
    // The error response still describes the card: the CLI is there but unusable.
    expect(h.client.getCachedStatus()).toMatchObject({
      runtime: "unavailable",
      version: foreignVersion ? null : "2.1.0",
    });
    const probed = h.probes.length;
    await expect(h.client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-incompatible" });
    expect(h.probes).toHaveLength(probed);
    expect(h.calls).toEqual([]);
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("reports a CLI whose probe exits non-zero as incompatible, not as a failed operation", async () => {
    // An old CLI without an `auth` subcommand answers `auth --help` with an error.
    const h = await discoveryHarness();
    h.spawn.mockImplementation((_command, args) => {
      const child = new FakeChild(); children.push(child); h.probes.push([...args]);
      setImmediate(() => {
        if (args.includes("--version")) child.stdout.write("1.0.3 (Claude Code)\n");
        child.close(args[0] === "auth" ? 1 : 0);
      });
      return child as unknown as ChildProcess;
    });
    await expect(h.client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-incompatible" });
    expect(h.client.getCachedStatus()).toMatchObject({ runtime: "unavailable", version: "1.0.3" });
  });

  // POSIX execute bits decide "runnable" here; Windows admits only a native `.exe`.
  it.runIf(process.platform !== "win32")("passes over an entry that is not a runnable file, as a shell would", async () => {
    const directories = await paths();
    const harness = spawnHarness((child) => { child.send({ loggedIn: false }); child.close(1); }, {});
    const cli = installedCli(directories.runtimeHome);
    const broken = join(directories.runtimeHome, "stale", "claude");
    mkdirSync(join(directories.runtimeHome, "stale"), { recursive: true });
    writeFileSync(broken, "not runnable");
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
      candidates: () => [broken, cli.executable],
      resolveExecutable: (path) => resolveClaudeCodeSubscriptionExecutable(path), _pinExecutableForTest: pinForTest });
    owners.push(client);
    expect(await client.getStatus()).toMatchObject({ runtime: "unverified", version: "2.1.0" });
    expect(harness.spawn).toHaveBeenCalledWith(cli.executable, expect.anything(), expect.anything());
    expect(harness.spawn).not.toHaveBeenCalledWith(expect.stringContaining("stale"), expect.anything(), expect.anything());
  });

  it("asks again after a probe that could not run", async () => {
    const h = await discoveryHarness();
    h.spawn.mockImplementationOnce((_command, args) => {
      const child = new FakeChild(); children.push(child); h.probes.push([...args]);
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child as unknown as ChildProcess;
    });
    await expect(h.client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-unavailable" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", version: "2.1.0" });
  });

  it("requires fresh admission when the qualified source changes", async () => {
    const h = await readyClientHarness();
    await expect(h.client.verifiedRuntime()).rejects.toMatchObject({ code: "claude-code-runtime-unverified" });
    await h.client.verify();
    await expect(h.client.verifiedRuntime()).resolves.toMatchObject({ executable: h.executable });
    writeCli(h.executable, "#!/bin/sh\n# reinstalled\n");
    // An auto-update is a different file: chat asks for a new verification.
    await expect(h.client.verifiedRuntime()).rejects.toMatchObject({ code: "claude-code-runtime-unverified" });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified" });
  });

  it("does not require a complete help inventory or a model response before chat", async () => {
    const h = await readyClientHarness();
    await h.client.verify();
    expect(h.probes).not.toContainEqual(["--help"]);
    expect(h.calls.every((call) => call.args[0] === "auth")).toBe(true);
    await expect(h.client.verifiedRuntime()).resolves.toMatchObject({ executable: h.executable });
  });

  it("reports unsupported startup options on the first real turn without a synthetic model request", async () => {
    const h = await clientHarness((child, args) => {
      if (args[0] === "auth") { child.send(auth); child.close(); }
      else { child.stderr.write("error: unknown op"); child.stderr.write("tion '--strict-mcp-config'\n"); child.close(1); }
    });
    await h.client.verify();
    expect(h.calls.every((call) => call.args[0] === "auth")).toBe(true);
    const artifact = await h.client.verifiedRuntime();
    const runtime = new ClaudeCodeConversationRuntime({ ...h.client.getRuntimePaths(), ...h,
      bridge: new SubscriptionToolBridge([]), resolveRuntime: async () => artifact });
    owners.push(runtime);
    await expect(collect(runtime.streamTurn("the user's first actual request")))
      .rejects.toMatchObject({ code: "claude-code-runtime-incompatible" });
    const turns = h.calls.filter((call) => call.args[0] === "-p");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.child.input).toBe("the user's first actual request");
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("refuses the next turn when the verified file is replaced during a session", async () => {
    const h = await readyClientHarness();
    await h.client.verify();
    const executable = await h.client.verifiedRuntime();
    const runtime = new ClaudeCodeConversationRuntime({ ...h.client.getRuntimePaths(), ...h,
      bridge: new SubscriptionToolBridge([]), resolveRuntime: async () => executable });
    owners.push(runtime);
    await collect(runtime.streamTurn("first"));
    const before = h.spawn.mock.calls.length;
    const stat = statSync(h.executable);
    writeCli(h.executable, "#!/bin/zz\n");
    utimesSync(h.executable, stat.atime, stat.mtime);
    await expect(collect(runtime.streamTurn("second"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(h.spawn).toHaveBeenCalledTimes(before);
  });

  it("checks the real private artifact and source before the next session turn", async () => {
    vi.spyOn(authenticity, "authenticateClaudeCodeExecutable").mockResolvedValue();
    const directories = await paths();
    normalizeFixtureAncestorPermissions(directories.runtimeHome);
    const source = writeNativeExecutable(join(directories.runtimeHome, "installed", "claude"));
    const executable = await pinClaudeCodeExecutable(source, directories.runtimeHome,
      { platform: process.platform, env: {}, homeDir: directories.runtimeHome });
    owners.push({ stop: executable.discard });
    const h = spawnHarness((child) => { child.send(init()); child.send(result()); child.close(); });
    const runtime = new ClaudeCodeConversationRuntime({ ...directories, ...h, bridge: new SubscriptionToolBridge([]),
      resolveRuntime: async () => executable });
    owners.push(runtime);
    await collect(runtime.streamTurn("first"));
    const calls = h.spawn.mock.calls.length;
    const stat = statSync(source);
    const bytes = readFileSync(source); bytes[bytes.length - 1] = 1;
    writeFileSync(source, bytes); utimesSync(source, stat.atime, stat.mtime);
    await expect(collect(runtime.streamTurn("second"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(h.spawn).toHaveBeenCalledTimes(calls);
  });

  it.skipIf(process.platform === "win32").each(["runtimeHome", "workspaceDir", "runtimeTempDir"] as const)(
    "refuses a session turn after the %s loses its private permissions", async (directory) => {
      const h = await conversation();
      chmodSync(h[directory], 0o777);
      await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-runtime-unsafe-location" });
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );

  it("discards private copies after retryable qualification failures", NATIVE_PROBE_HEAVY_TEST, async () => {
    vi.spyOn(authenticity, "authenticateClaudeCodeExecutable").mockResolvedValue();
    const directories = await paths();
    normalizeFixtureAncestorPermissions(directories.runtimeHome);
    const executable = writeNativeExecutable(join(directories.runtimeHome, "installed", process.platform === "win32" ? "claude.exe" : "claude"));
    const spawn = vi.fn(() => {
      const child = new FakeChild(); children.push(child);
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child as unknown as ChildProcess;
    });
    const client = new ClaudeCodeSubscriptionClient({ ...directories, spawn, env: {}, candidates: () => [executable] });
    owners.push(client);
    for (let retry = 0; retry < 3; retry++) {
      await expect(client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-unavailable" });
      expect(readdirSync(directories.runtimeHome).filter((name) => name.startsWith("executable-"))).toEqual([]);
    }
  });

  it("has no way to set or clear a path", async () => {
    const h = await discoveryHarness();
    expect("setExecutable" in h.client).toBe(false);
    expect("clearExecutable" in h.client).toBe(false);
  });
});

describe("Claude service integration", () => {
  it.each([
    ["failed result", "subscription-operation-failed"],
    ["unsupported startup", "subscription-runtime-incompatible"],
    ["unsupported catalog", "subscription-runtime-incompatible"],
    ["provider startup", "subscription-operation-failed"],
  ])("revokes %s and re-verifies before the next session", async (failure, code) => {
    const directories = await paths(); const h = spawnHarness(); const audit = vi.fn();
    const namespace: FeatureNamespaceHandle = {
      dir: directories.runtimeHome,
      async childDir(name) { const path = join(directories.runtimeHome, name); mkdirSync(path, { recursive: true }); return path; },
      async readJson(_name, fallback) { return fallback; }, async writeJson() {},
    };
    const status = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0");
    const verify = vi.fn(async () => status);
    const client = {
      getStatus: vi.fn(async () => status), verify, verifiedRuntime: async () => ({ executable: "/approved/claude", identity: "approved", verify: async () => undefined }),
      getRuntimePaths: () => directories, stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace, audit, claudeCodeClient: client,
      codexClient: { stop: vi.fn() } as unknown as CodexAppServerClient,
      acpRegistry: { stopAll: vi.fn() } as unknown as AcpSubscriptionRuntimeRegistry,
      createClaudeCodeConversationRuntime: (options) => new ClaudeCodeConversationRuntime({ ...options, ...h }),
    });
    owners.push(service);
    await service.verify("claude-code");
    const session = await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    const failed = rejection(collect(session.streamTurn("hello")));
    const child = await h.started;
    if (failure === "unsupported startup") { child.stderr.write("error: unknown option '--strict-mcp-config'\n"); child.close(1); }
    else if (failure === "provider startup") { child.stderr.write("Error: service unavailable\n"); child.close(1); }
    else if (failure === "unsupported catalog") child.send(init(["Bash"]));
    else { child.send(init()); child.send(result({ is_error: true })); child.close(); }
    expect(await failed).toMatchObject({ code });
    expect(audit).toHaveBeenCalledExactlyOnceWith({ provider: "claude-code", outcome: "session-failed" });
    expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
    await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
