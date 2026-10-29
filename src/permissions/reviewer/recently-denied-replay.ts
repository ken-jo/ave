import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import * as Ajv2020Module from "ajv/dist/2020.js";
import { resolveAddFormats, resolveAjv, type AjvCtor } from "../../plugins/config-schema.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { parseStrictJsonText } from "../../shared/strict-json.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { isValidSessionId } from "../../shared/session-id.js";
import { isValidToolUseId } from "../../shared/tool-use-id.js";
import { isSafeStructuralId } from "../../shared/dlp-safe-id.js";
import type { RecentlyDeniedEntry, RecentlyDeniedInvocationRef } from "../../shared/recently-denied.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { captureReplayRootDigest, issueReplayRootBinding } from "./replay-root-binding.js";
import type { RecentlyDeniedReplayResolver } from "./recently-denied.js";

const INPUT_BYTES_LIMIT = 1024 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as AjvCtor;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fingerprints detect changed references; they never authorize execution. */
export function normalizeRecentlyDeniedInvocationRef(value: unknown): RecentlyDeniedInvocationRef | undefined {
  if (!isRecord(value) || !isValidToolUseId(value.toolUseId) || !isSafeStructuralId(value.toolUseId)
    || typeof value.inputDigest !== "string" || !DIGEST_PATTERN.test(value.inputDigest)
    || typeof value.rootDigest !== "string" || !DIGEST_PATTERN.test(value.rootDigest)
    || (value.pluginId !== undefined && !isSafeStructuralId(value.pluginId))
    || (value.mcpServerId !== undefined && !isSafeStructuralId(value.mcpServerId))) return undefined;
  return {
    toolUseId: value.toolUseId, inputDigest: value.inputDigest, rootDigest: value.rootDigest,
    ...(typeof value.pluginId === "string" ? { pluginId: value.pluginId } : {}),
    ...(typeof value.mcpServerId === "string" ? { mcpServerId: value.mcpServerId } : {}),
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/** Refuse inputs that cannot round-trip exactly through the saved transcript. */
export function makeRecentlyDeniedInvocationRef(
  input: Record<string, unknown>,
  context: { cwd: string; toolUseId: string; pluginId?: string; mcpServerId?: string },
): RecentlyDeniedInvocationRef | undefined {
  try {
    if (!isRecord(input) || describeNonJson(input, "input") !== null || !isAbsolute(context.cwd)) return undefined;
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded, "utf8") > INPUT_BYTES_LIMIT) return undefined;
    const canonicalInput = parseStrictJsonText(encoded, {
      maxDepth: 64, maxNodes: 100_000, maxObjectMembers: 100_000, maxArrayItems: 100_000,
      forbiddenKeys: new Set(), nullPrototypeObjects: false, rejectNonFiniteNumbers: true,
      fail: () => { throw new Error("Invalid replay input"); },
    });
    const rootDigest = captureReplayRootDigest(context.cwd);
    if (rootDigest === undefined) return undefined;
    return normalizeRecentlyDeniedInvocationRef({
      toolUseId: context.toolUseId,
      inputDigest: fingerprint(canonicalInput),
      rootDigest,
      ...(context.pluginId === undefined ? {} : { pluginId: context.pluginId }),
      ...(context.mcpServerId === undefined ? {} : { mcpServerId: context.mcpServerId }),
    });
  } catch {
    return undefined;
  }
}

export interface RecentlyDeniedReplayDeps {
  memoryManager: Pick<MemoryManager, "loadSession" | "loadSessionMetadata">;
  toolRegistry: Pick<ToolRegistry, "findByName">;
  executeAll: ToolExecutor["executeAll"];
}

/** Resolve persisted display metadata only on an explicit rerun; saved input remains untrusted. */
export function createRecentlyDeniedReplayResolver(deps: RecentlyDeniedReplayDeps): RecentlyDeniedReplayResolver {
  return async (entry: RecentlyDeniedEntry) => {
    const unavailable = { ok: false, error: "rerun-unavailable" } as const;
    const ref = normalizeRecentlyDeniedInvocationRef(entry.invocationRef);
    if (!ref || !isValidSessionId(entry.sessionId)) return unavailable;
    let input: Record<string, unknown>;
    let cwd: string;
    try {
      const root = deps.memoryManager.loadSessionMetadata(entry.sessionId)?.projectRoot;
      if (typeof root !== "string" || !isAbsolute(root)) return unavailable;
      cwd = root;
      const messages = deps.memoryManager.loadSession(entry.sessionId);
      if (!Array.isArray(messages)) return unavailable;
      const matches: Record<string, unknown>[] = [];
      for (const message of messages) {
        if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
        for (const call of message.toolCalls) {
          if (isRecord(call) && call.id === ref.toolUseId) matches.push(call);
        }
      }
      if (matches.length !== 1) return unavailable;
      const call = matches[0];
      if (call.invalidInput !== undefined || call.name !== entry.toolName || call.source !== entry.source
        || call.pluginId !== ref.pluginId || call.mcpServerId !== ref.mcpServerId || !isRecord(call.input)) return unavailable;
      const currentRef = makeRecentlyDeniedInvocationRef(call.input, { cwd, ...ref });
      if (!currentRef || currentRef.inputDigest !== ref.inputDigest || currentRef.rootDigest !== ref.rootDigest) return unavailable;
      const tool = deps.toolRegistry.findByName(entry.toolName);
      if (!tool || tool.source !== entry.source || tool.category !== call.category || tool.pluginId !== ref.pluginId || tool.mcpServerId !== ref.mcpServerId) return unavailable;
      const schema = tool.toJsonSchema();
      if (!isRecord(schema) || schema.$async === true) return unavailable;
      const Constructor = typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ? Ajv2020 : resolveAjv();
      const validator = new Constructor({ strict: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
      resolveAddFormats()(validator);
      if (!validator.compile(schema)(call.input)) return unavailable;
      input = structuredClone(call.input);
    } catch {
      return unavailable;
    }
    const replayRootBinding = issueReplayRootBinding(cwd, ref.rootDigest);
    if (!replayRootBinding) return unavailable;
    const results = await deps.executeAll([{ id: randomUUID(), name: entry.toolName, input }], {
      executionCwd: cwd, replayRootBinding,
      permissionContext: { trustOrigin: "user-keyboard", manualRerun: true, headless: false },
    });
    return results.length === 1 && !results[0].is_error ? { ok: true } : { ok: false, error: "rerun-failed" };
  };
}
