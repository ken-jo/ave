import type { AuditLogger } from "../audit/audit-logger.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import { hasUnsafeDirectiveControlChars } from "../engine/parent-directive.js";
import type { TailnetWorkDecisionHandler } from "../api/tailnet-surface-server.js";
import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { SettingsService } from "../data/settings-store.js";
import { createToolEffectResolver } from "../permissions/tool-effect-evidence.js";
import type { TailnetRequestedOutputDecision, TailnetRequestedOutputReview, TailnetWorkDecisionRequest, TailnetWorkDecisionResponse, TailnetWorkReview } from "../shared/tailnet-work-decisions.js";
import { MAX_PLAN_NOTE_LENGTH, workBoardOriginSessionId } from "../shared/work-board-types.js";
import { isWorkflowTemplateProposalId, type TemplateScope, type TemplateVersionPin, type WorkflowTemplateDraftInput } from "../shared/workflow-template-types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { WORK_DECISION_AUTHORITY_REVOKED, WorkDecisionAuthorityError } from "../work-board/work-decision-authority.js";
import { isAuthorizedWorkspaceProjectRoot, listAuthorizedWorkspaceProjects, resolveAuthorizedWorkspaceProject } from "./project-root-authorization.js";
import { maskWorkflowText } from "../work-board/workflow/run-read-projection.js";
import { planScope, planView, workflowApprovalViews } from "./work-approval-review.js";
import type { RoutinesStore } from "./routines-store.js";
import type { WorkBoardStore } from "./work-board-store.js";
import { attachWorkflowSchedule } from "./workflow-schedule-attachment.js";
import { mintHostDecisionProof, type HostDecisionProof, type RemoteWorkDecisionEvidence } from "./workflow-template-decision.js";
import type { WorkflowTemplateStore } from "./workflow-template-store.js";

interface TailnetWorkDecisionServices {
  workBoardStore: WorkBoardStore;
  workBoardEngine: WorkBoardEngine;
  workflowTemplateStore: WorkflowTemplateStore;
  routinesStore: RoutinesStore;
  auditLogger: Pick<AuditLogger, "log">;
  settingsService: Pick<SettingsService, "get">;
  toolRegistry: Pick<ToolRegistry, "findByName">;
}

type RequestedOutputDecision = { ok: true } | { ok: false; error: string };

type RequestedOutputBinding = TailnetRequestedOutputReview["binding"]["input"];

/** The owner rechecks the aggregate stage binding and authority at its own commit. Approved executions wait for a local window. */
interface RequestedOutputDecisions {
  list(binding: RequestedOutputBinding, evidence: RemoteWorkDecisionEvidence): Promise<TailnetRequestedOutputReview["review"] | null>;
  decide(input: TailnetRequestedOutputDecision, evidence: RemoteWorkDecisionEvidence, note?: string): Promise<RequestedOutputDecision>;
}

export interface TailnetWorkDecisions {
  readonly decide: TailnetWorkDecisionHandler;
  list(evidence: RemoteWorkDecisionEvidence): Promise<readonly TailnetWorkReview[]>;
  registerRequestedOutputDecision(handler: RequestedOutputDecisions): () => void;
}

type StartRequest = Extract<TailnetWorkDecisionRequest, { kind: "create-and-run" }>["input"];
const refused = (error: string) => ({ ok: false as const, error });
const scopeAuthorised = (scope: TemplateScope) => scope.kind === "all" || isAuthorizedWorkspaceProjectRoot(scope.projectRoot);

function withProjectAuthority(evidence: RemoteWorkDecisionEvidence, projectRoot: string | undefined): RemoteWorkDecisionEvidence {
  if (projectRoot === undefined) return evidence;
  const isCurrent = () => evidence.authority.isCurrent() && isAuthorizedWorkspaceProjectRoot(projectRoot);
  return { ...evidence, authority: {
    isCurrent,
    refreshCurrent: async () => await evidence.authority.refreshCurrent() && isCurrent(),
  } };
}

export function createTailnetWorkDecisions(services: Partial<TailnetWorkDecisionServices>): TailnetWorkDecisions | undefined {
  if (!services.workBoardStore || !services.workBoardEngine || !services.workflowTemplateStore
    || !services.routinesStore || !services.auditLogger || !services.settingsService || !services.toolRegistry) return undefined;
  const board = services.workBoardStore;
  const engine = services.workBoardEngine;
  const templates = services.workflowTemplateStore;
  const routines = services.routinesStore;
  const auditLogger = services.auditLogger;
  const settingsService = services.settingsService;
  const effects = createToolEffectResolver(services.toolRegistry);
  let outputRegistration: RequestedOutputDecisions | undefined;

  function withOutputAuthority(evidence: RemoteWorkDecisionEvidence, registered: RequestedOutputDecisions): RemoteWorkDecisionEvidence {
    const isCurrent = () => outputRegistration === registered && evidence.authority.isCurrent();
    return { ...evidence, authority: { isCurrent, refreshCurrent: async () => await evidence.authority.refreshCurrent() && isCurrent() } };
  }

  async function decideOutputs(input: TailnetRequestedOutputDecision, evidence: RemoteWorkDecisionEvidence, note?: string): Promise<RequestedOutputDecision> {
    const registered = outputRegistration;
    if (!registered) return refused("requested-output-unavailable");
    const scoped = withOutputAuthority(evidence, registered);
    if (!await scoped.authority.refreshCurrent()) return refused(WORK_DECISION_AUTHORITY_REVOKED);
    return registered.decide(input, scoped, note);
  }

  async function list(evidence: RemoteWorkDecisionEvidence): Promise<readonly TailnetWorkReview[]> {
    if (!evidence.authority.isCurrent()) return [];
    const [items, records, schedules] = await Promise.all([
      board.readApprovalItems(), templates.listReviewRecords(), routines.listScheduleDisplay(),
    ]);
    if (!items) throw new Error("Work approval rows are unavailable");
    const projects = listAuthorizedWorkspaceProjects().map(({ projectRoot, projectName, isDefault }) => ({
      projectRoot, projectName, isDefault: isDefault === true,
    }));
    const rows = items.filter(item => planScope(item, projects) !== null);
    const review: TailnetWorkReview[] = [];
    for (const item of rows) {
      const view = planView(item, projects);
      if (view?.phase === "pending") {
        const { itemId, runId, planHash } = view;
        review.push({ kind: "plan", deny: "reject", binding: { itemId, input: { runId, planHash } }, review: view });
      }
    }
    for (const item of await engine.readTemplateRuns(rows.filter(row => row.templateId !== undefined && row.runId !== undefined), "tailnet")) {
      for (const view of workflowApprovalViews(item, projects)) {
        if (view.kind === "join-conflict") {
          review.push({ kind: "join", deny: "reject", binding: { itemId: item.id, input: view.binding }, review: view });
          continue;
        }
        review.push({ kind: "stage", deny: "reject", binding: { itemId: item.id, input: view.binding }, review: view });
        const registered = outputRegistration;
        const { outputHash, runId, stageId, attempt } = view.binding;
        if (!registered || !outputHash) continue;
        const scoped = withOutputAuthority(withProjectAuthority(evidence, item.projectRoot), registered);
        if (!scoped.authority.isCurrent()) continue;
        const input = { itemId: item.id, runId, stageId, attempt, outputHash };
        const payload = await registered.list(input, scoped);
        if (payload && scoped.authority.isCurrent()) {
          review.push({ kind: "requested-output", deny: "reject", binding: { input }, review: payload });
        }
      }
    }
    const confirmations = (templateId: string, expectedDraftRevision: string, expectedGraphHash: string, draft: WorkflowTemplateDraftInput) => {
      if (scopeAuthorised(draft.scope)) review.push({
        kind: "template-confirmation", deny: "dismiss",
        binding: { templateId, input: { expectedDraftRevision, expectedGraphHash } }, review: draft,
      });
    };
    for (const proposal of templates.listProposals(evidence.conversationId)) {
      confirmations(proposal.id, proposal.id, proposal.graphHash, proposal.draft);
    }
    const scheduleReviews = schedules.routines.flatMap(routine => {
      const { schedule, projectRoot, lastFailure } = routine;
      if (routine.execution !== "template-run" || !schedule || routine.templateAttention === "attachment-unavailable"
        || (projectRoot !== undefined && !isAuthorizedWorkspaceProjectRoot(projectRoot))) return [];
      return [{ routine, schedule, lastFailure }];
    });
    const attachedScheduleIds = new Set(scheduleReviews
      .filter(({ routine }) => routine.attachmentId !== undefined).map(({ routine }) => routine.id));
    const attachments = attachedScheduleIds.size === 0 ? undefined : await templates.listActiveScheduleAttachments(attachedScheduleIds);
    for (const { template, versions, draft } of records) {
      const { name, scope } = template;
      const scopedRoot = scope.kind === "project" ? resolveAuthorizedWorkspaceProject(scope.projectRoot).project?.projectRoot : undefined;
      if (scope.kind === "project" && scopedRoot === undefined) continue;
      if (draft) {
        const { revision, graphHash, updatedAt: _updatedAt, ...graph } = draft;
        confirmations(template.id, revision, graphHash, graph);
      }
      const current = versions.find(version => version.version === template.currentVersion);
      if (!current) continue;
      const { templateId, version, graphHash, stages, edges, setupCommands } = current;
      const pin = { templateId, version, graphHash };
      const choices = scope.kind === "all" ? projects : projects.filter(project => project.projectRoot === scopedRoot);
      const projectRoot = choices.find(project => project.isDefault)?.projectRoot ?? choices[0]?.projectRoot;
      review.push({
        kind: "create-and-run", deny: "dismiss",
        binding: { input: { ...pin, title: name, ...(projectRoot === undefined ? {} : { projectRoot }) } },
        review: { name, scope, graph: { stages, edges, setupCommands }, projects: choices },
      });
      for (const { routine, schedule, lastFailure } of scheduleReviews) {
        const active = attachments?.get(routine.id);
        const prior = active && active.attachment.id === routine.attachmentId && scopeAuthorised(active.template.scope)
          ? active.attachment : undefined;
        review.push({
          kind: "schedule-attachment", deny: "dismiss",
          binding: { input: { ...pin, expectedScope: scope, scheduleId: routine.id } },
          review: {
            name, ...(prior ? { existingPin: { templateId: prior.templateId, version: prior.version, graphHash: prior.graphHash } } : {}),
            routine: {
              schedule, title: routine.title && maskWorkflowText(routine.title), templateAttention: routine.templateAttention,
              pausedAt: routine.pausedAt, lastTemplateSkip: routine.lastTemplateSkip,
              lastFailure: lastFailure?.kind === "error" ? { ...lastFailure, reason: maskWorkflowText(lastFailure.reason) } : lastFailure,
            },
          },
        });
      }
    }
    return evidence.authority.isCurrent() ? review : [];
  }

  async function start(input: StartRequest, evidence: RemoteWorkDecisionEvidence): Promise<TailnetWorkDecisionResponse> {
    const { templateId, version, graphHash, projectRoot, title, detail } = input;
    const pin: TemplateVersionPin = { templateId, version, graphHash };
    const { template } = await templates.get(templateId);
    requireTemplate(template.archivedAt === undefined, "template-archived");
    requireTemplate(template.currentVersion === version, "not-current-version");
    await templates.resolveVersion(pin);
    const project = projectRoot === undefined ? null : resolveAuthorizedWorkspaceProject(projectRoot);
    requireTemplate(project === null || (project.authorized && project.project), "scope-not-authorised");
    const root = project?.project?.projectRoot;
    requireTemplate(template.scope.kind === "all" || (root !== undefined
      && resolveAuthorizedWorkspaceProject(template.scope.projectRoot).project?.projectRoot === root), "project-mismatch");

    const { authority } = withProjectAuthority(evidence, root);
    if (!await authority.refreshCurrent()) return refused(WORK_DECISION_AUTHORITY_REVOKED);
    const created = await board.create({
      templateId, title, detail, ...(project?.project ? { projectRoot: root, projectName: project.project.projectName } : {}),
    }, authority);
    if (created.status !== "created") return refused(created.reason === WORK_DECISION_AUTHORITY_REVOKED ? created.reason : "work-item-create-refused");

    const { itemId } = created;
    const { remoteProvisional } = created.item;
    requireTemplate(remoteProvisional !== undefined, "invalid-template-run");
    let provisionalRunId: string | undefined;
    let launched = false;
    try {
      return await new Promise<TailnetWorkDecisionResponse>((resolve, reject) => {
        void engine.runItem(itemId, {
          templateSource: { kind: "tailnet-create-and-run", pin, ...(root === undefined ? {} : { projectRoot: root }) },
          authority,
          remoteProvisional,
          onTemplateRunAllocated: runId => { provisionalRunId = runId; },
          onTemplateStarted: runId => {
            launched = true;
            resolve({ ok: true, kind: "create-and-run", itemId, runId });
          },
        }).then(outcome => {
          if (!launched) resolve(refused(outcome.reasonCode ?? outcome.status));
        }, error => {
          if (!launched) reject(error);
        });
      });
    } finally {
      if (!launched) await board.rollbackProvisionalTemplateStart(itemId, remoteProvisional, provisionalRunId);
    }
  }

  async function applyDecision(
    request: TailnetWorkDecisionRequest,
    evidence: RemoteWorkDecisionEvidence,
    mintProof: (evidence: RemoteWorkDecisionEvidence) => HostDecisionProof,
  ): Promise<TailnetWorkDecisionResponse> {
    if (request.kind === "template-confirmation") {
      const { templateId, input } = request;
      const record = isWorkflowTemplateProposalId(templateId) ? null : await templates.get(templateId);
      const draft = record ? record.draft : templates.getProposal(templateId, evidence.conversationId).draft;
      requireTemplate((!record || scopeAuthorised(record.template.scope)) && (!draft || scopeAuthorised(draft.scope)), "scope-not-authorised");
      const draftRoot = draft?.scope.kind === "project" ? draft.scope.projectRoot : undefined;
      const proof = mintProof(withProjectAuthority(evidence, draftRoot));
      const { version: { templateId: id, version, graphHash } } = await templates.confirmDraft(templateId, input, { who: evidence.login, origin: proof.origin, proof }, effects);
      return { ok: true, kind: request.kind, pin: { templateId: id, version, graphHash } };
    }
    if (request.kind === "create-and-run") return start(request.input, evidence);
    if (request.kind === "schedule-attachment") {
      const scope = request.input.expectedScope;
      const scoped = withProjectAuthority(evidence, scope.kind === "project" ? scope.projectRoot : undefined);
      const { attachment: result } = await attachWorkflowSchedule(templates, routines, request.input,
        () => mintProof(scoped), auditLogger);
      return { ok: true, kind: request.kind, attachmentId: result.id, scheduleId: result.scheduleId };
    }

    const itemId = request.kind === "requested-output" ? request.input.itemId : request.itemId;
    const item = await board.get(itemId);
    if (item.status !== "found" || (item.item.projectRoot !== undefined && !isAuthorizedWorkspaceProjectRoot(item.item.projectRoot))) return refused("not_found");
    if (item.item.templateRunError) return refused("invalid-template-run");
    evidence = withProjectAuthority(evidence, item.item.projectRoot);

    if (request.kind === "join") {
      const result = await engine.decideStageJoin(itemId, request.input, evidence.authority);
      return result.ok ? { ok: true, kind: request.kind } : refused(result.reason);
    }
    const note = request.kind === "requested-output" ? undefined : request.input.note;
    if (note !== undefined && note.length > MAX_PLAN_NOTE_LENGTH) return refused("note_too_long");
    const effectiveNote = note !== undefined && settingsService.get("privacy")?.piiRedactEnabled ? redactForLLM(note).redacted : note;
    if (request.kind === "requested-output" || (outputRegistration && request.kind === "stage" && request.input.decision === "reject")) {
      const { runId, stageId, attempt, outputHash, decision } = request.input;
      if (item.item.runId !== runId) return refused("run_mismatch");
      const [current] = await engine.readTemplateRuns([item.item], "tailnet");
      const pending = current?.pendingWorkflowDecisions?.find(entry => entry.kind === "stage-gate" && entry.binding.stageId === stageId);
      if (pending?.kind === "stage-gate" && pending.binding.outputHash !== undefined) {
        if (pending.binding.attempt !== attempt) return refused("attempt_mismatch");
        if (request.kind === "stage" && request.input.resultHash !== pending.binding.resultHash) return refused("result_mismatch");
        if (outputHash === undefined || outputHash !== pending.binding.outputHash) return refused("output_mismatch");
        if (effectiveNote !== undefined && hasUnsafeDirectiveControlChars(effectiveNote)) return refused("note_invalid");
        if (request.kind === "requested-output" && decision === "approve") {
          const result = await engine.decideStageGate(itemId, { ...pending.binding, decision }, { kind: "tailnet", authority: evidence.authority });
          return result.ok ? { ok: true, kind: request.kind } : refused(result.reason);
        }
        // The registered owner commits the gate rejection and checks its own authority.
        if (decision === "request_changes") return refused("not_pending");
        const result = await decideOutputs({ itemId, runId, stageId, attempt, outputHash, decision }, evidence, effectiveNote);
        if (!result.ok) return refused(result.error);
        return request.kind === "requested-output" ? { ok: true, kind: request.kind }
          : { ok: true, kind: request.kind, status: decision === "approve" ? "approved" : "rejected" };
      }
      if (request.kind === "requested-output") return refused(outputRegistration ? "not_pending" : "requested-output-unavailable");
    }
    const result = request.kind === "plan"
      ? (await engine.decidePlan(itemId, { ...request.input, note: effectiveNote }, { authority: evidence.authority })).result
      : await engine.decideStageGate(itemId, { ...request.input, note: effectiveNote }, { kind: "tailnet", authority: evidence.authority });
    return result.ok ? { ok: true, kind: request.kind, status: result.status } : refused(result.reason);
  }

  return {
    list,
    registerRequestedOutputDecision(handler) {
      if (outputRegistration) throw new Error("Requested output decision handler already registered");
      const registration = { ...handler };
      outputRegistration = registration;
      return () => { if (outputRegistration === registration) outputRegistration = undefined; };
    },
    async decide(request, evidence) {
      let result: TailnetWorkDecisionResponse;
      let auditId: string | undefined;
      try {
        result = await applyDecision(request, evidence, scoped => {
          const proof = mintHostDecisionProof("tailnet-surface", scoped);
          auditId = proof.auditId;
          return proof;
        });
      } catch (error) {
        if (error instanceof WorkflowTemplateError || error instanceof WorkDecisionAuthorityError) return refused(error.code);
        throw error;
      }
      if (result.ok) {
        const binding = auditBindingOf(request);
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: result.kind === "create-and-run" ? workBoardOriginSessionId(result.itemId)
            : binding.itemId !== undefined ? workBoardOriginSessionId(binding.itemId) : `work-board:${binding.templateId}`,
          type: "approval",
          output: JSON.stringify({
            event: workDecisionAuditEvent(request.kind), origin: "tailnet-surface", login: evidence.login, kind: request.kind, auditId,
            ...binding, ...("status" in result ? { decision: result.status } : {}), result,
          }),
        });
      }
      return result;
    },
  };
}

function workDecisionAuditEvent(kind: TailnetWorkDecisionRequest["kind"]): string {
  if (kind === "stage" || kind === "join") return "work-approval:stage-decided";
  if (kind === "plan") return "work-approval:decided";
  return "work_approval_decided";
}

function auditBindingOf(request: TailnetWorkDecisionRequest) {
  switch (request.kind) {
    case "plan":
      return { itemId: request.itemId, runId: request.input.runId, planHash: request.input.planHash, decision: request.input.decision };
    case "stage":
      return {
        itemId: request.itemId, runId: request.input.runId, stageId: request.input.stageId, attempt: request.input.attempt,
        resultHash: request.input.resultHash, outputHash: request.input.outputHash, decision: request.input.decision,
      };
    case "join": {
      const { runId, joinId, generation, conflictHash, decision } = request.input;
      return { itemId: request.itemId, runId, joinId, generation, conflictHash, decision };
    }
    case "requested-output": {
      const { itemId, runId, stageId, attempt, outputHash, decision } = request.input;
      return { itemId, runId, stageId, attempt, outputHash, decision };
    }
    case "template-confirmation": {
      const { expectedGraphHash, expectedDraftRevision } = request.input;
      return { templateId: request.templateId, expectedGraphHash, expectedDraftRevision };
    }
    case "create-and-run":
    case "schedule-attachment": {
      const { templateId, version, graphHash } = request.input;
      return { templateId, version, graphHash };
    }
  }
}
