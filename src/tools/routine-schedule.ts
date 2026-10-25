// Persist future-triggered routines across restarts; calendar-event lookup belongs to plugins.
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { RoutineExecution, RoutineRepeat, RoutineSchedule } from "../main/routines-store.js";
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

export function routineScheduleApprovalCacheKey(rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const allowedPlugins = parseAllowedPlugins(input.allowedPlugins);
  if (!allowedPlugins) return "scope:invalid";
  if (allowedPlugins.length === 0) return "scope:deny-all";
  return `scope:allow:${[...allowedPlugins].sort().join(",")}`;
}

export function createRoutineScheduleTool(store: RoutinesStore): Tool {
  return createDynamicTool({
    name: "routine_schedule",
    description: t("be_routineSchedule.toolDescription"),
    source: "builtin",
    category: "write",
    approvalCacheKey: routineScheduleApprovalCacheKey,
    jsonSchema: {
      type: "object",
      required: ["execution", "schedule"],
      properties: {
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
    execute: async (rawInput) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;

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
        });
        return {
          output: JSON.stringify({ routineId: record.id, schedule: record.schedule }),
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
