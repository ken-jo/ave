/** Use host-local report windows; skip empty periods without model calls and propagate generation failures. Persist real reports before adding a bounded memory summary. */
import {
  appendMemory,
  renderWorkContext,
  type MemoryStorage,
} from "./work-memory.js";
import { readActivity, type ActivityStorage } from "./activity-log.js";
import { workBoardProjectStorageKey } from "./project-storage.js";
import { localDateKey } from "../shared/local-date.js";
import { isoWeekFor, localDayBounds, sundayWeekBoundsLocal } from "./schedule.js";
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemListResult,
  WorkItemResolved,
  WorkBoardReportKind,
  WorkItemListFilter,
} from "../shared/work-board-types.js";

interface CallLlm {
  (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
}

interface ReportBoardReader {
  list(filter?: WorkItemListFilter): Promise<WorkItemListResult>;
}

type ReportStorage = Pick<WorkBoardStorage, "write" | "mkdir">;

type ReportKind = WorkBoardReportKind;

/** The reporter throws generation errors; only IPC wraps them into error envelopes. */
type ReportResult =
  | { status: "ok"; kind: ReportKind; period: string; markdown: string }
  | { status: "empty"; kind: ReportKind; period: string; reason: string };

interface DailyReportInput {
  date?: string;
  projectRoot?: string;
  includeUnscoped?: boolean;
}

interface WeeklyReportInput {
  weekIso?: string;
  weekOffset?: number;
  projectRoot?: string;
  includeUnscoped?: boolean;
}

type ReportProjectOptions = Pick<DailyReportInput, "projectRoot" | "includeUnscoped">;

const REPORT_GENERATED_EVENT = "work_board.report.generated";

const DAILY_DIR = "reports/daily";
const WEEKLY_DIR = "reports/weekly";
const PROJECT_REPORTS_DIR = "reports/projects";
const DAILY_SYSTEM_PROMPT =
  "You are a personal Work Board assistant. Summarize today's work progress in concise English Markdown.";
const WEEKLY_SYSTEM_PROMPT =
  "You are a personal Work Board assistant. Summarize the week as a five-section English Markdown weekly report: Wins / Issues / Next Week / Support Needed / Metrics.";
const WEEKLY_PROMPT_SUFFIX =
  "Based on the data above, write a five-section English Markdown weekly report: " +
  "## Wins / ## Issues / ## Next Week / ## Support Needed / ## Metrics. " +
  "In the Metrics section, summarize completed, newly created, and overdue counts.";

export interface WorkBoardReporterDeps {
  store: ReportBoardReader;
  storage: WorkBoardStorage;
  callLlm: CallLlm;
  emit?: (type: string, data?: unknown) => void;
  now?: () => number;
}

export interface WorkBoardReporter {
  generateDaily(input?: DailyReportInput): Promise<ReportResult>;
  generateWeekly(input?: WeeklyReportInput): Promise<ReportResult>;
  generate(kind: ReportKind, input?: DailyReportInput & WeeklyReportInput): Promise<ReportResult>;
}

function lineFor(item: WorkItemResolved): string {
  // Project due instants through the host calendar; UTC prefixes can name the previous picked day.
  const due = item.due_at ? ` (due ${localDateKey(new Date(item.due_at))})` : "";
  return `- [${item.priority}] #${item.id} ${item.title}${due}`;
}

function isWithin(iso: string | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t < endMs;
}

function bucket(label: string, items: WorkItemResolved[]): string {
  return `## ${label} (${items.length})\n${items.length ? items.map(lineFor).join("\n") : "- None"}`;
}

function reportDir(kind: ReportKind, projectRoot: string | undefined): string {
  const key = workBoardProjectStorageKey(projectRoot);
  if (!key) return kind === "daily" ? DAILY_DIR : WEEKLY_DIR;
  return `${PROJECT_REPORTS_DIR}/${key}/${kind}`;
}

export function createWorkBoardReporter(deps: WorkBoardReporterDeps): WorkBoardReporter {
  const { store, storage, callLlm } = deps;
  const memory: MemoryStorage = storage;
  const activity: ActivityStorage = storage;
  const report: ReportStorage = storage;
  const nowMs = (): number => (deps.now ? deps.now() : Date.now());

  async function items(input?: { projectRoot?: string; includeUnscoped?: boolean }): Promise<WorkItemResolved[]> {
    const listed = await store.list(input?.projectRoot
      ? { projectRoot: input.projectRoot, includeUnscoped: input.includeUnscoped === true }
      : undefined);
    // Non-ok board lists are unreadable; callers currently project them to an empty report.
    return listed.status === "ok" ? listed.items : [];
  }

  async function generateDaily(input?: DailyReportInput): Promise<ReportResult> {
    const period = input?.date ?? localDateKey(new Date(nowMs()));
    const bounds = localDayBounds(period);
    if (!bounds) {
      return { status: "empty", kind: "daily", period, reason: "invalid date — expected YYYY-MM-DD" };
    }

    const all = await items(input);
    if (all.length === 0) {
      return { status: "empty", kind: "daily", period, reason: "No work items on the board." };
    }

    const planned = all.filter((i) => i.status_resolved === "planned");
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const overdue = all.filter((i) => i.status_resolved === "overdue");
    const createdToday = all.filter((i) => isWithin(i.created_at, bounds.startMs, bounds.endMs));
    const completedToday = all.filter((i) => isWithin(i.completed_at, bounds.startMs, bounds.endMs));

    const visibleItemIds = new Set(all.map((item) => item.id));
    const recentActivity = (await readActivity(activity, new Date(bounds.startMs).toISOString()))
      .filter((event) => event.itemId === undefined || visibleItemIds.has(event.itemId));
    const projectOptions: ReportProjectOptions = {
      ...(input?.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input?.includeUnscoped === true ? { includeUnscoped: true } : {}),
    };
    const workContext = await renderWorkContext(memory, 40, projectOptions);

    const prompt =
      [
        `# ${period} Daily Report Input`,
        workContext,
        bucket("Completed Today", completedToday),
        bucket("Created Today", createdToday),
        bucket("In Progress", inProgress),
        bucket("Planned", planned),
        bucket("Overdue", overdue),
        `## Today's Activity Log (${recentActivity.length})\n${
          recentActivity.length
            ? recentActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- None"
        }`,
      ].join("\n\n") +
      "\n\nBased on the data above, summarize today's work with this structure: " +
      "1) Today's Wins, 2) Work in Progress, 3) Overdue Items That Need Attention, 4) Tomorrow's Priorities. " +
      "Write concise English Markdown.";

    const markdown = await callLlm(prompt, { maxTokens: 800, systemPrompt: DAILY_SYSTEM_PROMPT });

    const dir = reportDir("daily", input?.projectRoot);
    await report.mkdir(dir);
    await report.write(`${dir}/${period}.md`, markdown);
    await appendMemory(
      memory,
      [
        `${period}: completed ${completedToday.length} · created ${createdToday.length} · in progress ${inProgress.length} · overdue ${overdue.length}`,
      ],
      projectOptions,
    );
    deps.emit?.(REPORT_GENERATED_EVENT, { kind: "daily", period });

    return { status: "ok", kind: "daily", period, markdown };
  }

  async function generateWeekly(input?: WeeklyReportInput): Promise<ReportResult> {
    // Validate week labels before path interpolation to prevent traversal, matching the daily date guard.
    if (input?.weekIso !== undefined && !/^\d{4}-W\d{2}$/.test(input.weekIso)) {
      return {
        status: "empty",
        kind: "weekly",
        period: input.weekIso,
        reason: "invalid week — expected YYYY-Www",
      };
    }
    const ref = new Date(nowMs());
    const { start, end } = sundayWeekBoundsLocal(ref, input?.weekOffset ?? 0);
    const period = input?.weekIso ?? isoWeekFor(start);
    const startMs = start.getTime();
    const endMs = end.getTime();

    const all = await items(input);
    const completedThisWeek = all.filter((i) => isWithin(i.completed_at, startMs, endMs));
    const createdThisWeek = all.filter((i) => isWithin(i.created_at, startMs, endMs));
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const planned = all.filter((i) => i.status_resolved === "planned");
    const overdue = all.filter((i) => i.status_resolved === "overdue");

    const visibleItemIds = new Set(all.map((item) => item.id));
    const weekActivity = (await readActivity(activity, start.toISOString()))
      .filter((event) => event.itemId === undefined || visibleItemIds.has(event.itemId));

    if (completedThisWeek.length === 0 && createdThisWeek.length === 0 && weekActivity.length === 0) {
      return { status: "empty", kind: "weekly", period, reason: "No board activity this week." };
    }

    const projectOptions: ReportProjectOptions = {
      ...(input?.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input?.includeUnscoped === true ? { includeUnscoped: true } : {}),
    };
    const workContext = await renderWorkContext(memory, 40, projectOptions);
    const prompt =
      [
        // Project local bounds to day labels; subtract one millisecond from exclusive end for the final included day.
        `# ${period} Weekly Report Input (${localDateKey(start)} ~ ${localDateKey(new Date(end.getTime() - 1))})`,
        workContext,
        bucket("Completed This Week", completedThisWeek),
        bucket("Created This Week", createdThisWeek),
        bucket("In Progress", inProgress),
        bucket("Planned", planned),
        bucket("Overdue", overdue),
        `## Activity Log (${weekActivity.length})\n${
          weekActivity.length
            ? weekActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- None"
        }`,
      ].join("\n\n") +
      `\n\n${WEEKLY_PROMPT_SUFFIX}`;

    const markdown = await callLlm(prompt, { maxTokens: 1000, systemPrompt: WEEKLY_SYSTEM_PROMPT });

    const dir = reportDir("weekly", input?.projectRoot);
    await report.mkdir(dir);
    await report.write(`${dir}/${period}.md`, markdown);
    await appendMemory(
      memory,
      [`${period}: weekly completed ${completedThisWeek.length} · created ${createdThisWeek.length} · overdue ${overdue.length}`],
      projectOptions,
    );
    deps.emit?.(REPORT_GENERATED_EVENT, { kind: "weekly", period });

    return { status: "ok", kind: "weekly", period, markdown };
  }

  return {
    generateDaily,
    generateWeekly,
    generate: (kind, input) =>
      kind === "weekly" ? generateWeekly(input) : generateDaily(input),
  };
}
