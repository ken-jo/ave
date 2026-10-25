// Inert config parsing: invalid matchers retain blocking denial guards, unknown events warn, and binary-only handlers lack a trust anchor and are rejected. Parsing never throws; per-entry timeouts use the hook ceiling (docs/architecture/hook-runtime-expansion-design.md).
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookEvent,
} from "./script-hook-types.js";
import { isRecord } from "../shared/is-record.js";
import { HOOK_EVENT_TYPES, hookEventSupportsMatcher } from "./hook-contract.js";
import { hookMatcherError } from "./hook-discovery.js";

export interface HookConfigEntry {
  // Stable identity for trust-review / audit — `<event>#<index>` within the config.
  id: string;
  // Lifecycle events are config-only and have no legacy script prefix.
  event: HookEvent;
  // Absent matchers match all; compilation happens when building the registry.
  matcher?: string;
  // Invalid entries remain inert denial guards for blocking tool events.
  matcherError?: string;
  configPath?: string;
  // Nonempty argv; argv[0] is the program.
  command: string[];
  env?: Record<string, string>;
  // Clamped to DEFAULT_HOOK_TIMEOUT_MS.
  timeoutMs: number;
  source: "config";
}

export interface ParsedHookConfig {
  entries: HookConfigEntry[];
  // Non-fatal: shapes we ignored (unknown event, malformed sub-entry, …).
  warnings: string[];
  // Fatal per-entry rejections (binary-only command, bad handler type, …).
  errors: string[];
}

// Unknown events warn and are ignored. Lifecycle events map to themselves; UserPromptSubmit alone is blocking and fail-closed.
const EVENT_KEY_TO_TYPE: Readonly<Record<string, HookEvent>> = HOOK_EVENT_TYPES;

// String commands split on whitespace without shell quoting; paths with spaces require argv arrays. Do not introduce shell parsing or injection.
function normalizeCommand(raw: unknown): string[] | null {
  let argv: string[];
  if (typeof raw === "string") {
    argv = raw.trim().split(/\s+/).filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    if (!raw.every((s) => typeof s === "string")) return null;
    argv = (raw as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    return null;
  }
  return argv.length > 0 ? argv : null;
}

// Classify paths without I/O; scheme:// tokens must never masquerade as local hash anchors.
export function looksLikeLocalScriptPath(token: string): boolean {
  if (token.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; /* Remote URLs cannot anchor trust. */
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith("~")) return true;
  if (token.startsWith(".")) return true;
  return false;
}

// Trust anchors on the local script in argv[0] or a later argument; binary-only commands are unanchorable and rejected.
export type CommandClass = "local-script" | "script-arg" | "binary-only";

export function classifyCommand(argv: string[]): CommandClass {
  if (looksLikeLocalScriptPath(argv[0])) return "local-script";
  if (argv.slice(1).some(looksLikeLocalScriptPath)) return "script-arg";
  return "binary-only";
}

// No I/O or throws; malformed config warns and yields no entries so broken config cannot silently activate hooks.
export function parseHookConfig(raw: unknown, options: { bundled?: boolean } = {}): ParsedHookConfig {
  const entries: HookConfigEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  if (raw === undefined || raw === null) {
    return { entries, warnings, errors };
  }
  if (!isRecord(raw)) {
    warnings.push("hooks.json: top-level value is not an object — ignored");
    return { entries, warnings, errors };
  }

  const hooksByEvent = raw.hooks;
  if (hooksByEvent === undefined) {
    return { entries, warnings, errors };
  }
  if (!isRecord(hooksByEvent)) {
    warnings.push('hooks.json: "hooks" is not an object — ignored');
    return { entries, warnings, errors };
  }

  for (const [eventKey, group] of Object.entries(hooksByEvent)) {
    const event = Object.hasOwn(EVENT_KEY_TO_TYPE, eventKey) ? EVENT_KEY_TO_TYPE[eventKey] : undefined;
    if (!event) {
      // Unknown events warn and never activate.
      warnings.push(`hooks.json: unknown event "${eventKey}" — entry ignored`);
      continue;
    }
    if (!Array.isArray(group)) {
      warnings.push(`hooks.json: event "${eventKey}" value is not an array — ignored`);
      continue;
    }

    group.forEach((matcherBlock, blockIdx) => {
      if (!isRecord(matcherBlock)) {
        warnings.push(
          `hooks.json: ${eventKey}[${blockIdx}] is not an object — ignored`,
        );
        return;
      }

      // Matchers must be exact name lists or valid regular expressions.
      let matcher: string | undefined;
      let matcherError: string | undefined;
      if (matcherBlock.matcher !== undefined && !hookEventSupportsMatcher(event)) {
        warnings.push(`hooks.json: ${eventKey}[${blockIdx}].matcher ${JSON.stringify(matcherBlock.matcher)} ignored: event has no matcher support`);
      } else if (matcherBlock.matcher !== undefined) {
        if (typeof matcherBlock.matcher !== "string") {
          matcherError = `matcher ${JSON.stringify(matcherBlock.matcher)} is not a string`;
          errors.push(`hooks.json: ${eventKey}[${blockIdx}].${matcherError}`);
        } else {
          const trimmed = matcherBlock.matcher.trim();
          // An absent matcher, empty string or * matches all.
          matcher = trimmed === "" || trimmed === "*" ? undefined : trimmed;
          const invalid = hookMatcherError(matcher);
          if (invalid !== undefined) {
            matcherError = invalid;
            errors.push(
              `hooks.json: ${eventKey}[${blockIdx}].matcher ${JSON.stringify(trimmed)} is not a valid regular expression (${invalid}) — rejected`,
            );
          }
        }
      }

      const handlers = matcherBlock.hooks;
      if (!Array.isArray(handlers)) {
        warnings.push(
          `hooks.json: ${eventKey}[${blockIdx}].hooks is not an array — ignored`,
        );
        return;
      }

      handlers.forEach((handler, handlerIdx) => {
        const id = `${eventKey}#${blockIdx}.${handlerIdx}`;
        if (!isRecord(handler)) {
          errors.push(`hooks.json: ${id} handler is not an object — rejected`);
          return;
        }
        if (handler.type !== "command") {
          errors.push(
            `hooks.json: ${id} handler.type must be "command" (got ${JSON.stringify(
              handler.type,
            )}) — rejected`,
          );
          return;
        }

        const command = normalizeCommand(handler.command);
        if (!command) {
          errors.push(
            `hooks.json: ${id} handler.command must be a non-empty string or string[] — rejected`,
          );
          return;
        }

        // Binary-only commands lack a stable trust anchor and must be rejected.
        if (classifyCommand(command) === "binary-only") {
          errors.push(
            `hooks.json: ${id} command "${command.join(
              " ",
            )}" is a PATH-binary with no local script argument — rejected (no stable hash anchor for the trust lockfile; design §6.1)`,
          );
          return;
        }

        let env: Record<string, string> | undefined;
        if (handler.env !== undefined && options.bundled === true) {
          if (!isRecord(handler.env) || Object.entries(handler.env).some(([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string"
            || /[\u0000-\u001f\u007f]/u.test(value)
            || /^(?:AVE_HOOK_|PLUGIN_ROOT$|PLUGIN_DATA$|HOME$|PATH$|SANDBOX_)/u.test(key))) {
            errors.push(`hooks.json: ${id} handler.env has an invalid or reserved value — rejected`);
            return;
          }
          env = handler.env as Record<string, string>;
        }

        let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
        if (handler.timeoutMs !== undefined) {
          if (typeof handler.timeoutMs !== "number" || !Number.isFinite(handler.timeoutMs)) {
            warnings.push(
              `hooks.json: ${id} handler.timeoutMs is not a finite number — defaulting to ${DEFAULT_HOOK_TIMEOUT_MS}ms`,
            );
          } else if (handler.timeoutMs <= 0 || !Number.isInteger(handler.timeoutMs)) {
            warnings.push(
              `hooks.json: ${id} handler.timeoutMs must be a positive integer — defaulting to ${DEFAULT_HOOK_TIMEOUT_MS}ms`,
            );
          } else {
            timeoutMs = Math.min(handler.timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
          }
        }

        entries.push({
          id,
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          ...(matcherError !== undefined ? { matcherError } : {}),
          command,
          ...(env ? { env } : {}),
          timeoutMs,
          source: "config",
        });
      });
    });
  }

  return { entries, warnings, errors };
}
