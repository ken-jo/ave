import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace, writeFileAtomicAtPath, writeFileAtomicAtPathIf } from "./storage/feature-namespace.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { ChangeSignal } from "../lib/change-signal.js";
import { createLogger } from "../lib/logger.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { isRecord } from "../shared/is-record.js";
import { attachmentScopeMatches, isTemplateScope, hasTemplateKeys, canonicalTemplateGraph, validateStageForConfirm, isAllReadOnlyVersion, graphHashOf, isGraphHash, isTemplateId, isTemplateVersion, parseTemplateDraft, requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { WorkDecisionAuthorityError } from "../work-board/work-decision-authority.js";
import { parseTemplateConfirmInput } from "../work-board/work-decision-input.js";
import { assertHostDecisionProof, type HostDecisionProof } from "./workflow-template-decision.js";
import { isWorkflowTemplateProposalId, type ScheduleAttachment, type ScheduleAttachmentInput, type TemplateScope, type TemplateDecisionActor, type TemplateConfirmationOrigin, type TemplateVersion, type TemplateVersionPin, type WorkflowTemplate, type WorkflowTemplateConfirmInput, type WorkflowTemplateDraftInput, type WorkflowTemplateProposal, type WorkflowTemplateRecord } from "../shared/workflow-template-types.js";

interface ScheduleRunAuthority {
  record: WorkflowTemplateRecord | null;
  attachment: ScheduleAttachment | null;
}

interface TemplatesFile { version: 1; templates: WorkflowTemplateRecord[] }
const log = createLogger("workflow-templates");
const MAX_PENDING_PROPOSALS = 16;
const maxActorLength = (origin: TemplateConfirmationOrigin): number => origin === "local-desktop" ? 128 : 512;
const isDecisionOrigin = (origin: unknown): origin is TemplateConfirmationOrigin => origin === "local-desktop" || origin === "tailnet-surface";
const emptyFile = (): TemplatesFile => ({ version: 1, templates: [] });
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function hasDecisionProvenance(value: Record<string, unknown>): value is Record<string, unknown> & TemplateDecisionActor {
  return typeof value.who === "string" && value.who.length > 0 && (
    (value.origin === "local-desktop" && value.auditId === undefined)
    || (value.origin === "tailnet-surface" && value.who.length <= maxActorLength(value.origin)
      && typeof value.auditId === "string" && UUID_PATTERN.test(value.auditId))
  );
}

function decisionActor(proof: HostDecisionProof | undefined, localWho: string): TemplateDecisionActor {
  return proof?.origin === "tailnet-surface"
    ? { who: proof.remote.login, origin: proof.origin, auditId: proof.auditId }
    : { who: localWho, origin: "local-desktop" };
}

function validateFile(raw: unknown): TemplatesFile {
  requireTemplate(isRecord(raw) && raw.version === 1 && Array.isArray(raw.templates), "invalid-template-file");
  const seen = new Set<string>();
  const schedules = new Set<string>();
  const attachmentIds = new Set<string>();
  for (const record of raw.templates) {
    requireTemplate(isRecord(record) && isRecord(record.template) && Array.isArray(record.versions), "invalid-template-file");
    const t = record.template;
    requireTemplate(isTemplateId(t.id) && !seen.has(t.id) && Number.isSafeInteger(t.currentVersion) && t.currentVersion === record.versions.length, "invalid-template-file"); seen.add(t.id);
    requireTemplate(timestamp(t.createdAt) && timestamp(t.updatedAt) && (t.archivedAt === undefined || timestamp(t.archivedAt)), "invalid-template-file");
    for (let i = 0; i < record.versions.length; i++) {
      const v = record.versions[i];
      requireTemplate(isRecord(v) && v.templateId === t.id && v.version === i + 1 && timestamp(v.confirmedAt) && isRecord(v.confirmation), "invalid-template-file");
      requireTemplate(v.basedOn === undefined || (isTemplateVersion(v.basedOn) && v.basedOn < v.version), "unknown-version");
      requireTemplate(isGraphHash(v.graphHash) && graphHashOf(v) === v.graphHash, "graph-hash-mismatch");
      const c = v.confirmation;
      requireTemplate(c.templateId === t.id && c.version === v.version && c.graphHash === v.graphHash && c.at === v.confirmedAt && hasDecisionProvenance(c), "invalid-template-file");
    }
    requireTemplate(record.scheduleAttachments === undefined || Array.isArray(record.scheduleAttachments), "invalid-template-file");
    for (const attachment of record.scheduleAttachments ?? []) {
      requireTemplate(hasTemplateKeys(attachment, ["id", "scheduleId", "templateId", "version", "graphHash", "who", "at", "origin", "auditId", "detachedAt", "approvedScope"]) && isTemplateId(attachment.scheduleId) && (attachment.detachedAt !== undefined || !schedules.has(attachment.scheduleId)) && isTemplateId(attachment.id) && !attachmentIds.has(attachment.id) && (attachment.detachedAt === undefined || timestamp(attachment.detachedAt)) && attachment.templateId === t.id && isTemplateVersion(attachment.version) && isGraphHash(attachment.graphHash) && timestamp(attachment.at) && hasDecisionProvenance(attachment) && (attachment.origin !== "local-desktop" || attachment.who.length <= 128), "invalid-template-file");
      requireTemplate(isTemplateScope(attachment.approvedScope), "invalid-template-file");
      const version = record.versions.find((v: TemplateVersion) => v.version === attachment.version);
      requireTemplate(version, "unknown-version");
      requireTemplate(version.graphHash === attachment.graphHash, "graph-hash-mismatch");
      if (attachment.detachedAt === undefined) schedules.add(attachment.scheduleId);
      attachmentIds.add(attachment.id);
    }
    // Metadata uses the same bounds as draft intake, even when no draft remains.
    const graph = record.draft ?? record.versions[0];
    requireTemplate(isRecord(graph), "invalid-template-file");
    parseTemplateDraft({ name: t.name, scope: t.scope, description: t.description, stages: graph.stages, edges: graph.edges, setupCommands: graph.setupCommands });
    if (record.draft !== undefined) {
      const d = record.draft;
      requireTemplate(isRecord(d) && timestamp(d.updatedAt) && isTemplateId(d.revision), "invalid-template-file");
      const { graphHash, revision: _revision, updatedAt: _updatedAt, ...input } = d;
      const parsed = parseTemplateDraft(input);
      requireTemplate(parsed.basedOn === undefined || parsed.basedOn <= record.versions.length, "unknown-version");
      requireTemplate(isGraphHash(graphHash) && graphHashOf(parsed) === graphHash, "graph-hash-mismatch");
    }
  }
  return raw as unknown as TemplatesFile;
}

export class WorkflowTemplateStore {
  readonly changed = new ChangeSignal(error => log.warn("Template change listener failed: %s", String(error)));
  private readonly proposals = new Map<string, { sessionId: string; proposal: WorkflowTemplateProposal }>();
  private readonly proposalIdsBySession = new Map<string, Set<string>>();
  constructor(private readonly filePath = join(openFeatureNamespace("work-board").dir, "templates.json"), private readonly now: () => number = Date.now) {}
  private async readFile(): Promise<TemplatesFile> {
    const input = await readAveHomeInput(this.filePath);
    if (input.status === "absent") return emptyFile();
    requireTemplate(input.status === "trusted", "invalid-template-file");
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new WorkflowTemplateError("invalid-template-file"); }
    return validateFile(raw);
  }
  private async commit(file: TemplatesFile, proof?: HostDecisionProof): Promise<void> {
    validateFile(file);
    const body = `${JSON.stringify(file, null, 2)}\n`;
    if (proof?.origin === "tailnet-surface") {
      const { authority } = proof.remote;
      if (!await authority.refreshCurrent() || !await writeFileAtomicAtPathIf(this.filePath, body, authority.isCurrent)) throw new WorkDecisionAuthorityError();
    } else {
      await writeFileAtomicAtPath(this.filePath, body);
    }
    this.changed.emit();
  }
  private find(file: TemplatesFile, id: string): WorkflowTemplateRecord {
    requireTemplate(isTemplateId(id));
    const record = file.templates.find(r => r.template.id === id);
    requireTemplate(record, "template-not-found"); return record;
  }
  async list(): Promise<WorkflowTemplate[]> {
    return structuredClone((await this.readFile()).templates.filter(r => !r.template.archivedAt).map(r => r.template));
  }
  async listReviewRecords(): Promise<WorkflowTemplateRecord[]> {
    return structuredClone((await this.readFile()).templates.filter(record => record.template.archivedAt === undefined));
  }
  async get(id: string): Promise<WorkflowTemplateRecord> { return structuredClone(this.find(await this.readFile(), id)); }
  /** Read the template, its versions and the referenced attachment together after preceding writes. */
  async readScheduleRunAuthority(templateId: string, attachmentId: string): Promise<ScheduleRunAuthority> {
    requireTemplate(isTemplateId(templateId) && isTemplateId(attachmentId));
    return withInProcessFileQueue(this.filePath, async () => {
      const { templates } = await this.readFile();
      const record = templates.find(entry => entry.template.id === templateId) ?? null;
      const attachment = templates.flatMap(entry => entry.scheduleAttachments ?? []).find(entry => entry.id === attachmentId) ?? null;
      return { record, attachment };
    });
  }
  async getTemplate(id: string): Promise<WorkflowTemplate | null> {
    requireTemplate(isTemplateId(id));
    return structuredClone((await this.readFile()).templates.find(record => record.template.id === id)?.template ?? null);
  }
  async getVersion(templateId: string, version: number): Promise<TemplateVersion | null> {
    requireTemplate(isTemplateId(templateId) && isTemplateVersion(version));
    return structuredClone((await this.readFile()).templates.find(record => record.template.id === templateId)?.versions.find(entry => entry.version === version) ?? null);
  }
  async resolveVersion(pin: TemplateVersionPin): Promise<TemplateVersion> {
    requireTemplate(isTemplateId(pin?.templateId) && isTemplateVersion(pin.version) && isGraphHash(pin.graphHash));
    const record = this.find(await this.readFile(), pin.templateId);
    const version = record.versions.find(v => v.version === pin.version);
    requireTemplate(version, "unknown-version"); requireTemplate(version.graphHash === pin.graphHash, "graph-hash-mismatch");
    return structuredClone(version);
  }
  propose(sessionId: string, raw: WorkflowTemplateDraftInput): WorkflowTemplateProposal {
    const draft = parseTemplateDraft(raw);
    requireTemplate(draft.basedOn === undefined, "invalid-input", "basedOn");
    for (const stage of draft.stages) {
      const refusals = validateStageForConfirm(stage, draft);
      if (refusals.length === 0) continue;
      const path = `stages.${raw.stages.findIndex(entry => entry.id === stage.id)}`;
      const field = refusals.includes("setup-outside-commands") ? "setupCommands"
        : refusals.includes("outputs-need-human-gate") ? `${path}.gate` : `${path}.envelope`;
      throw new WorkflowTemplateError("envelope-refused", "Stage confirmation refused", refusals, field);
    }
    const proposal = { id: `proposal-${randomUUID()}`, graphHash: graphHashOf(draft), draft };
    const sessionProposals = this.proposalIdsBySession.get(sessionId) ?? new Set<string>();
    if (sessionProposals.size >= MAX_PENDING_PROPOSALS) {
      const oldest = sessionProposals.values().next().value;
      if (oldest !== undefined) this.removeProposal(oldest);
    }
    sessionProposals.add(proposal.id);
    this.proposalIdsBySession.set(sessionId, sessionProposals);
    this.proposals.set(proposal.id, { sessionId, proposal });
    return structuredClone(proposal);
  }
  getProposal(id: string, conversationId?: string): WorkflowTemplateProposal {
    const entry = this.proposals.get(id);
    requireTemplate(entry && (conversationId === undefined || entry.sessionId === conversationId), "no-draft");
    return structuredClone(entry.proposal);
  }
  listProposals(conversationId: string): WorkflowTemplateProposal[] {
    return [...(this.proposalIdsBySession.get(conversationId) ?? [])].map(id => this.getProposal(id, conversationId));
  }
  private removeProposal(id: string): void {
    const entry = this.proposals.get(id);
    if (!entry) return;
    this.proposals.delete(id);
    const sessionProposals = this.proposalIdsBySession.get(entry.sessionId);
    sessionProposals?.delete(id);
    if (sessionProposals?.size === 0) this.proposalIdsBySession.delete(entry.sessionId);
  }
  async draft(id: string | null, raw: WorkflowTemplateDraftInput): Promise<WorkflowTemplateRecord> {
    const input = parseTemplateDraft(raw);
    requireTemplate(id === null || isTemplateId(id));
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile(); const at = new Date(this.now()).toISOString();
      const record: WorkflowTemplateRecord = id === null
        ? { template: { id: randomUUID(), name: input.name, scope: input.scope, ...(input.description !== undefined ? { description: input.description } : {}), currentVersion: 0, createdAt: at, updatedAt: at }, versions: [] }
        : this.find(file, id);
      requireTemplate(!record.template.archivedAt, "template-archived");
      const basedOn = input.basedOn ?? (record.template.currentVersion || undefined);
      requireTemplate(basedOn === undefined || record.versions.some(v => v.version === basedOn), "unknown-version");
      record.draft = { ...input, ...(basedOn !== undefined ? { basedOn } : {}), graphHash: graphHashOf(input), revision: randomUUID(), updatedAt: at };
      record.template.updatedAt = at;
      if (id === null) file.templates.push(record);
      await this.commit(file); return structuredClone(record);
    });
  }
  async confirmDraft(id: string, input: WorkflowTemplateConfirmInput, actor: { who: string; origin: TemplateConfirmationOrigin; proof?: HostDecisionProof }): Promise<TemplateVersion> {
    const binding = parseTemplateConfirmInput(input);
    requireTemplate(binding);
    requireTemplate(isDecisionOrigin(actor?.origin) && typeof actor.who === "string" && actor.who.length > 0 && actor.who.length <= maxActorLength(actor.origin));
    const proof = actor.origin === "tailnet-surface" ? actor.proof : undefined;
    if (actor.origin === "tailnet-surface") {
      assertHostDecisionProof(proof, { allowTailnet: true });
      requireTemplate(proof.origin === actor.origin && proof.remote.login === actor.who);
    }
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile();
      const proposal = isWorkflowTemplateProposalId(id) ? this.getProposal(id, proof?.origin === "tailnet-surface" ? proof.remote.conversationId : undefined) : undefined;
      const at = new Date(this.now()).toISOString();
      const record: WorkflowTemplateRecord = proposal
        ? { template: { id: randomUUID(), name: proposal.draft.name, scope: proposal.draft.scope, currentVersion: 0, createdAt: at, updatedAt: at }, versions: [], draft: { ...proposal.draft, graphHash: proposal.graphHash, revision: proposal.id, updatedAt: at } }
        : this.find(file, id);
      requireTemplate(!record.template.archivedAt, "template-archived");
      const draft = record.draft; requireTemplate(draft, "no-draft");
      const graphHash = graphHashOf(draft); requireTemplate(graphHash === binding.expectedGraphHash && draft.revision === binding.expectedDraftRevision, "stale-draft");
      const refusals = [...new Set(draft.stages.flatMap(stage => validateStageForConfirm(stage, draft)))];
      if (refusals.length) throw new WorkflowTemplateError("envelope-refused", "Stage confirmation refused", refusals);
      const version = record.template.currentVersion + 1;
      const templateId = record.template.id;
      const confirmed: TemplateVersion = { templateId, version, graphHash, stages: structuredClone(draft.stages), edges: structuredClone(draft.edges), ...(draft.setupCommands !== undefined ? { setupCommands: [...draft.setupCommands] } : {}), confirmedAt: at, ...(draft.basedOn !== undefined ? { basedOn: draft.basedOn } : {}), confirmation: { templateId, version, graphHash, ...decisionActor(proof, actor.who), at } };
      record.versions.push(confirmed);
      record.template = { ...record.template, name: draft.name, scope: structuredClone(draft.scope), currentVersion: version, updatedAt: at };
      if (draft.description === undefined) delete record.template.description; else record.template.description = draft.description;
      delete record.draft;
      if (proposal) file.templates.push(record);
      await this.commit(file, proof);
      if (proposal) this.removeProposal(id);
      return structuredClone(confirmed);
    });
  }
  async attachSchedule(input: ScheduleAttachmentInput, proof: HostDecisionProof, approvedScope: TemplateScope, options?: { requireCurrent: true }): Promise<ScheduleAttachment> {
    requireTemplate(hasTemplateKeys(input, ["scheduleId", "templateId", "version", "graphHash"]) && isTemplateId(input.scheduleId) && isTemplateId(input.templateId) && isTemplateVersion(input.version) && isGraphHash(input.graphHash));
    assertHostDecisionProof(proof, { allowTailnet: true });
    requireTemplate(isTemplateScope(approvedScope));
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile(); const record = this.find(file, input.templateId);
      requireTemplate(!record.template.archivedAt, "template-archived");
      if (options?.requireCurrent) requireTemplate(record.template.currentVersion === input.version, "not-current-version");
      const version = record.versions.find(v => v.version === input.version);
      requireTemplate(version, "unknown-version");
      requireTemplate(version.graphHash === input.graphHash, "graph-hash-mismatch");
      requireTemplate(isAllReadOnlyVersion(canonicalTemplateGraph(version)), "schedule-requires-read-only");
      requireTemplate(attachmentScopeMatches({ approvedScope }, record.template).ok, "scope-changed");
      const attachment: ScheduleAttachment = { ...input, approvedScope: structuredClone(approvedScope), id: randomUUID(), ...decisionActor(proof, "user"), at: proof.decidedAt };
      for (const r of file.templates) for (const prior of r.scheduleAttachments ?? []) if (prior.scheduleId === input.scheduleId && prior.detachedAt === undefined) prior.detachedAt = proof.decidedAt;
      record.scheduleAttachments ??= [];
      record.scheduleAttachments.push(attachment);
      await this.commit(file, proof); return structuredClone(attachment);
    });
  }
  async getAttachment(id: string): Promise<ScheduleAttachment | null> {
    requireTemplate(isTemplateId(id));
    return structuredClone((await this.readFile()).templates.flatMap(r => r.scheduleAttachments ?? []).find(a => a.id === id) ?? null);
  }
  async listByTemplate(templateId: string): Promise<ScheduleAttachment[]> {
    return structuredClone(this.find(await this.readFile(), templateId).scheduleAttachments ?? []);
  }
  async listByRoutine(scheduleId: string): Promise<ScheduleAttachment[]> {
    requireTemplate(isTemplateId(scheduleId));
    return structuredClone((await this.readFile()).templates.flatMap(r => r.scheduleAttachments ?? []).filter(a => a.scheduleId === scheduleId));
  }
  async listActiveScheduleAttachments(scheduleIds: ReadonlySet<string>): Promise<Map<string, { attachment: ScheduleAttachment; template: WorkflowTemplate }>> {
    const bySchedule = new Map<string, { attachment: ScheduleAttachment; template: WorkflowTemplate }>();
    for (const { template, scheduleAttachments } of (await this.readFile()).templates) {
      for (const attachment of scheduleAttachments ?? []) {
        if (attachment.detachedAt === undefined && scheduleIds.has(attachment.scheduleId)) bySchedule.set(attachment.scheduleId, { attachment, template });
      }
    }
    return bySchedule;
  }
  async detachSchedule(id: string, proof: HostDecisionProof): Promise<boolean> {
    requireTemplate(isTemplateId(id)); assertHostDecisionProof(proof);
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile();
      const attachment = file.templates.flatMap(r => r.scheduleAttachments ?? []).find(a => a.id === id);
      if (!attachment || attachment.detachedAt !== undefined) return false;
      attachment.detachedAt = proof.decidedAt; await this.commit(file); return true;
    });
  }
  async archive(id: string): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile(); const record = this.find(file, id);
      if (record.template.archivedAt) return;
      const at = new Date(this.now()).toISOString();
      record.template.archivedAt = at; record.template.updatedAt = at;
      await this.commit(file);
    });
  }
}
