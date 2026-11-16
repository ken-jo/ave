import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace, writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { ChangeSignal } from "../lib/change-signal.js";
import { createLogger } from "../lib/logger.js";
import { isRecord } from "../shared/is-record.js";
import { attachmentScopeMatches, isTemplateScope, hasTemplateKeys, canonicalTemplateGraph, validateStageForConfirm, isAllReadOnlyVersion, graphHashOf, isGraphHash, isTemplateId, isTemplateVersion, parseTemplateDraft, requireTemplate, WorkflowTemplateError } from "../work-board/template-graph.js";
import { assertHostDecisionProof, type HostDecisionProof } from "./workflow-template-decision.js";
import type { ScheduleAttachment, ScheduleAttachmentInput, TemplateScope, TemplateConfirmationOrigin, TemplateVersion, TemplateVersionPin, WorkflowTemplate, WorkflowTemplateConfirmInput, WorkflowTemplateDraftInput, WorkflowTemplateRecord } from "../shared/workflow-template-types.js";

interface TemplatesFile { version: 1; templates: WorkflowTemplateRecord[] }
const log = createLogger("workflow-templates");
const emptyFile = (): TemplatesFile => ({ version: 1, templates: [] });
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

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
      requireTemplate(c.templateId === t.id && c.version === v.version && c.graphHash === v.graphHash && c.at === v.confirmedAt && typeof c.who === "string" && c.who.length > 0 && c.origin === "local-desktop", "invalid-template-file");
    }
    requireTemplate(record.scheduleAttachments === undefined || Array.isArray(record.scheduleAttachments), "invalid-template-file");
    for (const attachment of record.scheduleAttachments ?? []) {
      requireTemplate(hasTemplateKeys(attachment, ["id", "scheduleId", "templateId", "version", "graphHash", "who", "at", "origin", "detachedAt", "approvedScope"]) && isTemplateId(attachment.scheduleId) && (attachment.detachedAt !== undefined || !schedules.has(attachment.scheduleId)) && isTemplateId(attachment.id) && !attachmentIds.has(attachment.id) && (attachment.detachedAt === undefined || timestamp(attachment.detachedAt)) && attachment.templateId === t.id && isTemplateVersion(attachment.version) && isGraphHash(attachment.graphHash) && timestamp(attachment.at) && typeof attachment.who === "string" && attachment.who.length > 0 && attachment.who.length <= 128 && attachment.origin === "local-desktop", "invalid-template-file");
      requireTemplate(attachment.approvedScope === undefined || isTemplateScope(attachment.approvedScope), "invalid-template-file");
      const version = record.versions.find((v: TemplateVersion) => v.version === attachment.version);
      requireTemplate(version, "unknown-version");
      requireTemplate(version.graphHash === attachment.graphHash, "graph-hash-mismatch");
      requireTemplate(isAllReadOnlyVersion(canonicalTemplateGraph(version)), "schedule-requires-read-only");
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
  constructor(private readonly filePath = join(openFeatureNamespace("work-board").dir, "templates.json"), private readonly now: () => number = Date.now) {}
  private async readFile(): Promise<TemplatesFile> {
    const input = await readAveHomeInput(this.filePath);
    if (input.status === "absent") return emptyFile();
    requireTemplate(input.status === "trusted", "invalid-template-file");
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new WorkflowTemplateError("invalid-template-file"); }
    return validateFile(raw);
  }
  private async commit(file: TemplatesFile): Promise<void> {
    validateFile(file);
    await writeFileAtomicAtPath(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
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
  async get(id: string): Promise<WorkflowTemplateRecord> { return structuredClone(this.find(await this.readFile(), id)); }
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
  async confirmDraft(id: string, input: WorkflowTemplateConfirmInput, actor: { who: string; origin: TemplateConfirmationOrigin }): Promise<TemplateVersion> {
    requireTemplate(hasTemplateKeys(input, ["expectedGraphHash", "expectedDraftRevision"]) && isGraphHash(input.expectedGraphHash) && isTemplateId(input.expectedDraftRevision));
    requireTemplate(actor?.origin === "local-desktop" && typeof actor.who === "string" && actor.who.length > 0 && actor.who.length <= 128);
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile(); const record = this.find(file, id);
      requireTemplate(!record.template.archivedAt, "template-archived");
      const draft = record.draft; requireTemplate(draft, "no-draft");
      const graphHash = graphHashOf(draft); requireTemplate(graphHash === input.expectedGraphHash && draft.revision === input.expectedDraftRevision, "stale-draft");
      const refusals = [...new Set(draft.stages.flatMap(stage => validateStageForConfirm(stage, draft)))];
      if (refusals.length) throw new WorkflowTemplateError("envelope-refused", "Stage confirmation refused", refusals);
      const at = new Date(this.now()).toISOString(); const version = record.template.currentVersion + 1;
      const confirmed: TemplateVersion = { templateId: id, version, graphHash, stages: structuredClone(draft.stages), edges: structuredClone(draft.edges), ...(draft.setupCommands !== undefined ? { setupCommands: [...draft.setupCommands] } : {}), confirmedAt: at, ...(draft.basedOn !== undefined ? { basedOn: draft.basedOn } : {}), confirmation: { templateId: id, version, graphHash, who: actor.who, origin: actor.origin, at } };
      record.versions.push(confirmed);
      record.template = { ...record.template, name: draft.name, scope: structuredClone(draft.scope), currentVersion: version, updatedAt: at };
      if (draft.description === undefined) delete record.template.description; else record.template.description = draft.description;
      delete record.draft; await this.commit(file); return structuredClone(confirmed);
    });
  }
  async attachSchedule(input: ScheduleAttachmentInput, proof: HostDecisionProof, approvedScope: TemplateScope): Promise<ScheduleAttachment> {
    requireTemplate(hasTemplateKeys(input, ["scheduleId", "templateId", "version", "graphHash"]) && isTemplateId(input.scheduleId) && isTemplateId(input.templateId) && isTemplateVersion(input.version) && isGraphHash(input.graphHash));
    assertHostDecisionProof(proof);
    requireTemplate(isTemplateScope(approvedScope));
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await this.readFile(); const record = this.find(file, input.templateId);
      requireTemplate(!record.template.archivedAt, "template-archived");
      const version = record.versions.find(v => v.version === input.version);
      requireTemplate(version, "unknown-version");
      requireTemplate(version.graphHash === input.graphHash, "graph-hash-mismatch");
      requireTemplate(isAllReadOnlyVersion(canonicalTemplateGraph(version)), "schedule-requires-read-only");
      requireTemplate(attachmentScopeMatches({ approvedScope }, record.template).ok, "scope-changed");
      const attachment: ScheduleAttachment = { ...input, approvedScope: structuredClone(approvedScope), id: randomUUID(), who: "user", origin: proof.origin, at: proof.decidedAt };
      for (const r of file.templates) for (const prior of r.scheduleAttachments ?? []) if (prior.scheduleId === input.scheduleId && prior.detachedAt === undefined) prior.detachedAt = proof.decidedAt;
      record.scheduleAttachments ??= [];
      record.scheduleAttachments.push(attachment);
      await this.commit(file); return structuredClone(attachment);
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
