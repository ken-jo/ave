import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { isAbsolute } from "node:path";
import { SHA256_HEX, sha256Hex, timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import { openFeatureNamespace, writeFileAtomicAtPathIf } from "../main/storage/feature-namespace.js";
import { assertAveHomeInputWritable, readAveHomeInputSync } from "../shared/ave-home-trust.js";
import { projectRootKey } from "../shared/project-identity.js";
import type { SkillMemoryChange, SkillMemoryDecision, SkillMemoryGroup, SkillMemoryLesson, SkillMemoryScope } from "../shared/skill-memory-types.js";
import { sanitizeSkillMemoryText, SKILL_MEMORY_COMPLETION_LIMIT, SKILL_MEMORY_SCOPE_LIMIT } from "./skill-memory-policy.js";

export interface SkillMemoryBinding extends SkillMemoryScope {
  filePath: string;
  fingerprint: string;
  approval: string;
  projectIdentity: string;
}

export function skillMemoryScopeId(filePath: string, projectRoot: string, projectIdentity: string): string {
  return sha256Hex(JSON.stringify([filePath, projectRootKey(projectRoot), projectIdentity]));
}

const Hash = z.string().regex(SHA256_HEX);
const Id = z.string().min(1).max(128);
const Scope = z.object({ id: Hash, skill: Id, projectRoot: z.string().min(1).max(4096) }).strict();
const Lesson = z.object({
  id: Id,
  digest: Hash,
  description: z.string(),
  body: z.string(),
  fingerprint: Hash,
  origin: z.object({
    sessionId: Id, messageId: Id, completionId: Id, runKind: z.enum(["attended", "headless", "scheduled"]),
  }).strict(),
}).strict();
const Change = z.object({
  id: Id,
  action: z.enum(["activate", "stage", "apply", "reject", "undo"]),
  at: z.iso.datetime(),
  actor: z.enum(["host", "owner"]),
  before: Lesson.nullable(),
  after: Lesson.nullable(),
}).strict();
const Group = z.object({
  scope: Scope.extend({ filePath: z.string().refine(isAbsolute) }),
  active: z.array(Lesson).max(SKILL_MEMORY_SCOPE_LIMIT),
  staged: z.array(Lesson).max(SKILL_MEMORY_SCOPE_LIMIT),
  history: z.array(Change),
}).strict();
const Document = z.object({ version: z.literal(1), groups: z.array(Group) }).strict();

type Document = z.infer<typeof Document>;
type NewLesson = { binding: SkillMemoryBinding; lesson: Omit<SkillMemoryLesson, "id" | "digest" | "fingerprint"> };

const FILENAME = "lessons.json";

function digestLesson(lesson: Omit<SkillMemoryLesson, "digest">): string {
  const { id, description, body, fingerprint, origin } = lesson;
  return sha256Hex(JSON.stringify([id, description, body, fingerprint, origin.sessionId, origin.messageId, origin.completionId, origin.runKind]));
}

function validLesson(lesson: SkillMemoryLesson): boolean {
  const clean = sanitizeSkillMemoryText(lesson.description, lesson.body);
  return clean?.description === lesson.description && clean.body === lesson.body
    && timingSafeEqualHexDigest(lesson.digest, digestLesson(lesson));
}

function addChange(group: SkillMemoryGroup, action: SkillMemoryChange["action"], before: SkillMemoryLesson | null, after: SkillMemoryLesson | null): void {
  group.history.push({ id: randomUUID(), action, at: new Date().toISOString(), actor: action === "activate" || action === "stage" ? "host" : "owner", before, after });
}

function groupFor(document: Document, binding: SkillMemoryBinding): Document["groups"][number] {
  const existing = document.groups.find(group => group.scope.id === binding.id);
  if (existing) return existing;
  const { id, skill, projectRoot, filePath } = binding;
  const group = { scope: { id, skill, projectRoot, filePath }, active: [], staged: [], history: [] };
  document.groups.push(group);
  return group;
}

function plainDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat === undefined || (stat.isDirectory() && !stat.isSymbolicLink());
}

export class SkillMemoryStore {
  private readonly namespace = openFeatureNamespace("skill-memory");
  list(): SkillMemoryGroup[] {
    return this.read().groups.map(({ scope, ...group }) => {
      const { id, skill, projectRoot } = scope;
      return { ...group, scope: { id, skill, projectRoot } };
    });
  }

  recall(binding: SkillMemoryBinding): SkillMemoryLesson[] {
    const group = this.read().groups.find(candidate => candidate.scope.id === binding.id);
    return group?.active.filter(lesson => lesson.fingerprint === binding.fingerprint) ?? [];
  }

  record(candidates: readonly NewLesson[], canCommit: () => boolean): Promise<boolean> {
    const [first] = candidates;
    if (!first || candidates.length > SKILL_MEMORY_COMPLETION_LIMIT) return Promise.resolve(false);
    const origin = first.lesson.origin;
    const { completionId, runKind, sessionId } = origin;
    return this.mutate(document => {
      if (document.groups.some(group => group.history.some(change => change.after?.origin.completionId === completionId))) return false;
      for (const { binding, lesson } of candidates) {
        if (binding.id !== skillMemoryScopeId(binding.filePath, binding.projectRoot, binding.projectIdentity)) return false;
        if (lesson.origin.completionId !== completionId || lesson.origin.runKind !== runKind || lesson.origin.sessionId !== sessionId) return false;
        const clean = sanitizeSkillMemoryText(lesson.description, lesson.body);
        if (!clean) return false;
        const group = groupFor(document, binding);
        const rows = runKind === "attended" ? group.active : group.staged;
        const existing = rows.find(row => row.description === clean.description && row.fingerprint === binding.fingerprint);
        if (existing?.body === clean.body) continue;
        if (!existing && rows.length >= SKILL_MEMORY_SCOPE_LIMIT) return false;
        const version = { ...clean, origin: lesson.origin, fingerprint: binding.fingerprint, id: existing?.id ?? randomUUID() };
        const next = { ...version, digest: digestLesson(version) };
        if (existing) rows.splice(rows.indexOf(existing), 1, next);
        else rows.push(next);
        addChange(group, runKind === "attended" ? "activate" : "stage", existing ?? null, next);
      }
      return true;
    }, canCommit);
  }

  decide(decision: SkillMemoryDecision, canCommit: (scope: SkillMemoryScope & { filePath: string }, lesson: SkillMemoryLesson) => boolean): Promise<boolean> {
    let target: { scope: Document["groups"][number]["scope"]; lesson: SkillMemoryLesson } | undefined;
    return this.mutate(document => {
      const group = document.groups.find(item => item.scope.id === decision.scopeId);
      if (!group) return false;
      if (decision.action === "undo") {
        const change = group.history.find(item => item.id === decision.changeId);
        if (!change?.after || (change.action !== "activate" && change.action !== "apply")) return false;
        const current = group.active.find(lesson => lesson.id === change.after?.id);
        if (!current || !timingSafeEqualHexDigest(current.digest, decision.digest) || current.digest !== change.after.digest) return false;
        group.active.splice(group.active.indexOf(current), 1, ...(change.before ? [change.before] : []));
        addChange(group, "undo", current, change.before);
        target = { scope: group.scope, lesson: current };
        return true;
      }
      const staged = group.staged.find(lesson => lesson.id === decision.lessonId);
      if (!staged || !timingSafeEqualHexDigest(staged.digest, decision.digest)) return false;
      if (decision.action === "apply") {
        const current = group.active.find(lesson => lesson.description === staged.description && lesson.fingerprint === staged.fingerprint);
        if (!current && group.active.length >= SKILL_MEMORY_SCOPE_LIMIT) return false;
        const version = { ...staged, id: current?.id ?? staged.id };
        const next = { ...version, digest: digestLesson(version) };
        if (current) group.active.splice(group.active.indexOf(current), 1, next);
        else group.active.push(next);
        addChange(group, "apply", current ?? null, next);
      } else {
        addChange(group, "reject", staged, null);
      }
      group.staged.splice(group.staged.indexOf(staged), 1);
      target = { scope: group.scope, lesson: staged };
      return true;
    }, () => target !== undefined && canCommit(target.scope, target.lesson));
  }

  private read(): Document {
    if (!plainDirectory(this.namespace.dir)) throw new Error("Invalid skill memory directory");
    const target = join(this.namespace.dir, FILENAME);
    const file = lstatSync(target, { throwIfNoEntry: false });
    if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("Invalid skill memory file");
    const input = readAveHomeInputSync(target);
    if (input.status === "absent") return { version: 1, groups: [] };
    if (input.status !== "trusted") throw new Error("Skill memory is unreadable");
    const document = Document.parse(JSON.parse(input.bytes.toString("utf8")));
    for (const group of document.groups) {
      const versions = [...group.active, ...group.staged, ...group.history.flatMap(change => [change.before, change.after])];
      if (versions.some(lesson => lesson !== null && !validLesson(lesson))) throw new Error("Invalid skill memory version");
    }
    return document;
  }

  private mutate(change: (document: Document) => boolean, canCommit: () => boolean): Promise<boolean> {
    const file = join(this.namespace.dir, FILENAME);
    return withInProcessFileQueue(file, async () => {
      if (!plainDirectory(this.namespace.dir)) return false;
      assertAveHomeInputWritable(file, "update managed skill memory");
      const document = this.read();
      if (!change(document)) return false;
      const contents = JSON.stringify(Document.parse(document));
      return writeFileAtomicAtPathIf(file, contents,
        () => plainDirectory(this.namespace.dir) && canCommit());
    });
  }
}
