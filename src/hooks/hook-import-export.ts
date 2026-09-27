import { parseHookConfig, type HookConfigEntry } from "./hook-config.js";
import type { HookEvent } from "./script-hook-types.js";
import { validateSymbolicHookArgv } from "../plugins/resolve-bundled-argv.js";

const EVENT_TO_INTERNAL: Readonly<Record<string, HookEvent>> = {
  PreToolUse: "pre", PostToolUse: "post", PermissionRequest: "perm",
  UserPromptSubmit: "UserPromptSubmit", PostToolUseFailure: "PostToolUseFailure",
  PermissionDenied: "PermissionDenied", SessionStart: "SessionStart",
  SessionEnd: "SessionEnd", Notification: "Notification", Stop: "Stop",
  PreCompact: "PreCompact", PostCompact: "PostCompact",
  SubagentStart: "SubagentStart", SubagentStop: "SubagentStop",
};
const INTERNAL_TO_EVENT = Object.fromEntries(Object.entries(EVENT_TO_INTERNAL).map(([external, internal]) => [internal, external]));

export interface ImportedHookEntry {
  /** The source file containing this handler, retained for studio review. */
  sourcePath: string;
  event: HookEvent;
  matcher?: string;
  command: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  needsAdaptation: true;
}

export interface HookImportDiagnostic {
  group: "lost" | "rewritten" | "needs your input";
  sourcePath: string;
  entry: string;
  message: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rewritePlaceholder(value: string): string {
  return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")
    .replaceAll("${CLAUDE_PLUGIN_DATA}", "${PLUGIN_DATA}");
}

function hasForbiddenPlaceholder(value: string): boolean {
  const rewritten = rewritePlaceholder(value);
  return /\$\{user_config\.|\$\{CLAUDE_/u.test(rewritten);
}

/** Convert one source file's supported events and exec-form handlers into review-only entries. */
export function importLegacyHooks(value: unknown, sourcePath: string): { entries: ImportedHookEntry[]; diagnostics: HookImportDiagnostic[] } {
  if (!sourcePath.trim()) throw new Error("hook import requires a source path");
  const entries: ImportedHookEntry[] = [];
  const diagnostics: HookImportDiagnostic[] = [];
  const report = (group: HookImportDiagnostic["group"], entry: string, message: string): void => {
    diagnostics.push({ group, sourcePath, entry, message });
  };
  const groups = record(record(value)?.hooks);
  if (!groups) {
    report("lost", "hooks", "hooks must be an object");
    return { entries, diagnostics };
  }
  for (const [sourceEvent, blocks] of Object.entries(groups)) {
    const event = Object.hasOwn(EVENT_TO_INTERNAL, sourceEvent) ? EVENT_TO_INTERNAL[sourceEvent] : undefined;
    if (!event) {
      report("lost", sourceEvent, `event ${sourceEvent} has no equivalent`);
      continue;
    }
    if (!Array.isArray(blocks)) {
      report("lost", sourceEvent, `event ${sourceEvent} needs an array`);
      continue;
    }
    blocks.forEach((rawBlock, blockIndex) => {
      const block = record(rawBlock);
      const handlers = block?.hooks;
      const matcher = block?.matcher;
      if (!block || !Array.isArray(handlers) || (matcher !== undefined && typeof matcher !== "string")) {
        report("lost", `${sourceEvent}[${blockIndex}]`, "invalid matcher block");
        return;
      }
      handlers.forEach((rawHandler, handlerIndex) => {
        const label = `${sourceEvent}[${blockIndex}].hooks[${handlerIndex}]`;
        const handler = record(rawHandler);
        if (!handler || handler.type !== "command") {
          report("lost", label, `handler ${label} has no command equivalent`);
          return;
        }
        if (typeof handler.command !== "string" || !Array.isArray(handler.args)
          || !handler.args.every((part: unknown) => typeof part === "string")) {
          report("lost", label, `handler ${label} needs exec-form command and args; shell strings are unsupported`);
          return;
        }
        const rawEnv = handler.env === undefined ? undefined : record(handler.env);
        if (handler.env !== undefined && (!rawEnv || !Object.values(rawEnv).every((part) => typeof part === "string"))) {
          report("lost", label, `handler ${label} has invalid env`);
          return;
        }
        if (handler.timeoutMs !== undefined && (typeof handler.timeoutMs !== "number"
          || !Number.isInteger(handler.timeoutMs) || handler.timeoutMs <= 0)) {
          report("lost", label, `handler ${label} needs a positive integer timeoutMs`);
          return;
        }
        const rawValues = [handler.command, ...handler.args, ...Object.values(rawEnv ?? {})] as string[];
        if (rawValues.some(hasForbiddenPlaceholder)) {
          report("lost", label, `handler ${label} uses an unsupported setting or placeholder`);
          return;
        }
        const command = [handler.command, ...handler.args].map(rewritePlaceholder);
        const env = rawEnv ? Object.fromEntries(Object.entries(rawEnv).map(([key, part]) => [key, rewritePlaceholder(part as string)])) : undefined;
        entries.push({ sourcePath, event, ...(matcher ? { matcher } : {}), command,
          ...(env ? { env } : {}),
          ...(typeof handler.timeoutMs === "number" ? { timeoutMs: handler.timeoutMs } : {}),
          needsAdaptation: true });
        report("needs your input", label, "Review stdin, decision output, matcher meaning, and argv before clearing adaptation");
        if (event !== sourceEvent || rawValues.some((part) => part !== rewritePlaceholder(part))) {
          report("rewritten", label, `event or placeholder rewritten for ${label}`);
        }
      });
    });
  }
  return { entries, diagnostics };
}

/** Refuse publication until the user has reviewed each imported protocol boundary. */
export function clearedImportedHooks(entries: readonly (Omit<ImportedHookEntry, "needsAdaptation"> & { needsAdaptation?: boolean })[]): { version: 1; hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const [index, entry] of entries.entries()) {
    if (entry.needsAdaptation !== false) throw new Error(`hook ${index} still needs adaptation`);
    const event = Object.hasOwn(INTERNAL_TO_EVENT, entry.event) ? INTERNAL_TO_EVENT[entry.event] : undefined;
    if (!event) throw new Error(`hook ${index} has an unsupported event`);
    validateSymbolicHookArgv([...entry.command, ...Object.values(entry.env ?? {})], `hook ${index}`);
    (hooks[event] ??= []).push({ ...(entry.matcher ? { matcher: entry.matcher } : {}), hooks: [{ type: "command",
      command: entry.command, ...(entry.env ? { env: entry.env } : {}),
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}) }] });
  }
  const document = { version: 1 as const, hooks };
  const parsed = parseHookConfig(document, { bundled: true });
  if (parsed.errors.length || parsed.warnings.length || parsed.entries.length !== entries.length) {
    throw new Error(`imported hooks are invalid: ${[...parsed.errors, ...parsed.warnings].join("; ")}`);
  }
  return document;
}

/** Project reviewed native entries for an optional adjacent legacy layout. */
export function exportLegacyHooks(entries: readonly HookConfigEntry[]): { hooks: Record<string, unknown[]>; notice: string } {
  const hooks: Record<string, unknown[]> = {};
  const back = (value: string) => value.replaceAll("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
    .replaceAll("${PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}");
  for (const entry of entries) {
    const event = Object.hasOwn(INTERNAL_TO_EVENT, entry.event) ? INTERNAL_TO_EVENT[entry.event] : undefined;
    if (!event) throw new Error(`hook event ${entry.event} cannot be exported`);
    const [command, ...args] = entry.command;
    if (!command) throw new Error(`hook ${entry.id} has no executable`);
    (hooks[event] ??= []).push({ ...(entry.matcher ? { matcher: entry.matcher } : {}), hooks: [{ type: "command",
      command: back(command), args: args.map(back),
      ...(entry.env ? { env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, back(value)])) } : {}),
      timeoutMs: entry.timeoutMs }] });
  }
  return { hooks, notice: "Event names and argv were mapped. Stdin payload, decision output, and matcher semantics remain specific to the exporting host; review and adapt each handler before running it." };
}
