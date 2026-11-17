import { isGraphHash, isStageId, isTemplateId, isTemplateVersion, WorkflowTemplateError } from "../../work-board/template-graph.js";
import type { RunAuthoritySource, TemplateVersionPin } from "../../shared/workflow-template-types.js";
import { registerWorkflowTemplateHandlers } from "../workflow-template-handlers.js";
// Work-board mutations use the store's lifecycle; execution and reports require their separately wired services.
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { broadcastToAppWindows } from "../window-fanout.js";
import type { IpcDeps } from "../types.js";
import type {
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkBoardCancelIpcResult,
  TemplateRunRequest,
  WorkBoardSteerIpcResult,
  WorkItemRunResult,
  StageGateDecideInput,
  StageGateDecideIpcResult,
  StageJoinDecideIpcResult,
  StageRetryIpcResult,
  WorkPlanDecideInput,
  WorkPlanDecideIpcResult,
  WorkPlanDecision,
} from "../../shared/work-board-types.js";
import { MAX_PLAN_NOTE_LENGTH } from "../../shared/work-board-types.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import { parseFileMentionReferences } from "../../shared/file-mention-reference.js";
import { sanitizeOutgoingInput } from "../handlers/chat.js";
import { PARENT_DIRECTIVE_MAX_CHARS } from "../../engine/parent-directive.js";
import { errorMessage } from "../../shared/error-message.js";
import { createLogger } from "../../lib/logger.js";
import { WorkBoardWriteRefusal } from "../../main/storage/rewrite-keeping-bytes.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { createDirStorage } from "../../work-board/storage.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import type {
  WorkItemCreateInput,
  WorkItemUpdateInput,
  WorkItemListFilter,
  WorkItemStatusStored,
  WorkItemChangedEventPayload,
  WorkItemGetResult,
  WorkItemResolved,
} from "../../main/work-board-store.js";
import { resolveAuthorizedWorkspaceProject } from "../../main/project-root-authorization.js";

const log = createLogger("work-board-ipc");
const NO_STORE = { ok: false, error: "no-store" as const };
const NO_ENGINE = { ok: false, error: "no-engine" as const };
const NO_REPORTER = { ok: false, error: "no-reporter" as const };
const UNAUTHORIZED_PROJECT_ROOT = "__ave_unauthorized_project_root__";
const PROJECT_NOT_ALLOWED_REASON = "project root is not authorized";

function normalizeProjectListFilter(filter?: WorkItemListFilter): WorkItemListFilter {
  const resolved = resolveAuthorizedWorkspaceProject(filter?.projectRoot);
  if (!resolved.authorized || !resolved.project) {
    return {
      ...filter,
      projectRoot: UNAUTHORIZED_PROJECT_ROOT,
      includeUnscoped: false,
    };
  }
  return {
    ...filter,
    projectRoot: resolved.project.projectRoot,
    includeUnscoped: resolved.project.isDefault === true,
  };
}

function normalizeCreateInputProject(input: WorkItemCreateInput):
  | { ok: true; input: WorkItemCreateInput }
  | { ok: false; result: { status: "invalid"; reason: string } } {
  const resolved = resolveAuthorizedWorkspaceProject(input?.projectRoot, input?.projectName);
  if (!resolved.authorized || !resolved.project) {
    return { ok: false, result: { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON } };
  }
  return {
    ok: true,
    input: {
      ...input,
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    },
  };
}

function isAuthorizedStoredWorkItem(item: WorkItemResolved): boolean {
  if (!item.projectRoot) return true;
  const resolved = resolveAuthorizedWorkspaceProject(item.projectRoot, item.projectName);
  return resolved.authorized && resolved.project !== null;
}

// A row that does not validate is checked as a stored item is, by its project; one whose project is not text names none that can be checked.
function isAuthorizedInvalidRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return true;
  const { projectRoot, projectName } = row as { projectRoot?: unknown; projectName?: unknown };
  if (projectRoot === undefined || projectRoot === "") return true;
  if (typeof projectRoot !== "string") return false;
  const resolved = resolveAuthorizedWorkspaceProject(projectRoot, typeof projectName === "string" ? projectName : undefined);
  return resolved.authorized && resolved.project !== null;
}

// The project an unreadable run record's own start names, never the row id it holds: the card's root for Create and run (none:
// unscoped), the approved scope of its schedule attachment. Undefined when that cannot be read.
async function runRecordOwner(entry: unknown, attachments: IpcDeps["workflowTemplateStore"]): Promise<{ projectRoot?: string } | undefined> {
  const source = typeof entry === "object" && entry !== null ? (entry as { runStartedBy?: unknown }).runStartedBy : undefined;
  if (typeof source !== "object" || source === null) return undefined;
  const { kind, projectRoot, attachmentId } = source as { kind?: unknown; projectRoot?: unknown; attachmentId?: unknown };
  if (kind === "local-create-and-run") return projectRoot === undefined ? {} : typeof projectRoot === "string" && projectRoot !== "" ? { projectRoot } : undefined;
  if (kind !== "schedule-attachment" || typeof attachmentId !== "string" || !attachments) return undefined;
  const scope = (await attachments.getAttachment(attachmentId).catch(() => null))?.approvedScope;
  return scope?.kind === "all" ? {} : scope?.kind === "project" ? { projectRoot: scope.projectRoot } : undefined;
}

// A run record that does not read is checked by the project its own start names and by every board row that names its run or could be
// the row it names.
async function runRecordVerdict(entry: unknown, rows: readonly unknown[], attachments: IpcDeps["workflowTemplateStore"]): Promise<boolean | "work-board-run-owner-unknown"> {
  const owner = await runRecordOwner(entry, attachments);
  if (owner === undefined) return "work-board-run-owner-unknown";
  return isAuthorizedInvalidRow(owner) && isAuthorizedInvalidRow(entry) && rows.every(isAuthorizedInvalidRow);
}

const hasExactly =(value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// `{ [key]: { position, hash } }` exactly, with a safe non-negative position and a sha-256 hash; anything else names no entry.
function entryTarget(target: unknown, key: "invalidRow" | "runRecord"): { position: number; hash: string } | undefined {
  if (!hasExactly(target, [key])) return undefined;
  const entry = target[key];
  if (!hasExactly(entry, ["position", "hash"])) return undefined;
  const { position, hash } = entry;
  return typeof position === "number" && Number.isSafeInteger(position) && position >= 0 && typeof hash === "string" && PLAN_HASH_PATTERN.test(hash) ? { position, hash } : undefined;
}

const PLAN_DECISIONS: readonly WorkPlanDecision[] = ["approve", "reject", "request_changes"];
const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Accept exactly `{ runId, planHash, decision, note? }`; anything else is invalid input, never a partial decision. */
function parseDecidePlanInput(raw: unknown): WorkPlanDecideInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "runId" && key !== "planHash" && key !== "decision" && key !== "note")) return null;
  const { runId, planHash, decision, note } = record;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return null;
  if (typeof planHash !== "string" || !PLAN_HASH_PATTERN.test(planHash)) return null;
  if (typeof decision !== "string" || !PLAN_DECISIONS.includes(decision as WorkPlanDecision)) return null;
  if (note !== undefined && typeof note !== "string") return null;
  return { runId, planHash, decision: decision as WorkPlanDecision, ...(note !== undefined ? { note } : {}) };
}

/** A plain object with no key outside `keys`; anything else is invalid input. */
function exactRecord(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return Object.keys(record).every((key) => keys.includes(key)) ? record : null;
}

/** Accept exactly `{ runId, stageId, attempt, resultHash, outputHash?, decision, note? }`; never a partial decision. */
function parseDecideStageInput(raw: unknown): StageGateDecideInput | null {
  const record = exactRecord(raw, ["runId", "stageId", "attempt", "resultHash", "outputHash", "decision", "note"]);
  if (!record) return null;
  const { runId, stageId, attempt, resultHash, outputHash, decision, note } = record;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !isStageId(stageId)) return null;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) return null;
  if (typeof resultHash !== "string" || !PLAN_HASH_PATTERN.test(resultHash)) return null;
  if (outputHash !== undefined && (typeof outputHash !== "string" || !PLAN_HASH_PATTERN.test(outputHash))) return null;
  if (typeof decision !== "string" || !PLAN_DECISIONS.includes(decision as WorkPlanDecision)) return null;
  if (note !== undefined && typeof note !== "string") return null;
  return { runId, stageId, attempt, resultHash, decision: decision as WorkPlanDecision, ...(outputHash !== undefined ? { outputHash } : {}), ...(note !== undefined ? { note } : {}) };
}

/** The `Create and run` tuple the user saw, with the project the card showed. Null when the renderer sent none or a malformed one. */
function parseTemplateRunTuple(raw: unknown): { pin: TemplateVersionPin; projectRoot?: string } | null {
  const record = exactRecord(raw, ["templateId", "version", "graphHash", "projectRoot"]);
  if (!record || !isTemplateId(record.templateId) || !isTemplateVersion(record.version) || !isGraphHash(record.graphHash)) return null;
  if (record.projectRoot !== undefined && (typeof record.projectRoot !== "string" || record.projectRoot.length === 0)) return null;
  return { pin: { templateId: record.templateId, version: record.version, graphHash: record.graphHash }, ...(record.projectRoot !== undefined ? { projectRoot: record.projectRoot } : {}) };
}

export function registerWorkBoardHandlers(deps: IpcDeps): void {
  registerWorkflowTemplateHandlers(deps);
  const { workBoardStore, workBoardEngine, workBoardReport, auditLogger } = deps;
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try { return await listener(event, ...args); }
      catch (error) {
        // A refusal reaches the renderer as its code; any other failure is thrown on.
        const code = error instanceof WorkBoardWriteRefusal ? error.code
          : error instanceof WorkflowTemplateError && error.code === "invalid-template-run" ? error.code : undefined;
        if (code === undefined) throw error;
        if (channel === WORK_BOARD.decidePlan) return { ok: false, reason: code };
        if (channel === WORK_BOARD.list || channel === WORK_BOARD.get || channel === WORK_BOARD.steerRun || channel === WORK_BOARD.cancelRun) {
          return { ok: false, error: code };
        }
        return { status: channel === WORK_BOARD.run ? "error" : "invalid", itemId: args[0], reason: code };
      }
    });
  };

  const isBoardOwnerFrame = (event: IpcMainInvokeEvent): boolean => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame) return false;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    return windows.some((window) => window && !window.isDestroyed() && window.webContents === sender);
  };

  const broadcastItemChanged = (
    itemId: number | undefined,
    change: WorkItemChangedEventPayload["change"],
  ): void => {
    const payload: WorkItemChangedEventPayload = {
      ...(itemId === undefined ? {} : { itemId }),
      change,
      changedAt: new Date().toISOString(),
    };
    broadcastToAppWindows(deps, WORK_BOARD.itemChanged, payload);
  };

  /** What the board shows of a template run comes from the host (the run file and the scheduler), never from the row. */
  const withTemplateRuns = async (items: readonly WorkItemResolved[]): Promise<WorkItemResolved[]> => {
    if (workBoardEngine) return workBoardEngine.projectTemplateRuns(items);
    return items.map((item) => { const clean = { ...item }; delete clean.templateRunState; return clean; });
  };

  const loadAuthorizedItem = async (id: number): Promise<WorkItemGetResult> => {
    if (!workBoardStore) return { status: "not_found", itemId: id };
    const result = await workBoardStore.get(id);
    if (result.status !== "found") return result;
    if (!isAuthorizedStoredWorkItem(result.item)) return { status: "not_found", itemId: id };
    return { ...result, item: (await withTemplateRuns([result.item]))[0] ?? result.item };
  };

  handle(WORK_BOARD.list, async (e, filter?: WorkItemListFilter) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const listed = await workBoardStore.list(normalizeProjectListFilter(filter));
    return listed.status === "ok" ? { ...listed, items: await withTemplateRuns(listed.items) } : listed;
  });

  handle(WORK_BOARD.get, async (e, id: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.get, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return loadAuthorizedItem(id);
  });

  handle(WORK_BOARD.add, async (e, input: WorkItemCreateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.add, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const normalized = normalizeCreateInputProject(input);
    if (!normalized.ok) return normalized.result;
    // A create never shows the renderer a raw failure.
    const result = await workBoardStore.create(normalized.input).catch((error: unknown) => {
      log.warn("[work-board] an item was not created: %s", errorMessage(error));
      return { status: "invalid" as const, reason: error instanceof WorkBoardWriteRefusal ? error.code : "work-board-write-failed" };
    });
    if (result.status === "created") broadcastItemChanged(result.itemId, "created");
    return result;
  });

  handle(WORK_BOARD.update, async (e, id: number, patch: WorkItemUpdateInput) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.update, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardStore.update(id, patch);
    if (result.status === "updated") broadcastItemChanged(result.itemId, "updated");
    return result;
  });

  handle(WORK_BOARD.transition, async (e, id: number, to: WorkItemStatusStored, expectedRevision?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.transition, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      return { status: "invalid", itemId: id, reason: "work-item-changed" };
    }
    const result = await workBoardStore.transition(id, to, "transitioned", expectedRevision);
    if (result.status === "transitioned") broadcastItemChanged(result.itemId, "transitioned");
    return result;
  });

  handle(WORK_BOARD.complete, async (e, id: number, expectedRevision?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.complete, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      return { status: "invalid", itemId: id, reason: "work-item-changed" };
    }
    const result = await workBoardStore.complete(id, expectedRevision);
    if (result.status === "completed") broadcastItemChanged(result.itemId, "completed");
    return result;
  });

  handle(WORK_BOARD.reopen, async (e, id: number, expectedRevision?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.reopen, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      return { status: "invalid", itemId: id, reason: "work-item-changed" };
    }
    const result = await workBoardStore.reopen(id, expectedRevision);
    if (result.status === "reopened") broadcastItemChanged(result.itemId, "reopened");
    return result;
  });

  handle(WORK_BOARD.remove, async (e, id: number | null, target?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    // An invalid card's delete or an unreadable run record's discard: by the entry's place and content in its file, never by an id or
    // through a listed item.
    if (id === null || hasExactly(target, ["invalidRow"]) || hasExactly(target, ["runRecord"])) {
      if (id !== null) return { ok: false, error: "invalid-input" };
      const row = entryTarget(target, "invalidRow");
      const runRecord = entryTarget(target, "runRecord");
      const result = row ? await workBoardStore.removeUnreadable(row, isAuthorizedInvalidRow)
        : runRecord ? await workBoardStore.discardUnreadableRun(runRecord, (entry, rows) => runRecordVerdict(entry, rows, deps.workflowTemplateStore))
        : undefined;
      if (result === undefined) return { ok: false, error: "invalid-input" };
      if (result.status === "deleted") broadcastItemChanged(result.itemId, "removed");
      return result;
    }
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    // A listed row's delete: only the row as its card showed it, so the run it names is the one the user saw.
    const revision = hasExactly(target, ["revision"]) ? target.revision : undefined;
    if (typeof revision !== "string" || !PLAN_HASH_PATTERN.test(revision)) return { status: "invalid", itemId: id, reason: "work-item-changed" };
    const result = await workBoardStore.remove(id, revision);
    if (result.status === "deleted") broadcastItemChanged(result.itemId, "removed");
    return result;
  });

  // The user's clear of a row shown template-run-not-found: only the row as its card showed it, naming that run.
  handle(WORK_BOARD.clearRun, async (e, id: number, target?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.clearRun, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!workBoardStore) return NO_STORE;
    if (!Number.isSafeInteger(id) || !hasExactly(target, ["revision", "runId"])) return { ok: false, error: "invalid-input" };
    const { revision, runId } = target;
    if (typeof revision !== "string" || !PLAN_HASH_PATTERN.test(revision) || typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return { ok: false, error: "invalid-input" };
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return existing;
    const result = await workBoardEngine.clearMissingRun(id, { revision, runId });
    if (result.status === "updated") broadcastItemChanged(result.itemId, "updated");
    return result;
  });

  // Run returns a terminal result while progress events update the renderer.
  handle(WORK_BOARD.run, async (e, id: number, opts?: { agentName?: string; template?: TemplateRunRequest }, intent?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!workBoardStore) return { status: "error", reason: "no-store" } satisfies WorkItemRunResult;
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return { status: "not_found" } satisfies WorkItemRunResult;
    if (!isBoardOwnerFrame(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.run, e);
      return UNAUTHORIZED_FRAME;
    }

    if (existing.item.templateRunError === "template-run-not-found") return { status: "error", reason: "template-run-not-found", reasonCode: "template-run-not-found" } satisfies WorkItemRunResult;
    if (existing.item.templateRunError) return { status: "error", reason: "invalid-template-run" } satisfies WorkItemRunResult;
    // A template run starts only from a consumed keyboard gesture, for the exact tuple and project the user saw on the card. The source
    // is minted here; nothing in a renderer payload is one.
    let templateSource: RunAuthoritySource | undefined;
    if (opts?.template !== undefined) {
      const refused = (code: string): WorkItemRunResult => ({ status: "error", reason: code, reasonCode: code });
      if (!hasUserKeyboardIntent(intent)) return refused("user-gesture-required");
      const tuple = parseTemplateRunTuple(opts?.template);
      if (tuple === null) return refused("invalid-input");
      let cardRoot: string | undefined;
      if (tuple.projectRoot !== undefined) {
        // The registry root replaces whatever alias the renderer sent, as the attach handler does.
        const resolved = resolveAuthorizedWorkspaceProject(tuple.projectRoot);
        if (!resolved.authorized || !resolved.project) return refused("scope-not-authorised");
        cardRoot = resolved.project.projectRoot;
      }
      templateSource = { kind: "local-create-and-run", pin: tuple.pin, ...(cardRoot !== undefined ? { projectRoot: cardRoot } : {}) };
    }
    broadcastToAppWindows(deps, WORK_BOARD.runStarted, {
      itemId: id,
      at: new Date().toISOString(),
    });
    try {
      const result: WorkItemRunResult = await workBoardEngine.runItem(
        id,
        { ...(opts?.agentName ? { agentName: opts.agentName } : {}), approvalSurface: e.sender, ...(templateSource ? { templateSource } : {}) },
      );
      broadcastToAppWindows(deps, WORK_BOARD.runFinished, {
        itemId: id,
        status: result.status,
        at: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const code = err instanceof WorkBoardWriteRefusal ? err.code : undefined;
      const reason = code ?? errorMessage(err);
      broadcastToAppWindows(deps, WORK_BOARD.runFailed, {
        itemId: id,
        reason,
        at: new Date().toISOString(),
      });
      // Convert engine failures to its stable error envelope; do not throw across IPC.
      return { status: "error", reason, ...(code === undefined ? {} : { reasonCode: code }) } satisfies WorkItemRunResult;
    }
  });

  // Steer a running execution (permission-decision-tree.md S→T). Only a sender-validated board-window main frame carrying a consumed local
  // keyboard gesture may steer; anything else is refused, never downgraded to another principal (contrast chat guide). The engine picks the
  // child from its own record and the text enters as host-fenced non-principal guidance, so the child's permissions do not widen.
  handle(WORK_BOARD.steerRun, async (e, id: number, text: unknown, intent?: unknown, stage?: unknown): Promise<WorkBoardSteerIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.steerRun, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!hasUserKeyboardIntent(intent)) return { ok: false, reason: "user-gesture-required" };
    // The same owner check as starting the run: a board window's main frame, never a subframe or another webContents. It precedes
    // the item lookup so a non-owner frame learns nothing about which items exist.
    if (!isBoardOwnerFrame(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.steerRun, e);
      return UNAUTHORIZED_FRAME;
    }
    const target = await loadAuthorizedItem(id);
    if (target.status !== "found") return { ok: false, reason: "not-found" };
    if (typeof text !== "string" || text.trim().length === 0) return { ok: false, reason: "empty-text" };
    // Bound the input before redaction and file-reference parsing do any work on it; the runner applies the same cap after masking.
    if (text.length > PARENT_DIRECTIVE_MAX_CHARS) return { ok: false, reason: "message-too-long" };
    // The execute child cannot open a composer file reference mid-run, exactly as a chat guide cannot.
    try {
      if (parseFileMentionReferences(text).length > 0) return { ok: false, reason: "file-reference-while-running" };
    } catch {
      return { ok: false, reason: "file-reference-invalid" };
    }
    // The same outgoing PII redaction as a keyboard send; its count is returned because the board has no conversation stream to notify.
    let redactedCount = 0;
    const effective = sanitizeOutgoingInput(deps.settingsService, (event) => {
      if (event.kind === "privacy.redacted") redactedCount += event.count;
    }, text);
    // A template run is steered by stage: the renderer names the stage and the engine resolves its live child from its own record, so a
    // renderer never picks a child. Anything but the exact `{ stageId }` shape is an ordinary steer.
    const named = exactRecord(stage, ["stageId"]);
    const result = named && isStageId(named.stageId) ? workBoardEngine.steerRun(id, effective, named.stageId) : workBoardEngine.steerRun(id, effective);
    if (!result.ok) return result;
    return redactedCount > 0 ? { ok: true, messageId: result.messageId, redactedCount } : { ok: true, messageId: result.messageId };
  });

  // The user's work approval of a stored plan (permission-decision-tree.md "Work approvals"): a user action on a host work object, outside
  // the tool tree. Same boundary as steer: a sender-validated board-window main frame with a consumed local keyboard gesture, refused
  // otherwise. The renderer names the run and the hash of the plan it showed, never the plan text; the engine checks both against the
  // stored item inside the board lock, stores the decision, and only then continues the run. A continuing run broadcasts its own
  // started/finished pair (`resumed`), so the board keeps the planning turns it already has.
  handle(
    WORK_BOARD.decidePlan,
    async (e, id: unknown, input: unknown, intent?: unknown): Promise<WorkPlanDecideIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.decidePlan, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardEngine) return NO_ENGINE;
      if (!hasUserKeyboardIntent(intent)) return { ok: false, reason: "user-gesture-required" };
      if (!isBoardOwnerFrame(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.decidePlan, e);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, reason: "invalid-input" };
      const parsed = parseDecidePlanInput(input);
      if (parsed === null) return { ok: false, reason: "invalid-input" };
      const existing = await loadAuthorizedItem(id);
      if (existing.status !== "found") return { ok: false, reason: "not_found" };
      if (existing.item.templateRunError) return { ok: false, reason: "invalid-template-run" };
      // Bound the note before redaction does any work on it; the engine checks the redacted note again.
      if (parsed.note !== undefined && parsed.note.length > MAX_PLAN_NOTE_LENGTH) return { ok: false, reason: "note_too_long" };
      let redactedCount = 0;
      const note = parsed.note === undefined
        ? undefined
        : sanitizeOutgoingInput(deps.settingsService, (event) => {
          if (event.kind === "privacy.redacted") redactedCount += event.count;
        }, parsed.note);
      const outcome = await workBoardEngine.decidePlan(
        id,
        { runId: parsed.runId, planHash: parsed.planHash, decision: parsed.decision, ...(note !== undefined ? { note } : {}) },
        { approvalSurface: e.sender },
      );
      if (!outcome.result.ok) return outcome.result;
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: `work-board:${id}`,
        type: "approval",
        // The decision only; the note body stays on the item.
        output: JSON.stringify({
          event: "work-approval:decided",
          runId: parsed.runId,
          plan: parsed.planHash.slice(0, 8),
          decision: outcome.result.status,
          note: note !== undefined,
        }),
      });
      broadcastItemChanged(id, "updated");
      if (outcome.continuation) {
        broadcastToAppWindows(deps, WORK_BOARD.runStarted, { itemId: id, at: new Date().toISOString(), resumed: true });
        void outcome.continuation.then(
          (result) => broadcastToAppWindows(deps, WORK_BOARD.runFinished, { itemId: id, status: result.status, at: new Date().toISOString() }),
          (err: unknown) => broadcastToAppWindows(deps, WORK_BOARD.runFailed, { itemId: id, reason: errorMessage(err), at: new Date().toISOString() }),
        );
      }
      return redactedCount > 0 ? { ...outcome.result, redactedCount } : outcome.result;
    },
  );

  /** The work-approval boundary every stage decision shares with decide-plan: a validated sender, a consumed local keyboard gesture, the
   * board window's main frame, and an item this window may see. Returns the refusal, or null when the caller may go on. */
  const stageDecisionRefusal = async (channel: string, e: IpcMainInvokeEvent, id: unknown, intent: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, channel, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!hasUserKeyboardIntent(intent)) return { ok: false as const, reason: "user-gesture-required" as const };
    if (!isBoardOwnerFrame(e)) {
      auditUnauthorized(auditLogger, channel, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false as const, reason: "invalid-input" as const };
    const existing = await loadAuthorizedItem(id);
    if (existing.status !== "found") return { ok: false as const, reason: "not_found" as const };
    return null;
  };
  const auditStageDecision = (id: number, detail: Record<string, unknown>): void => {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: `work-board:${id}`,
      type: "approval",
      output: JSON.stringify({ event: "work-approval:stage-decided", origin: "local-desktop", ...detail }),
    });
  };

  // The user's decision at a stage gate of a template run: the same boundary as decide-plan. The renderer names the run, the stage, the
  // attempt and the hash of the output it showed, never the output; the engine checks each against the stored run before anything changes.
  handle(
    WORK_BOARD.decideStage,
    async (e, id: unknown, input: unknown, intent?: unknown): Promise<StageGateDecideIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
      const refusal = await stageDecisionRefusal(WORK_BOARD.decideStage, e, id, intent);
      if (refusal !== null) return refusal;
      const parsed = parseDecideStageInput(input);
      if (parsed === null || !workBoardEngine) return { ok: false, reason: "invalid-input" };
      // Bound the note before redaction does any work on it; the engine checks the redacted note again.
      if (parsed.note !== undefined && parsed.note.length > MAX_PLAN_NOTE_LENGTH) return { ok: false, reason: "note_too_long" };
      let redactedCount = 0;
      const note = parsed.note === undefined
        ? undefined
        : sanitizeOutgoingInput(deps.settingsService, (event) => {
          if (event.kind === "privacy.redacted") redactedCount += event.count;
        }, parsed.note);
      const { note: _sent, ...bound } = parsed;
      const result = await workBoardEngine.decideStageGate(id as number, { ...bound, ...(note !== undefined ? { note } : {}) }, { approvalSurface: e.sender });
      if (!result.ok) return result;
      // The decision only; the note body stays on the item.
      auditStageDecision(id as number, { runId: parsed.runId, stageId: parsed.stageId, attempt: parsed.attempt, result: parsed.resultHash.slice(0, 8), decision: result.status, note: note !== undefined });
      broadcastItemChanged(id as number, "updated");
      return redactedCount > 0 ? { ...result, redactedCount } : result;
    },
  );

  handle(
    WORK_BOARD.decideJoin,
    async (e, id: unknown, input: unknown, intent?: unknown): Promise<StageJoinDecideIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
      const refusal = await stageDecisionRefusal(WORK_BOARD.decideJoin, e, id, intent);
      if (refusal !== null) return refusal;
      const record = exactRecord(input, ["runId", "joinId", "conflictHash", "decision"]);
      if (!record || !workBoardEngine || typeof record.runId !== "string" || !RUN_ID_PATTERN.test(record.runId) || !isTemplateId(record.joinId)
        || typeof record.conflictHash !== "string" || !PLAN_HASH_PATTERN.test(record.conflictHash) || (record.decision !== "retry_merge" && record.decision !== "reject")) {
        return { ok: false, reason: "invalid-input" };
      }
      const result = await workBoardEngine.decideStageJoin(id as number, { runId: record.runId, joinId: record.joinId, conflictHash: record.conflictHash, decision: record.decision }, { approvalSurface: e.sender });
      if (!result.ok) return result;
      auditStageDecision(id as number, { runId: record.runId, joinId: record.joinId, conflict: record.conflictHash.slice(0, 8), decision: record.decision });
      broadcastItemChanged(id as number, "updated");
      return result;
    },
  );

  handle(
    WORK_BOARD.retryStage,
    async (e, id: unknown, input: unknown, intent?: unknown): Promise<StageRetryIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
      const refusal = await stageDecisionRefusal(WORK_BOARD.retryStage, e, id, intent);
      if (refusal !== null) return refusal;
      const record = exactRecord(input, ["runId", "stageId"]);
      if (!record || !workBoardEngine || typeof record.runId !== "string" || !RUN_ID_PATTERN.test(record.runId) || !isStageId(record.stageId)) return { ok: false, reason: "invalid-input" };
      const result = await workBoardEngine.retryStage(id as number, { runId: record.runId, stageId: record.stageId }, { approvalSurface: e.sender });
      if (!result.ok) return result;
      auditStageDecision(id as number, { runId: record.runId, stageId: record.stageId, decision: "retry" });
      broadcastItemChanged(id as number, "updated");
      return result;
    },
  );

  // Stop a running execution through the ordinary sub-agent interrupt; the run settles as `cancelled`. Same gate as steer.
  handle(WORK_BOARD.cancelRun, async (e, id: number, intent?: unknown): Promise<WorkBoardCancelIpcResult | typeof UNAUTHORIZED_FRAME | typeof NO_ENGINE> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.cancelRun, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardEngine) return NO_ENGINE;
    if (!hasUserKeyboardIntent(intent)) return { ok: false, reason: "user-gesture-required" };
    // The same owner check as starting the run: a board window's main frame, never a subframe or another webContents. It precedes
    // the item lookup so a non-owner frame learns nothing about which items exist.
    if (!isBoardOwnerFrame(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.cancelRun, e);
      return UNAUTHORIZED_FRAME;
    }
    if ((await loadAuthorizedItem(id)).status !== "found") return { ok: false, reason: "not-found" };
    return workBoardEngine.cancelRun(id);
  });

  // Preserve the reporter's ok/empty result and map provider failure to the public error envelope.
  handle(
    WORK_BOARD.generateReport,
    async (
      e,
      kind: "daily" | "weekly",
      input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.generateReport, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardReport) return NO_REPORTER;
      try {
        return await workBoardReport.generate(kind === "weekly" ? "weekly" : "daily", normalizeProjectListFilter(input));
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error" as const, kind, reason };
      }
    },
  );

  handle(WORK_BOARD.runTranscript, async (e, itemId: number, runId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.runTranscript, e);
      return UNAUTHORIZED_FRAME;
    }
    // Validate run UUIDs before interpolating transcript paths to prevent traversal.
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) return { events: [] };
    if (!workBoardStore) return { events: [] };
    const existing = await loadAuthorizedItem(itemId);
    if (existing.status !== "found") return { events: [] };
    const storage = createDirStorage(openFeatureNamespace("work-board").dir);
    return { events: await readRunTranscript(storage, itemId, runId) };
  });

  // Resolve the active project when accepting; unscoped proposals do not choose project identity.
  handle(WORK_BOARD.acceptProposal, async (e, proposalId: string, projectRoot?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.acceptProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    if (typeof proposalId !== "string" || proposalId.length === 0) {
      return { status: "invalid", reason: "proposalId is required" };
    }
    const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
    if (!resolved.authorized || !resolved.project) {
      return { status: "invalid", reason: PROJECT_NOT_ALLOWED_REASON };
    }
    const result = await workBoardStore.acceptProposal(proposalId, {
      projectRoot: resolved.project.projectRoot,
      projectName: resolved.project.projectName,
    });
    if (result.status === "accepted") {
      broadcastItemChanged(result.itemId, "created");
    }
    return result;
  });

  handle(WORK_BOARD.dismissProposal, async (e, proposalId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, WORK_BOARD.dismissProposal, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!workBoardStore) return NO_STORE;
    return workBoardStore.dismissProposal(proposalId);
  });

  // Briefing surveys through a read-only child and creates proposals rather than executing work.
  handle(
    WORK_BOARD.runBriefing,
    async (e, kind: WorkBoardBriefingKind, projectRoot?: string) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.runBriefing, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!workBoardEngine) return NO_ENGINE;
      const briefingKind: WorkBoardBriefingKind = kind === "weekly" ? "weekly" : "daily";
      const resolved = resolveAuthorizedWorkspaceProject(projectRoot);
      if (!resolved.authorized || !resolved.project) {
        return {
          status: "error",
          kind: briefingKind,
          reason: PROJECT_NOT_ALLOWED_REASON,
        } satisfies WorkBoardBriefingResult;
      }
      if (!isBoardOwnerFrame(e)) {
        auditUnauthorized(auditLogger, WORK_BOARD.runBriefing, e);
        return UNAUTHORIZED_FRAME;
      }
      try {
        const result = await workBoardEngine.runBriefing(briefingKind, {
          projectRoot: resolved.project.projectRoot,
          includeUnscoped: resolved.project.isDefault === true,
          approvalSurface: e.sender,
        });
        return result;
      } catch (err) {
        const reason = errorMessage(err);
        return { status: "error", kind: briefingKind, reason } satisfies WorkBoardBriefingResult;
      }
    },
  );
}
