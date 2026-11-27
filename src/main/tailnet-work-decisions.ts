import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import { hasUnsafeDirectiveControlChars } from "../engine/parent-directive.js";
import type { TailnetOutputSnapshot, TailnetWorkDecisionHandler } from "../api/tailnet-surface-server.js";
import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { SettingsService } from "../data/settings-store.js";
import { createToolEffectResolver } from "../permissions/tool-effect-evidence.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { RequestedOutputPage } from "../permissions/requested-output-approval.js";
import { isExactApprovalText } from "../shared/approval-args-display.js";
import type { TailnetRequestedOutputDecision, TailnetRequestedOutputReview, TailnetWorkDecisionRequest, TailnetWorkDecisionResponse, TailnetWorkReview, TailnetWorkReviewSnapshot } from "../shared/tailnet-work-decisions.js";
import { MAX_PLAN_NOTE_LENGTH } from "../shared/work-board-types.js";
import { isWorkflowTemplateProposalId, type TemplateScope, type TemplateVersionPin, type WorkflowTemplateDraftInput } from "../shared/workflow-template-types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { WORK_DECISION_AUTHORITY_REVOKED, WorkDecisionAuthorityError } from "../work-board/work-decision-authority.js";
import { isAuthorizedWorkspaceProjectRoot, listAuthorizedWorkspaceProjects, resolveAuthorizedWorkspaceProject } from "./project-root-authorization.js";
import { maskWorkflowText } from "../work-board/workflow/run-read-projection.js";
import { isWorkflowPush, workflowPushBinding } from "../work-board/workflow/host-git.js";
import { requestedOutputHash } from "../work-board/workflow/requested-outputs.js";
import { canRetryRequestedOutput } from "../work-board/workflow/requested-output-retry.js";
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
  settingsService: Pick<SettingsService, "get">;
  toolRegistry: Pick<ToolRegistry, "findByName">;
  approvalGate: ApprovalGate;
}

type RequestedOutputDecision = { ok: true } | { ok: false; error: string };

type RequestedOutputBinding = TailnetRequestedOutputReview["binding"]["input"];

/** The owner rechecks the aggregate stage binding and authority at its own commit. */
interface RequestedOutputDecisions {
  list(binding: RequestedOutputBinding, evidence: RemoteWorkDecisionEvidence): Promise<TailnetRequestedOutputReview["review"] | null>;
  decide(input: TailnetRequestedOutputDecision, evidence: RemoteWorkDecisionEvidence, note?: string): Promise<RequestedOutputDecision>;
}

export interface TailnetWorkDecisions {
  readonly decide: TailnetWorkDecisionHandler;
  list(evidence: RemoteWorkDecisionEvidence): Promise<readonly TailnetWorkReview[]>;
  outputSnapshot(evidence: RemoteWorkDecisionEvidence): Promise<TailnetOutputSnapshot | undefined>;
  registerRequestedOutputDecision(handler: RequestedOutputDecisions): () => void;
}

type StartRequest = Extract<TailnetWorkDecisionRequest, { kind: "create-and-run" }>["input"];
const refused = (error: string) => ({ ok: false as const, error });
const scopeAuthorised = (scope: TemplateScope) => scope.kind === "all" || isAuthorizedWorkspaceProjectRoot(scope.projectRoot);
const canViewOutputProject = (root: string | undefined) => root === undefined || isAuthorizedWorkspaceProjectRoot(root);
const MAX_REQUESTED_OUTPUT_REVIEW_OFFERS = 1024;
const REQUESTED_OUTPUT_REVIEW_TTL_MS = 30_000;

function outputPage(evidence: RemoteWorkDecisionEvidence): RequestedOutputPage | undefined {
  if (!evidence.outputPage) return;
  return { id: evidence.outputPage.id, login: evidence.login, authority: evidence.authority, canViewProject: canViewOutputProject };
}

function withProjectAuthority(evidence: RemoteWorkDecisionEvidence, projectRoot: string | undefined): RemoteWorkDecisionEvidence {
  if (projectRoot === undefined) return evidence;
  const isCurrent = () => evidence.authority.isCurrent() && isAuthorizedWorkspaceProjectRoot(projectRoot);
  const page = evidence.outputPage;
  const guard = page?.controller.pairedShareGuard;
  return { ...evidence, authority: {
    isCurrent,
    refreshCurrent: async () => await evidence.authority.refreshCurrent() && isCurrent(),
  }, ...(page && guard ? { outputPage: { ...page, controller: { ...page.controller, pairedShareGuard: {
    isCurrent: binding => guard.isCurrent(binding) && canViewOutputProject(projectRoot),
    refreshCurrent: async binding => await guard.refreshCurrent(binding) && canViewOutputProject(projectRoot),
  } } } } : {}) };
}

export function createTailnetWorkDecisions(services: Partial<TailnetWorkDecisionServices>): TailnetWorkDecisions | undefined {
  if (!services.workBoardStore || !services.workBoardEngine || !services.workflowTemplateStore
    || !services.routinesStore || !services.settingsService || !services.toolRegistry) return undefined;
  const board = services.workBoardStore;
  const engine = services.workBoardEngine;
  const templates = services.workflowTemplateStore;
  const routines = services.routinesStore;

  const settingsService = services.settingsService;
  const effects = createToolEffectResolver(services.toolRegistry);
  const gate = services.approvalGate;
  let outputRegistration: RequestedOutputDecisions | undefined;
  const reviewOffers = new Map<string, { handle: string; expiresAt: number; requiresCard: boolean; owner: RequestedOutputDecisions }>();
  const reviewOfferKey = (pageId: string, binding: RequestedOutputBinding, resultHash: string, root: string | undefined) =>
    JSON.stringify([pageId, binding.itemId, binding.runId, binding.stageId, binding.attempt, resultHash, binding.outputHash, root ?? null]);

  function offerReview(pageId: string, binding: RequestedOutputBinding, resultHash: string, root: string | undefined, requiresCard: boolean, owner: RequestedOutputDecisions): string {
    const key = reviewOfferKey(pageId, binding, resultHash, root);
    const now = Date.now();
    const prior = reviewOffers.get(key);
    const handle = prior?.owner === owner && prior.expiresAt > now ? prior.handle : randomUUID();
    reviewOffers.delete(key);
    reviewOffers.set(key, { handle, requiresCard, expiresAt: now + REQUESTED_OUTPUT_REVIEW_TTL_MS, owner });
    for (const oldest of reviewOffers.keys()) {
      if (reviewOffers.size <= MAX_REQUESTED_OUTPUT_REVIEW_OFFERS) break;
      reviewOffers.delete(oldest);
    }
    return handle;
  }

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
        const stageReview: Extract<TailnetWorkReview, { kind: "stage" }> = { kind: "stage", deny: "reject", binding: { itemId: item.id, input: view.binding }, review: view };
        review.push(stageReview);
        const registered = outputRegistration;
        const { outputHash, runId, stageId, attempt } = view.binding;
        if (!registered || !outputHash) continue;
        const scoped = withOutputAuthority(withProjectAuthority(evidence, item.projectRoot), registered);
        if (!scoped.authority.isCurrent()) continue;
        const input = { itemId: item.id, runId, stageId, attempt, outputHash };
        const payload = await registered.list(input, scoped);
        if (payload && scoped.authority.isCurrent()) {
          const requiresCard = payload.outputs.some(output => !isWorkflowPush(output.decl));
          const reviewHandle = scoped.outputPage && (!requiresCard || gate?.hasRequestedOutputPage(item.projectRoot))
            ? offerReview(scoped.outputPage.id, input, view.binding.resultHash, item.projectRoot, requiresCard, registered) : undefined;
          if (reviewHandle) stageReview.reviewHandle = reviewHandle;
          review.push({ kind: "requested-output", deny: "reject", binding: { input }, review: payload, ...(reviewHandle ? { reviewHandle } : {}) });
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
    if (request.kind === "output-execution-card") {
      const page = outputPage(evidence);
      if (!gate || !page) return refused("requested-output-card-unavailable");
      const result = await gate.answerRequestedOutputCard(request.input.handle, request.input.choice, page);
      return result === "accepted" ? { ok: true, kind: request.kind } : refused(result);
    }
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
        () => mintProof(scoped));
      return { ok: true, kind: request.kind, attachmentId: result.id, scheduleId: result.scheduleId };
    }

    const itemId = request.kind === "requested-output" ? request.input.itemId : request.itemId;
    const item = await board.get(itemId);
    if (item.status !== "found" || (item.item.projectRoot !== undefined && !isAuthorizedWorkspaceProjectRoot(item.item.projectRoot))) return refused("not_found");
    if (item.item.templateRunError) return refused("invalid-template-run");
    evidence = withProjectAuthority(evidence, item.item.projectRoot);

    if (request.kind === "output-retry") {
      const page = outputPage(evidence);
      const controller = evidence.outputPage?.controller;
      if (!gate || !page || !controller) return refused("requested-output-card-unavailable");
      const canDeliver = () => gate.canReceiveRequestedOutputs(page, item.item.projectRoot);
      if (!canDeliver()) return refused("requested-output-card-unavailable");
      const result = await engine.retryOutput(itemId, request.input, { kind: "tailnet", authority: evidence.authority, controller, canDeliver });
      return result.ok ? { ok: true, kind: request.kind } : refused(result.reason);
    }

    const gateDecider = (input: RequestedOutputBinding, resultHash: string) => {
      const { outputPage: page, authority } = evidence;
      const recipient = outputPage(evidence);
      const key = page && reviewOfferKey(page.id, input, resultHash, item.item.projectRoot);
      const canDeliver = () => {
        const offer = key === undefined ? undefined : reviewOffers.get(key);
        return offer !== undefined && offer.owner === outputRegistration && request.reviewHandle === offer.handle && Date.now() < offer.expiresAt
          && authority.isCurrent() && (!offer.requiresCard || recipient !== undefined && gate?.canReceiveRequestedOutputs(recipient, item.item.projectRoot) === true);
      };
      return { kind: "tailnet" as const, authority, ...(page ? { outputs: { controller: page.controller, canDeliver } } : {}) };
    };

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
          const result = await engine.decideStageGate(itemId, { ...pending.binding, decision }, gateDecider({ itemId, runId, stageId, attempt, outputHash }, pending.binding.resultHash));
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
      : await engine.decideStageGate(itemId, { ...request.input, note: effectiveNote }, request.input.outputHash === undefined
        ? { kind: "tailnet", authority: evidence.authority }
        : gateDecider({ itemId, ...request.input, outputHash: request.input.outputHash }, request.input.resultHash));
    return result.ok ? { ok: true, kind: request.kind, status: result.status } : refused(result.reason);
  }

  const runtime: TailnetWorkDecisions = {
    list,
    async outputSnapshot(evidence) {
      const page = outputPage(evidence);
      if (!page || !gate) return;
      const items = await board.readApprovalItems();
      if (!items) return;
      const runs = await board.runs.view();
      const outputRetries: NonNullable<TailnetWorkReviewSnapshot["outputRetries"]>[number][] = [];
      for (const item of items) {
        if (!item.runId || !item.templateId || item.templateRunError || !canViewOutputProject(item.projectRoot)) continue;
        const stored = runs.get(item.runId);
        if (stored.status !== "found" || stored.run.itemId !== item.id || stored.run.pin.templateId !== item.templateId) continue;
        for (const stage of stored.run.stageRuns) {
          if (stage.status !== "passed" || stage.gate?.type !== "human" || stage.gate.status !== "approved") continue;
          const outputHash = requestedOutputHash(stage);
          if (!outputHash) continue;
          for (const outcome of stage.outputExecutions ?? []) {
            if (outcome.status !== "failed" && outcome.status !== "denied") continue;
            const output = stage.requestedOutputs?.find(candidate => candidate.id === outcome.id);
            if (!output) continue;
            const refusal = isWorkflowPush(output.decl) ? "push-retry-forbidden" : !canRetryRequestedOutput(outcome) ? "output-retry-effect-unknown" : undefined;
            outputRetries.push({ itemId: item.id, input: { runId: stored.run.runId, stageId: stage.stageId, attempt: stage.attempt, outputId: output.id, outputHash },
              summary: maskWorkflowText(output.summary), detail: outcome.detail === undefined ? undefined : maskWorkflowText(outcome.detail), refusal });
          }
        }
      }
      if (!page.authority.isCurrent()) return;
      const cards = gate.listRequestedOutputCards(page);
      return () => ({ outputCards: gate.filterCurrentRequestedOutputCards(page, cards), outputRetries });
    },
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
      if (result.ok && request.kind !== "output-execution-card") {
        logPermissionEvent("remote_work_decision", {
          origin: "tailnet-surface",
          kind: request.kind,
          auditId: permissionLogId(auditId),
          ...workDecisionLogFields(request),
          ...("status" in result && { decision: result.status }),
          ...(result.kind === "create-and-run" && { itemId: result.itemId, runId: permissionLogId(result.runId) }),
        });
      }
      return result;
    },
  };
  if (gate) runtime.registerRequestedOutputDecision({
    async list(binding, evidence) {
      if (!evidence.outputPage) return null;
      const stored = await board.runs.get(binding.runId);
      if (stored.status !== "found" || stored.run.itemId !== binding.itemId) return null;
      const stage = stored.run.stageRuns.find(candidate => candidate.stageId === binding.stageId);
      if (stage?.status !== "awaiting_gate" || stage.attempt !== binding.attempt || requestedOutputHash(stage) !== binding.outputHash) return null;
      const outputs: TailnetRequestedOutputReview["review"]["outputs"][number][] = [];
      for (const { id, decl, args, summary } of stage.requestedOutputs ?? []) {
        if (isWorkflowPush(decl)) {
          const push = workflowPushBinding(binding.runId, JSON.parse(args));
          if ("code" in push || !Object.values(push).every(isExactApprovalText)) return null;
          outputs.push({ id, decl, summary: maskWorkflowText(summary), push });
        } else outputs.push({ id, decl, summary: maskWorkflowText(summary) });
      }
      return { outputs };
    },
    async decide(input, evidence, note) {
      const stored = await board.runs.get(input.runId);
      if (stored.status !== "found" || stored.run.itemId !== input.itemId) return refused("run_mismatch");
      const stage = stored.run.stageRuns.find(candidate => candidate.stageId === input.stageId);
      if (!stage?.resultHash) return refused("not_pending");
      const result = await engine.decideStageGate(input.itemId, { ...input, resultHash: stage.resultHash, note }, { kind: "tailnet", authority: evidence.authority });
      return result.ok ? { ok: true } : refused(result.reason);
    },
  });
  return runtime;
}


function workDecisionLogFields(request: Exclude<TailnetWorkDecisionRequest, { kind: "output-execution-card" }>) {
  switch (request.kind) {
    case "plan":
      return { itemId: request.itemId, runId: permissionLogId(request.input.runId), decision: request.input.decision };
    case "stage":
    case "requested-output": {
      const { runId, stageId, attempt, decision } = request.input;
      const itemId = request.kind === "requested-output" ? request.input.itemId : request.itemId;
      return { itemId, runId: permissionLogId(runId), stageId: permissionLogId(stageId), attempt, decision };
    }
    case "join": {
      const { runId, joinId, generation, decision } = request.input;
      return { itemId: request.itemId, runId: permissionLogId(runId), joinId: permissionLogId(joinId), generation, decision };
    }
    case "output-retry": {
      const { runId, stageId, attempt } = request.input;
      return { itemId: request.itemId, runId: permissionLogId(runId), stageId: permissionLogId(stageId), attempt };
    }
    case "template-confirmation":
      return { templateId: permissionLogId(request.templateId) };
    case "create-and-run":
    case "schedule-attachment": {
      const { templateId, version } = request.input;
      return { templateId: permissionLogId(templateId), version };
    }
  }
}
import { randomUUID } from "node:crypto";
