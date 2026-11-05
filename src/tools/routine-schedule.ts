// Persist future-triggered routines across restarts; calendar-event lookup belongs to plugins.
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { RoutineExecution, RoutineRepeat, RoutineSchedule } from "../main/routines-store.js";
import type { RoutineEditPatch } from "../shared/routines-types.js";
import {
  MAX_CRON_EXPR_LENGTH,
  MAX_FUTURE_OFFSET_MS,
  MAX_ROUTINE_SOURCE_LENGTH,
  MIN_INTERVAL_MS,
} from "../main/routines-store.js";
import { isValidPluginId } from "../plugins/public-contract.js";
import { isValidCronExpression } from "../routines/cron-evaluator.js";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_ONLY_DEFAULT_HOUR = 9;

/** Maximum interval: the same horizon the store allows for `schedule.at`. */
const MAX_INTERVAL_MS = MAX_FUTURE_OFFSET_MS;

// Return UTC ISO or null; date-only inputs default to 09:00 in the host zone, matching the routine picker.
function asIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = DATE_ONLY_RE.exec(trimmed);
  if (dateOnly) {
    const parsed = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      DATE_ONLY_DEFAULT_HOUR,
    );
    // `new Date(y, …)` maps a year of 0-99 onto 1900+y; restate it explicitly.
    parsed.setFullYear(Number(dateOnly[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseRepeat(raw: unknown): RoutineRepeat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind === "none") return { kind: "none" };
  if (kind === "daily") return { kind: "daily" };
  if (kind === "weekly") return { kind: "weekly" };
  if (kind === "monthly") return { kind: "monthly" };
  if (kind === "interval") {
    const ms = typeof r.intervalMs === "number"
      && Number.isFinite(r.intervalMs)
      && r.intervalMs >= MIN_INTERVAL_MS
      && r.intervalMs <= MAX_INTERVAL_MS
      ? r.intervalMs
      : null;
    if (!ms) return null;
    return { kind: "interval", intervalMs: ms };
  }
  if (kind === "cron") {
    const raw = typeof r.expression === "string" ? r.expression : "";
    const expr = raw.trim();
    if (!expr || expr.length > MAX_CRON_EXPR_LENGTH || !isValidCronExpression(expr)) return null;
    return { kind: "cron", expression: expr };
  }
  return null;
}

function parseSchedule(raw: unknown): RoutineSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;

  const repeat = s.repeat !== undefined ? parseRepeat(s.repeat) : undefined;
  // Cron computes next-fire without an at timestamp.
  const isCron = repeat?.kind === "cron";

  const at = s.at !== undefined ? asIso(s.at) : undefined;

  if (!isCron && !at) return null;

  return {
    ...(at ? { at } : {}),
    ...(repeat ? { repeat } : {}),
  };
}

function parseAllowedPlugins(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (ids.some((v) => !v || !isValidPluginId(v))) return null;
  return [...new Set(ids)];
}

type RoutineScheduleAction = "add" | "update" | "remove";

function parseAction(raw: unknown): RoutineScheduleAction | null {
  if (raw === undefined) return "add";
  return raw === "add" || raw === "update" || raw === "remove" ? raw : null;
}

/** What "이 세션 동안 허용" remembers: the action, whether it connects to this chat, and the plugin scope (add) or the item (update, remove). */
function routineScheduleApprovalCacheKey(rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const action = parseAction(input.action);
  if (!action) return "action:invalid";
  // An agent update or remove only ever reaches an item connected to its own chat.
  if (action !== "add") return `action:${action}:connect:this-chat:item:${typeof input.routineId === "string" ? input.routineId : "invalid"}`;
  const connect = input.connectToThisChat === true ? "this-chat" : "no";
  const allowedPlugins = parseAllowedPlugins(input.allowedPlugins);
  if (!allowedPlugins) return `action:add:connect:${connect}:scope:invalid`;
  if (allowedPlugins.length === 0) return `action:add:connect:${connect}:scope:deny-all`;
  return `action:add:connect:${connect}:scope:allow:${[...allowedPlugins].sort().join(",")}`;
}

export interface RoutineScheduleToolDeps {
  /** The project (or default workspace) root of the conversation that called the tool, or undefined when it has none. */
  projectRootForSession: (sessionId: string) => string | undefined;
  /** The saved main chat the calling session belongs to (a sub-agent's is its root chat's), or undefined when there is none. The host
   * binds 대화에 연결 to this; the model never names a session. */
  chatForSession: (sessionId: string) => string | undefined;
  /** Remove an item the way the schedule panel's delete does (its own runs' sessions go with it; a connected chat never does). */
  removeRoutine: (routineId: string) => Promise<boolean>;
}

const UPDATE_FIELDS = new Set(["action", "routineId", "title", "prePrompt", "schedule"]);
const REMOVE_FIELDS = new Set(["action", "routineId"]);

function errorResult(message: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

export function createRoutineScheduleTool(store: RoutinesStore, deps: RoutineScheduleToolDeps): Tool {
  return createDynamicTool({
    name: "routine_schedule",
    description: t("be_routineSchedule.toolDescription"),
    source: "builtin",
    category: "write",
    approvalCacheKey: routineScheduleApprovalCacheKey,
    jsonSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "remove"],
          description: t("be_routineSchedule.actionDescription"),
        },
        routineId: { type: "string", description: t("be_routineSchedule.routineIdDescription") },
        connectToThisChat: { type: "boolean", description: t("be_routineSchedule.connectToThisChatDescription") },
        execution: {
          type: "string",
          enum: ["llm-session", "notification-only"],
          description: t("be_routineSchedule.executionDescription"),
        },
        schedule: {
          type: "object",
          description: t("be_routineSchedule.scheduleDescription"),
          properties: {
            at: {
              type: "string",
              description: t("be_routineSchedule.atDescription"),
            },
            repeat: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["none", "daily", "weekly", "monthly", "interval", "cron"] },
                intervalMs: { type: "number", description: t("be_routineSchedule.intervalMsDescription") },
                expression: { type: "string", description: t("be_routineSchedule.expressionDescription") },
              },
              required: ["kind"],
            },
          },
        },
        prePrompt: {
          type: "string",
          description: t("be_routineSchedule.prePromptDescription"),
        },
        title: { type: "string", description: t("be_routineSchedule.titleDescription") },
        notificationTitle: {
          type: "string",
          description: t("be_routineSchedule.notificationTitleDescription"),
        },
        notificationBody: {
          type: "string",
          description: t("be_routineSchedule.notificationBodyDescription"),
        },
        allowedPlugins: {
          type: "array",
          description: t("be_routineSchedule.allowedPluginsDescription"),
          items: { type: "string" },
        },
        source: {
          type: "string",
          description: t("be_routineSchedule.templateSourceDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const action = parseAction(a.action);
      if (!action) return errorResult("action must be 'add', 'update' or 'remove'");
      if (action !== "add") {
        const sessionId = ctx?.metadata?.sessionId;
        const chat = typeof sessionId === "string" && sessionId ? deps.chatForSession(sessionId) : undefined;
        const allowed = action === "update" ? UPDATE_FIELDS : REMOVE_FIELDS;
        const extra = Object.keys(a).filter((key) => !allowed.has(key));
        if (extra.length > 0) return errorResult(`${action} does not take: ${extra.join(", ")}`);
        if (typeof a.routineId !== "string" || !a.routineId) return errorResult(`${action} needs routineId`);
        // Only an item connected to this chat; every other item is the user's to change.
        const record = chat === undefined ? undefined : store.list().find((r) => r.id === a.routineId);
        if (!record || record.targetSessionId !== chat) {
          return errorResult(`routine_schedule can ${action} only a schedule item connected to this chat`);
        }
        if (action === "remove") {
          return (await deps.removeRoutine(record.id))
            ? { output: JSON.stringify({ routineId: record.id, removed: true }), isError: false }
            : errorResult("the schedule item could not be removed");
        }
        const patch: RoutineEditPatch = {};
        if (a.title !== undefined) {
          if (typeof a.title !== "string") return errorResult("title must be a string");
          patch.title = a.title.trim() ? a.title.trim() : null;
        }
        if (a.prePrompt !== undefined) {
          if (typeof a.prePrompt !== "string" || !a.prePrompt.trim()) return errorResult("prePrompt must be non-empty");
          patch.prePrompt = a.prePrompt.trim();
        }
        if (a.schedule !== undefined) {
          const schedule = parseSchedule(a.schedule);
          if (!schedule) return errorResult("invalid schedule");
          patch.schedule = schedule;
        }
        if (Object.keys(patch).length === 0) return errorResult("update needs title, prePrompt or schedule");
        try {
          const updated = await store.edit(record.id, patch);
          if (!updated) return errorResult("the schedule item could not be updated");
          return { output: JSON.stringify({ routineId: updated.id, schedule: updated.schedule }), isError: false };
        } catch (err) {
          return errorResult((err as Error).message ?? "routine_schedule update failed");
        }
      }
      // The item is listed under the calling conversation's project, resolved from its session. The tool cwd is not used: it can fall
      // back to the process cwd, which would file the item under an unrelated directory.
      const sessionId = ctx?.metadata?.sessionId;
      const projectRoot = typeof sessionId === "string" && sessionId ? deps.projectRootForSession(sessionId)?.trim() ?? "" : "";
      if (!projectRoot) {
        return { output: JSON.stringify({ error: "routine_schedule needs a chat that belongs to a project" }), isError: true };
      }

      // 대화에 연결: the host binds the calling chat; a session id in the input is never read.
      let targetSessionId: string | undefined;
      if (a.connectToThisChat === true) {
        if (a.execution !== "llm-session") return errorResult("connectToThisChat needs execution='llm-session': a notification has no turn");
        targetSessionId = typeof sessionId === "string" && sessionId ? deps.chatForSession(sessionId) : undefined;
        if (!targetSessionId) return errorResult("connectToThisChat needs a saved chat to connect to");
      } else if (a.connectToThisChat !== undefined && a.connectToThisChat !== false) {
        return errorResult("connectToThisChat must be a boolean");
      }

      const execution = a.execution;
      if (execution !== "llm-session" && execution !== "notification-only") {
        return {
          output: JSON.stringify({ error: "execution must be 'llm-session' or 'notification-only'" }),
          isError: true,
        };
      }

      const schedule = parseSchedule(a.schedule);
      if (!schedule) {
        return {
          output: JSON.stringify({
            error:
              "invalid schedule: provide at least { at } (ISO 8601) for non-cron schedules, " +
              "or { repeat: { kind: 'cron', expression: '...' } } for cron schedules",
          }),
          isError: true,
        };
      }

      if (execution === "llm-session") {
        if (typeof a.prePrompt !== "string" || (a.prePrompt as string).trim().length === 0) {
          return {
            output: JSON.stringify({ error: "prePrompt is required and must be non-empty for execution='llm-session'" }),
            isError: true,
          };
        }
      }

      if (execution === "notification-only") {
        if (typeof a.notificationTitle !== "string" || (a.notificationTitle as string).trim().length === 0) {
          return {
            output: JSON.stringify({ error: "notificationTitle is required and must be non-empty for execution='notification-only'" }),
            isError: true,
          };
        }
      }

      const prePrompt = execution === "llm-session"
        ? (typeof a.prePrompt === "string" ? a.prePrompt.trim() : undefined)
        : undefined;

      const notificationTitle = execution === "notification-only"
        ? (typeof a.notificationTitle === "string" ? a.notificationTitle.trim() : undefined)
        : undefined;
      const notificationBody = execution === "notification-only"
        ? (typeof a.notificationBody === "string" ? a.notificationBody.trim() : undefined)
        : undefined;

      const title = typeof a.title === "string" ? a.title.trim() : undefined;
      const allowedPlugins = parseAllowedPlugins(a.allowedPlugins);
      if (!allowedPlugins) {
        return {
          output: JSON.stringify({ error: "allowedPlugins must be an array of valid plugin id strings" }),
          isError: true,
        };
      }

      // Empty source is unset; the store revalidates the idempotency marker cap.
      const rawSource = typeof a.source === "string" ? a.source.trim() : undefined;
      if (rawSource !== undefined && rawSource.length > MAX_ROUTINE_SOURCE_LENGTH) {
        return {
          output: JSON.stringify({ error: `source must be at most ${MAX_ROUTINE_SOURCE_LENGTH} characters` }),
          isError: true,
        };
      }
      const source = rawSource && rawSource.length > 0 ? rawSource : undefined;

      // Missing or empty allowedPlugins means explicit deny-all; otherwise map to the canonical scope allowlist.
      const pluginIds = allowedPlugins.length === 0
        ? ({ mode: "deny-all" } as const)
        : ({ mode: "allow", ids: allowedPlugins } as const);

      try {
        const record = await store.add({
          trigger: "schedule",
          schedule,
          execution: execution as RoutineExecution,
          prePrompt,
          title,
          notificationTitle,
          notificationBody,
          scope: {
            pluginIds,
            forcedPluginIds: [],
            directories: [],
          },
          ...(source !== undefined ? { source } : {}),
          ...(targetSessionId !== undefined ? { targetSessionId } : {}),
          projectRoot,
          createdBy: "agent",
        });
        return {
          output: JSON.stringify({ routineId: record.id, schedule: record.schedule, ...(targetSessionId ? { connectedToThisChat: true } : {}) }),
          isError: false,
        };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: (err as Error).message ?? "routine_schedule failed",
          }),
          isError: true,
        };
      }
    },
  });
}
