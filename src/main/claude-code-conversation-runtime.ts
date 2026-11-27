import type { SubscriptionEvidenceSink } from "./subscription-connection-evidence.js";
// Main-owned print transport. Ave retains history and executes host tools.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { StreamEvent, ToolSchema } from "../engine/llm/types.js";
import { JsonLineReader } from "../lib/json-line-reader.js";
import { isRecord } from "../shared/is-record.js";
import { CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID } from "../shared/claude-code-subscription.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  ClaudeCodeSubscriptionError,
  claudeCodeLocationError,
  sanitizedClaudeCodeEnvironment,
  validateClaudeCodeRuntimeDirectories,
} from "./claude-code-subscription-client.js";
import {
  CLAUDE_CODE_MAX_OUTPUT_BYTES,
  CLAUDE_CODE_MAX_PROMPT_BYTES,
  CLAUDE_CODE_MCP_SERVER_NAME,
  claudeCodePrintArgs,
  ClaudeCodeStream,
} from "./claude-code-stream.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import { isDefinitiveSubscriptionAuthError } from "./subscription-transport-error-diagnostics.js";
import { writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { SubscriptionAttachmentTransportError } from "./subscription-attachment-input.js";
import { CodexExecutableLocationError } from "./codex-executable-location.js";
import type { SubscriptionToolBridge } from "./subscription-tool-bridge.js";

import type { ClaudeCodeExecutable } from "./claude-code-executable.js";
import type { SubscriptionPlanUsageWindow } from "../shared/subscription-plan-usage.js";

const MAX_QUEUED_EVENTS = 256;
const HOST_TOOL_ACCEPTED = "Ave accepted the host tool request and will provide its result in the next model round.";
const ARGUMENT_ERROR_MARKERS = ["error: unknown option ", "error: unknown argument ", "error: too many arguments"] as const;

export interface ClaudeCodeConversationRuntimeOptions {
  readonly connectionEvidence?: SubscriptionEvidenceSink;
  readonly onPlanUsage?: (windows: readonly SubscriptionPlanUsageWindow[]) => void;
  readonly resolveRuntime: () => Promise<ClaudeCodeExecutable>;
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
  readonly bridge: SubscriptionToolBridge;
  // A model the service validated against `listModels`; absent: the CLI's default.
  readonly model?: string;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly platform?: NodeJS.Platform;
}

function operationFailed(): ClaudeCodeSubscriptionError {
  return new ClaudeCodeSubscriptionError("claude-code-operation-failed");
}

function abortError(): Error {
  const error = new Error("subscription-runtime-aborted");
  error.name = "AbortError";
  return error;
}

export class ClaudeCodeConversationRuntime {
  readonly provider = CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;
  private readonly spawn: NonNullable<ClaudeCodeConversationRuntimeOptions["spawn"]>;
  private activeCancel: (() => void) | null = null;
  private running = false;
  private stopped = false;
  private termination: void | Promise<void> = undefined;

  constructor(private readonly options: ClaudeCodeConversationRuntimeOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) =>
      spawnManaged(command, args, spawnOptions, { label: "claude-code-conversation" }));
  }

  async *streamTurn(text: string, signal?: AbortSignal, attachments?: readonly unknown[]): AsyncIterable<StreamEvent> {
    if (attachments?.length) throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
    if (this.stopped || this.running || typeof text !== "string" || !text.trim()
      || Buffer.byteLength(text, "utf8") > CLAUDE_CODE_MAX_PROMPT_BYTES) throw operationFailed();
    if (signal?.aborted) throw abortError();
    this.running = true;
    const { bridge, runtimeHome, workspaceDir, runtimeTempDir } = this.options;
    let configPath: string | null = null;
    let child: ChildProcess | null = null;
    let termination: void | Promise<void>;
    let timer: NodeJS.Timeout | undefined;
    let boundaryTask: NodeJS.Immediate | undefined;
    let ended = false;
    let toolBoundary = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const queue: StreamEvent[] = [];
    const notify = () => { const next = wake; wake = null; next?.(); };
    const kill = () => {
      const active = child;
      child = null;
      if (active) {
        termination = forceKillManagedChildProcess(active, "claude-code-turn-cancel");
        this.termination = termination;
      }
      return termination;
    };
    const fail = (error: Error) => {
      if (failure || ended) return;
      failure = error;
      queue.length = 0;
      notify();
      kill();
    };
    const push = (event: StreamEvent) => {
      if (ended || failure) return;
      if (queue.length >= MAX_QUEUED_EVENTS) { fail(operationFailed()); return; }
      queue.push(event);
      notify();
    };
    const onAbort = () => {
      if (failure) return;
      failure = abortError();
      queue.length = 0;
      notify();
      kill();
    };
    this.activeCancel = onAbort;
    signal?.addEventListener("abort", onAbort, { once: true });
    const assertActive = () => {
      if (failure) throw failure;
      if (this.stopped || signal?.aborted) throw abortError();
    };

    try {
      const runtime = await this.options.resolveRuntime();
      await validateClaudeCodeRuntimeDirectories([runtimeHome, workspaceDir, runtimeTempDir]);
      assertActive();
      const mcpServers = bridge.tools.length ? {
        [CLAUDE_CODE_MCP_SERVER_NAME]: await bridge.startMcpServer().then((mcp) => ({
          command: mcp.command, args: [...mcp.args], env: { ...mcp.env },
        })),
      } : {};
      assertActive();
      configPath = join(runtimeTempDir, `mcp-${randomUUID()}.json`);
      await writeFileAtomicAtPath(configPath, `${JSON.stringify({ mcpServers })}\n`);
      assertActive();
      const toolNames = claudeCodeMcpToolNames(bridge.tools);
      const stream = new ClaudeCodeStream(toolNames, this.options.onPlanUsage);
      bridge.setHandler((call) => {
        if (!stream.initialized || toolBoundary || failure || ended || this.stopped || signal?.aborted) throw operationFailed();
        stream.acceptHostCall();
        toolBoundary = true;
        boundaryTask = setImmediate(() => {
          if (failure || ended || this.stopped || signal?.aborted) return;
          push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
          push({ type: "message_complete", stopReason: "tool_use" });
          if (failure) return;
          ended = true;
          notify();
          kill();
        });
        return HOST_TOOL_ACCEPTED;
      });
      await validateClaudeCodeRuntimeDirectories([runtimeHome, workspaceDir, runtimeTempDir]);
      try {
        await runtime.verify();
      } catch (error) {
        if (!failure && !this.stopped) this.options.connectionEvidence?.({ kind: "transport-lost", source: this });
        throw error;
      }
      assertActive();
      let spawned: ChildProcess;
      try {
        spawned = this.spawn(runtime.executable, claudeCodePrintArgs(configPath, toolNames, this.options.model), {
          cwd: workspaceDir,
          env: sanitizedClaudeCodeEnvironment(runtimeHome, process.env, this.options.platform, runtimeTempDir),
          stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
          detached: (this.options.platform ?? process.platform) !== "win32",
        });
      } catch (error) {
        this.options.connectionEvidence?.({ kind: "transport-lost", source: this });
        throw error;
      }
      child = spawned;
      const transportFailed = (error: Error) => {
        if (child !== spawned || ended || failure) return;
        this.options.connectionEvidence?.({ kind: "transport-lost", source: spawned });
        fail(error);
      };
      timer = setTimeout(() => transportFailed(operationFailed()), TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
      timer.unref();
      let outputBytes = 0;
      const argumentErrorOffsets = ARGUMENT_ERROR_MARKERS.map(() => 0);
      let rejectedArguments = false;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const reader = new JsonLineReader({
        maxLineBytes: CLAUDE_CODE_MAX_OUTPUT_BYTES,
        onMessage: (message) => {
          if (failure || ended) return;
          if (isRecord(message) && ((message.type === "assistant" && isDefinitiveSubscriptionAuthError(message.error))
            || (message.type === "result" && message.is_error === true && isDefinitiveSubscriptionAuthError(message)))) {
            this.options.connectionEvidence?.({ kind: "sign-out", source: spawned });
            fail(operationFailed());
            return;
          }
          try {
            for (const value of stream.accept(message)) {
              if (!toolBoundary && value) push({ type: "text_delta", text: value });
            }
          } catch {
            fail(isRecord(message) && message.type === "system" && message.subtype === "init" && !stream.initialized
              ? new ClaudeCodeSubscriptionError("claude-code-runtime-incompatible") : operationFailed());
          }
        },
        onError: () => transportFailed(operationFailed()),
      });
      const consume = (chunk: Buffer | string) => {
        if (failure || ended) return;
        try {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) throw operationFailed();
          decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
          reader.write(chunk);
        } catch { transportFailed(operationFailed()); }
      };
      const processFailed = () => transportFailed(new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable"));
      const pipeFailed = () => transportFailed(operationFailed());
      spawned.on("error", processFailed);
      spawned.stdout?.on("error", pipeFailed);
      spawned.stderr?.on("error", pipeFailed);
      spawned.stdin?.on("error", pipeFailed);
      spawned.stdout?.on("data", consume);
      spawned.stderr?.on("data", (chunk: Buffer | string) => {
        if (failure || ended) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) { transportFailed(operationFailed()); return; }
        // Match fixed parser diagnostics across chunks without retaining stderr.
        if (!rejectedArguments) {
          for (const value of typeof chunk === "string" ? Buffer.from(chunk) : chunk) {
            const byte = value >= 65 && value <= 90 ? value + 32 : value;
            for (let index = 0; index < ARGUMENT_ERROR_MARKERS.length; index++) {
              const marker = ARGUMENT_ERROR_MARKERS[index]!;
              const offset = argumentErrorOffsets[index]!;
              argumentErrorOffsets[index] = byte === marker.charCodeAt(offset) ? offset + 1 : byte === marker.charCodeAt(0) ? 1 : 0;
              if (argumentErrorOffsets[index] === marker.length) rejectedArguments = true;
            }
            if (rejectedArguments) break;
          }
        }
      });
      spawned.once("close", (code, exitSignal) => {
        // Keep the exact handle through finally: a settled root can still own a live MCP descendant group in the managed-child registry.
        if (failure || ended) return;
        try {
          decoder.decode();
          // EOF supplies a delimiter to validate a final un-terminated frame.
          reader.write("\n");
          reader.close();
          if (failure) return;
          if (exitSignal) { processFailed(); return; }
          if (code !== 0) {
            transportFailed(!stream.initialized && code !== null && rejectedArguments
              ? new ClaudeCodeSubscriptionError("claude-code-runtime-incompatible") : operationFailed());
            return;
          }
          if (toolBoundary) return;
          stream.assertComplete();
          push({ type: "message_complete", stopReason: stream.stopReason });
          ended = true;
          notify();
        } catch (error) { transportFailed(error instanceof ClaudeCodeSubscriptionError ? error : operationFailed()); }
      });
      if (!spawned.stdin || !spawned.stdout || !spawned.stderr) pipeFailed();
      assertActive();
      spawned.stdin!.end(text, (error?: Error | null) => { if (error) pipeFailed(); });
      while (true) {
        if (failure) throw failure;
        const next = queue.shift();
        if (next) { yield next; continue; }
        if (ended) break;
        await new Promise<void>((resolveNext) => { wake = resolveNext; });
      }
    } catch (error) {
      if (error instanceof CodexExecutableLocationError) throw claudeCodeLocationError();
      if (error instanceof ClaudeCodeSubscriptionError || (error instanceof Error && error.name === "AbortError")) throw error;
      throw operationFailed();
    } finally {
      ended = true;
      this.activeCancel = null;
      bridge.setHandler(null);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (boundaryTask) clearImmediate(boundaryTask);
      try { await kill(); } finally {
        try { if (configPath) await fs.rm(configPath, { force: true }); }
        finally { this.running = false; }
      }
    }
  }

  async cancelActiveTurn(): Promise<void> {
    this.activeCancel?.();
    await this.termination;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activeCancel?.();
    await this.termination;
    await this.options.bridge.stop();
  }
}

export function claudeCodeMcpToolNames(tools: readonly ToolSchema[]): string[] {
  return tools.map((tool) => `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${tool.name}`);
}
