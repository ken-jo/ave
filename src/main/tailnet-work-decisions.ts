import type { AuditLogger } from "../audit/audit-logger.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import type { TailnetWorkDecisionHandler } from "../api/tailnet-surface-server.js";
import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { SettingsService } from "../data/settings-store.js";
import type { TailnetRequestedOutputDecision, TailnetWorkDecisionRequest, TailnetWorkDecisionResponse } from "../shared/tailnet-work-decisions.js";
import { MAX_PLAN_NOTE_LENGTH, workBoardOriginSessionId } from "../shared/work-board-types.js";
import { isWorkflowTemplateProposalId, type TemplateScope, type TemplateVersionPin } from "../shared/workflow-template-types.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { WORK_DECISION_AUTHORITY_REVOKED, WorkDecisionAuthorityError } from "../work-board/work-decision-authority.js";
import { isAuthorizedWorkspaceProjectRoot, resolveAuthorizedWorkspaceProject } from "./project-root-authorization.js";
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
}

type RequestedOutputDecision = { ok: true } | { ok: false; error: string };

/** The output owner must check the exact pending output and use the supplied authority at its own commit point. */
type RequestedOutputDecisionHandler = (
  input: TailnetRequestedOutputDecision,
  evidence: RemoteWorkDecisionEvidence,
) => Promise<RequestedOutputDecision>;

export interface TailnetWorkDecisions {
  readonly decide: TailnetWorkDecisionHandler;
  registerRequestedOutputDecision(handler: RequestedOutputDecisionHandler): () => void;
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
    || !services.routinesStore || !services.auditLogger || !services.settingsService) return undefined;
  const board = services.workBoardStore;
  const engine = services.workBoardEngine;
  const templates = services.workflowTemplateStore;
  const routines = services.routinesStore;
  const auditLogger = services.auditLogger;
  const settingsService = services.settingsService;
  let outputRegistration: { handler: RequestedOutputDecisionHandler } | undefined;

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
    requireTemplate(template.scope.kind === "all" || template.scope.projectRoot === root, "project-mismatch");

    const { authority } = withProjectAuthority(evidence, root);
    if (!await authority.refreshCurrent()) return refused(WORK_DECISION_AUTHORITY_REVOKED);
    const created = await board.create({
      templateId, title, detail, ...(project?.project ? { projectRoot: root, projectName: project.project.projectName } : {}),
    }, authority.isCurrent);
    if (created.status !== "created") return refused(created.reason === WORK_DECISION_AUTHORITY_REVOKED ? created.reason : "work-item-create-refused");

    const { itemId } = created;
    const result = await new Promise<TailnetWorkDecisionResponse>((resolve, reject) => {
      void engine.runItem(itemId, {
        templateSource: { kind: "tailnet-create-and-run", pin, ...(root === undefined ? {} : { projectRoot: root }) },
        authority,
        onTemplateStarted: runId => resolve({ ok: true, kind: "create-and-run", itemId, runId }),
      }).then(outcome => resolve(refused(outcome.reasonCode ?? outcome.status)), reject);
    });
    if (!result.ok) await board.remove(itemId, created.item.mutationRevision);
    return result;
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
      const { templateId: id, version, graphHash } = await templates.confirmDraft(templateId, input, { who: evidence.login, origin: proof.origin, proof });
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

    if (request.kind === "requested-output") {
      if (item.item.runId !== request.input.runId) return refused("run_mismatch");
      const registered = outputRegistration;
      if (!registered) return refused("requested-output-unavailable");
      if (!await evidence.authority.refreshCurrent() || outputRegistration !== registered) return refused(WORK_DECISION_AUTHORITY_REVOKED);
      const result = await registered.handler(request.input, {
        ...evidence,
        authority: {
          isCurrent: () => outputRegistration === registered && evidence.authority.isCurrent(),
          refreshCurrent: async () => await evidence.authority.refreshCurrent() && outputRegistration === registered,
        },
      });
      return result.ok ? { ok: true, kind: request.kind } : refused(result.error);
    }
    if (request.kind === "join") {
      const result = await engine.decideStageJoin(itemId, request.input, evidence.authority);
      return result.ok ? { ok: true, kind: request.kind } : refused(result.reason);
    }
    const { note } = request.input;
    if (note !== undefined && note.length > MAX_PLAN_NOTE_LENGTH) return refused("note_too_long");
    const effectiveNote = note !== undefined && settingsService.get("privacy")?.piiRedactEnabled ? redactForLLM(note).redacted : note;

    const result = request.kind === "plan"
      ? (await engine.decidePlan(itemId, { ...request.input, note: effectiveNote }, { authority: evidence.authority })).result
      : await engine.decideStageGate(itemId, { ...request.input, note: effectiveNote }, evidence.authority);
    return result.ok ? { ok: true, kind: request.kind, status: result.status } : refused(result.reason);
  }

  return {
    registerRequestedOutputDecision(handler) {
      if (outputRegistration) throw new Error("Requested output decision handler already registered");
      const registration = { handler };
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
      const { itemId, runId, stageId, attempt, outputId, outputHash, decision } = request.input;
      return { itemId, runId, stageId, attempt, outputId, outputHash, decision };
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
