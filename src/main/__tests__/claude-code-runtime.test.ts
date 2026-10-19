import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, ToolSchema } from "../../engine/llm/types.js";
import { ClaudeCodeConversationRuntime } from "../claude-code-conversation-runtime.js";
import {
  claudeCodeExecutableCandidates,
  ClaudeCodeSubscriptionClient,
  missingClaudeCodeAuthCommands,
  missingClaudeCodeOptions,
  parseClaudeCodeVersion,
} from "../claude-code-subscription-client.js";
import { CLAUDE_CODE_MAX_OUTPUT_BYTES, claudeCodeRequiredOptions } from "../claude-code-stream.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import * as managed from "../managed-child-processes.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import { claudeCodeSubscriptionStatus } from "../../shared/claude-code-subscription.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

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
  // Block the complete tree-kill boundary, not just ChildProcess.kill: fake
  // children must never trigger native PID discovery or process signalling.
  vi.spyOn(managed, "forceKillManagedChildProcess").mockImplementation((child) => { child.kill(); });
  vi.spyOn(managed, "spawnManaged").mockImplementation(() => { throw new Error("Unexpected real process launch"); });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const child of children.splice(0)) child.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function paths() {
  const root = mkdtempSync(join(tmpdir(), "ave-claude-runtime-"));
  roots.push(root);
  const value = { runtimeHome: join(root, "home"), workspaceDir: join(root, "workspace"), runtimeTempDir: join(root, "tmp") };
  for (const path of Object.values(value)) mkdirSync(path, { mode: 0o700 });
  return value;
}

/** `claude --help` as a qualifying CLI prints it: two-space indent, aliases first. */
const QUALIFYING_HELP = `Usage: claude [options]\n\nOptions:\n${claudeCodeRequiredOptions()
  .map((option) => option === "--print" ? "  -p, --print   Print response" : `  ${option} <value>   described`).join("\n")}\n`;
const QUALIFYING_AUTH_HELP = "Commands:\n  login [options]   Sign in\n  logout            Log out\n  status [options]  Show status\n";

interface Qualification {
  version?: string;
  help?: string;
  authHelp?: string;
}

function isQualificationProbe(args: readonly string[]): boolean {
  return (args.length === 1 && (args[0] === "--version" || args[0] === "--help"))
    || (args.length === 2 && args[0] === "auth" && args[1] === "--help");
}

/**
 * Fake CLI processes. With `qualification`, the discovery probes
 * (`--version`, `--help`, `auth --help`) are answered here and recorded in
 * `probes`, so `calls` and `started` describe only the account and chat
 * commands a test drives.
 */
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
        const output = args[0] === "--version"
          ? `${qualification.version ?? "2.1.0"} (Claude Code)\n`
          : args[0] === "--help" ? qualification.help ?? QUALIFYING_HELP : qualification.authHelp ?? QUALIFYING_AUTH_HELP;
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

function conversation(tools: readonly ToolSchema[] = [], resolveExecutable?: (path: string) => Promise<string>) {
  const directories = paths();
  const harness = spawnHarness();
  const bridge = new SubscriptionToolBridge(tools);
  vi.spyOn(bridge, "startMcpServer").mockResolvedValue({
    name: "ave-host-tools", command: "/host/mcp", args: [], env: { TEST_BRIDGE_TOKEN: "ephemeral-only" },
  });
  const runtime = new ClaudeCodeConversationRuntime({ ...directories, bridge, ...harness,
    executablePath: "/approved/claude", resolveExecutable: resolveExecutable ?? (async (path) => path) });
  owners.push(runtime);
  return { ...harness, ...directories, runtime, bridge };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("CLI conversation boundary", () => {
  it("keeps prompts off argv, disables built-ins, verifies result, and cleans its config", async () => {
    const h = conversation();
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
    // A closed root may still own a live descendant group. Its exact handle
    // must reach the registry, which decides whether a group remains.
    expect(managed.forceKillManagedChildProcess).toHaveBeenCalledWith(child, "claude-code-turn-cancel");
  });

  it("reads stdout arriving after exit and a valid final frame without newline", async () => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
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
  ])("rejects %s instead of synthesizing success", async (_name, records) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
    const expected = expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    const child = await h.started; for (const record of records) child.send(record); child.close();
    await expected; expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["not json\n", "{\"type\":", "garbage"]) ("rejects malformed tail %s after a valid result", async (tail) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
    const expected = expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    const child = await h.started; child.send(init()); child.send(result()); child.stdout.write(tail); child.close();
    await expected;
  });

  it("preserves split Unicode and refuses a truncated UTF-8 character", async () => {
    for (const invalid of [false, true]) {
      const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
      const expected = invalid ? expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" }) : null;
      const child = await h.started; child.send(init());
      const message = Buffer.from(`${JSON.stringify(assistant([{ type: "text", text: "한글" }]))}\n`);
      for (const byte of message) child.stdout.write(Buffer.from([byte]));
      child.send(result()); if (invalid) child.stdout.write(Buffer.from([0xed])); child.close();
      if (expected) await expected;
      else expect((await done)[0]).toEqual({ type: "text_delta", text: "한글" });
    }
  });

  it("only a validated bridge call produces a host tool event", async () => {
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("read file")); const child = await h.started;
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
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("read file"));
    const expected = expect(done).rejects.toThrow(); const child = await h.started;
    child.send(init([HOST_TOOL])); child.send(assistant([{ type: "tool_use", id: "call", name: HOST_TOOL, input: {} }]));
    child.send(result()); child.close(); await expected;
  });

  it("allows the CLI termination control without turning it into a host call", async () => {
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init([HOST_TOOL, "EndConversation"]));
    child.send(assistant([{ type: "tool_use", id: "end", name: "EndConversation", input: {} }]));
    child.send(result({ result: "" })); child.close(); expect(await done).toEqual([{ type: "message_complete", stopReason: "end_turn" }]);
  });

  it("rejects a second stream, cancels the first, and drops late output", async () => {
    const h = conversation(); const controller = new AbortController();
    const done = collect(h.runtime.streamTurn("hello", controller.signal)); const expected = expect(done).rejects.toMatchObject({ name: "AbortError" });
    const child = await h.started;
    await expect(collect(h.runtime.streamTurn("concurrent"))).rejects.toThrow();
    controller.abort(); child.send(init()); child.send(result()); await expected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not spawn after cancellation during asynchronous executable validation", async () => {
    let release!: (path: string) => void;
    const ready = new Promise<string>((resolve) => { release = resolve; });
    const h = conversation([], () => ready); const controller = new AbortController();
    const done = collect(h.runtime.streamTurn("hello", controller.signal)); const expected = expect(done).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); release("/approved/claude"); await expected;
    expect(h.spawn).not.toHaveBeenCalled(); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["stdin", "stdout", "stderr", "process"])("owns %s errors and cleanup", async (surface) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
    const child = await h.started;
    const target: EventEmitter = surface === "process" ? child : child[surface as "stdin" | "stdout" | "stderr"];
    target.emit("error", new Error("private failure"));
    await expected; expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("bounds actual combined output bytes and queued events", async () => {
    for (const flood of ["bytes", "events"]) {
      const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
      const child = await h.started; child.send(init());
      if (flood === "bytes") child.stderr.write(Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
      else for (let index = 0; index < 300; index++) child.send(assistant());
      await expected; expect(child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects unsupported attachments before creating a process", async () => {
    const h = conversation(); await expect(collect(h.runtime.streamTurn("hello", undefined, [{}])))
      .rejects.toMatchObject({ code: "subscription-attachment-not-supported" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("cancels timed-out children through the owned process boundary", async () => {
    vi.useFakeTimers();
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
    const child = await h.started; vi.advanceTimersByTime(TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
    await expected; expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not replay a native session when supplied the next full history envelope", async () => {
    const h = conversation();
    for (const text of ["complete history: first request", "complete history: first request, first answer, second request"]) {
      const completed = collect(h.runtime.streamTurn(text));
      await vi.waitFor(() => expect(h.calls.at(-1)?.child.input).toBe(text));
      const call = h.calls.at(-1)!; call.child.send(init()); call.child.send(result()); call.child.close(); await completed;
      expect(call.args).not.toContain("--resume"); expect(call.args).toContain("--no-session-persistence");
      expect(call.child.input).toBe(text);
    }
  });

  it("aborts buffered output even after the process completed", async () => {
    const h = conversation(); const controller = new AbortController();
    const iterator = h.runtime.streamTurn("hello", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next(); const child = await h.started;
    child.send(init()); child.send(assistant()); child.send(result()); child.close(); await first;
    controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cleans a config and handler when spawn throws", async () => {
    const h = conversation(); h.spawn.mockImplementationOnce(() => { throw new Error("private spawn path"); });
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("preserves terminal-only text and the provider's length stop", async () => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init()); child.send(result({ result: "actual final text", stop_reason: "max_tokens" })); child.close();
    expect(await done).toEqual([{ type: "text_delta", text: "actual final text" }, { type: "message_complete", stopReason: "max_tokens" }]);
  });

  it("refuses an executable whose canonical target changed", async () => {
    const h = conversation([], async () => "/replacement/claude");
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-runtime-invalid-executable" });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

/** An installed `claude`, and the one place this client is told to look. */
function installedCli(root: string, install = true): { executable: string; candidates: () => string[] } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "claude");
  if (install) writeCli(executable);
  return { executable, candidates: () => [join(root, "missing", "claude"), executable] };
}

function writeCli(path: string, body = "#!/bin/sh\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function clientHarness(
  script: (child: FakeChild, args: readonly string[]) => void,
  qualification: Qualification = {},
) {
  const directories = paths(); const harness = spawnHarness(script, qualification);
  const cli = installedCli(directories.runtimeHome);
  const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
    candidates: cli.candidates, resolveExecutable: async (path) => path });
  owners.push(client); return { ...directories, ...harness, ...cli, client };
}

describe("CLI account and verification boundary", () => {
  it("classifies the documented logged-out exit 1 as signed out", async () => {
    const h = clientHarness((child) => { child.send({ loggedIn: false }); child.close(1); });
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
    const h = clientHarness((child) => { child.send(payload); child.close(code); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("does not parse credential-bearing stderr as an auth response", async () => {
    const h = clientHarness((child) => { child.stderr.write(JSON.stringify(auth)); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("verifies the same isolated stream contract as chat", async () => {
    const h = clientHarness((child, args) => {
      if (args[0] === "auth") child.send(auth);
      else { child.send(init()); child.send(result({ result: "AVE_OK" })); }
      child.close();
    });
    expect(await h.client.verify()).toMatchObject({ runtime: "ready", connection: "connected", version: "2.1.0" });
    const print = h.calls.find((call) => call.args[0] === "-p")!;
    expect(print.child.input).toBe("Reply with exactly: AVE_OK");
    expect(print.args).not.toContain("Reply with exactly: AVE_OK");
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not retain verification after an invalid print result", async () => {
    const h = clientHarness((child, args) => {
      if (args[0] === "auth") child.send(auth);
      else { child.send(init()); child.send(result({ is_error: true })); }
      child.close();
    });
    await expect(h.client.verify()).rejects.toThrow();
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "connected" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("stop cancels captured commands and prevents future launches", async () => {
    const h = clientHarness(() => undefined); const pending = h.client.getStatus(); const child = await h.started;
    await h.client.stop(); expect(await pending).toMatchObject({ runtime: "unavailable" });
    await expect(h.client.verify()).rejects.toThrow(); expect(h.calls).toHaveLength(1); expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid captured UTF-8 rather than replacing protocol bytes", async () => {
    const h = clientHarness((child) => { child.stdout.write(Buffer.from([0xed])); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("opens a complete trusted login URL once and ignores cancelled output", async () => {
    const directories = paths(); const h = spawnHarness(undefined, {}); const openExternal = vi.fn();
    const cli = installedCli(directories.runtimeHome);
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...h, candidates: cli.candidates,
      resolveExecutable: async (path) => path, openExternal }); owners.push(client);
    await client.startBrowserLogin(); const child = await h.started;
    expect(h.calls[0]!.args).toEqual(["auth", "login"]);
    child.stdout.write("See https://untrusted.invalid/help\nhttps://user:secret@claude.ai/oauth\n");
    child.stdout.write("https://claude.ai/oauth/"); await Promise.resolve(); expect(openExternal).not.toHaveBeenCalled();
    child.stdout.write("authorize?code=private\n"); await Promise.resolve();
    child.stderr.write("https://claude.ai/oauth/authorize?code=second\n"); await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(1);
    await client.stop(); child.stdout.write("https://claude.ai/oauth/authorize?code=late\n");
    await Promise.resolve(); expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("Claude Code CLI discovery", () => {
  function discoveryHarness(qualification: Qualification = {}, install = true) {
    const directories = paths();
    const harness = spawnHarness((child) => { child.send({ loggedIn: false }); child.close(1); }, qualification);
    const cli = installedCli(directories.runtimeHome, install);
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness,
      candidates: cli.candidates, resolveExecutable: async (path) => path });
    owners.push(client);
    return { ...harness, ...cli, client };
  }

  it("looks on PATH first, then in the official install locations", () => {
    expect(claudeCodeExecutableCandidates({
      platform: "darwin", env: { PATH: "/opt/tools:relative/bin:/usr/bin" }, homeDir: "/Users/someone",
    })).toEqual([
      "/opt/tools/claude",
      "/usr/bin/claude",
      "/Users/someone/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(claudeCodeExecutableCandidates({
      platform: "win32", env: { Path: "C:\\Tools;relative", USERPROFILE: "C:\\Users\\someone" }, homeDir: "C:\\ignored",
    })).toEqual(["C:\\Tools\\claude.exe", "C:\\Users\\someone\\.local\\bin\\claude.exe"]);
  });

  it("qualifies only Claude Code output naming every option and auth command Ave uses", () => {
    expect(parseClaudeCodeVersion("2.1.303 (Claude Code)\n")).toBe("2.1.303");
    expect(parseClaudeCodeVersion("claude 2.1.303\n")).toBeNull();
    expect(missingClaudeCodeOptions(QUALIFYING_HELP)).toEqual([]);
    expect(missingClaudeCodeOptions(QUALIFYING_HELP.replace("  --no-chrome <value>", "  --chrome <value>")))
      .toEqual(["--no-chrome"]);
    // An option named only inside another option's description is not offered.
    expect(missingClaudeCodeOptions("Options:\n  --tools <x>  unlike --no-chrome\n")).toContain("--no-chrome");
    expect(missingClaudeCodeAuthCommands(QUALIFYING_AUTH_HELP)).toEqual([]);
    expect(missingClaudeCodeAuthCommands("Commands:\n  login\n  status\n")).toEqual(["logout"]);
  });

  it("reports a missing CLI as not configured without running anything", async () => {
    const h = discoveryHarness({}, false);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "not-configured" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("finds a CLI installed after it reported none, without being pointed at it", async () => {
    const h = discoveryHarness({}, false);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "not-configured" });
    writeCli(h.executable);
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "signed-out", version: "2.1.0" });
  });

  it("probes a found CLI once and again only when the file changes", async () => {
    const h = discoveryHarness();
    await h.client.getStatus();
    await h.client.getStatus();
    expect(h.probes).toEqual([["--version"], ["--help"], ["auth", "--help"]]);
    writeCli(h.executable, "#!/bin/sh\n# updated\n");
    await h.client.getStatus();
    expect(h.probes).toHaveLength(6);
  });

  it.each<[string, Qualification, boolean]>([
    ["is not Claude Code", {}, true],
    ["lacks an option Ave passes", { help: QUALIFYING_HELP.replace("--strict-mcp-config", "--loose-mcp-config") }, false],
    ["lacks an auth command", { authHelp: "Commands:\n  login\n  status\n" }, false],
  ])("reports a CLI that %s as incompatible and remembers that verdict", async (_name, qualification, foreignVersion) => {
    const h = discoveryHarness(qualification);
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
  });

  it("asks again after a probe that could not run", async () => {
    const h = discoveryHarness();
    h.spawn.mockImplementationOnce((_command, args) => {
      const child = new FakeChild(); children.push(child); h.probes.push([...args]);
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child as unknown as ChildProcess;
    });
    await expect(h.client.getStatus()).rejects.toMatchObject({ code: "claude-code-runtime-unavailable" });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", version: "2.1.0" });
  });

  it("starts chat only on the binary verify proved", async () => {
    const h = discoveryHarness();
    await expect(h.client.verifiedExecutable()).rejects.toMatchObject({ code: "claude-code-runtime-unavailable" });
    await h.client.verify();
    await expect(h.client.verifiedExecutable()).resolves.toBe(h.executable);
    writeCli(h.executable, "#!/bin/sh\n# reinstalled\n");
    await expect(h.client.verifiedExecutable()).rejects.toMatchObject({ code: "claude-code-runtime-unavailable" });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified" });
  });

  it("has no way to set or clear a path", () => {
    const h = discoveryHarness();
    expect("setExecutable" in h.client).toBe(false);
    expect("clearExecutable" in h.client).toBe(false);
  });
});

describe("Claude service integration", () => {
  it("revokes a failed actual stream and re-verifies before the next session", async () => {
    const directories = paths(); const h = spawnHarness(); const audit = vi.fn();
    const namespace: FeatureNamespaceHandle = {
      dir: directories.runtimeHome,
      async childDir(name) { const path = join(directories.runtimeHome, name); mkdirSync(path, { recursive: true }); return path; },
      async readJson(_name, fallback) { return fallback; }, async writeJson() {},
    };
    const status = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0");
    const verify = vi.fn(async () => status);
    const client = {
      getStatus: vi.fn(async () => status), verify, verifiedExecutable: async () => "/approved/claude",
      getRuntimePaths: () => directories, stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace, audit, claudeCodeClient: client,
      codexClient: { stop: vi.fn() } as unknown as CodexAppServerClient,
      acpRegistry: { stopAll: vi.fn() } as unknown as AcpSubscriptionRuntimeRegistry,
      createClaudeCodeConversationRuntime: (options) => new ClaudeCodeConversationRuntime({ ...options, ...h,
        resolveExecutable: async (path) => path }),
    });
    owners.push(service);
    await service.verify("claude-code");
    const session = await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    const pending = collect(session.streamTurn("hello"));
    const expected = expect(pending).rejects.toMatchObject({ code: "subscription-operation-failed" });
    const child = await h.started; child.send(init()); child.send(result({ is_error: true })); child.close(); await expected;
    expect(audit).toHaveBeenCalledExactlyOnceWith({ provider: "claude-code", outcome: "session-failed" });
    expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
    await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
