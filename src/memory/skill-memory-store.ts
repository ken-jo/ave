import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { SHA256_HEX, sha256Hex, timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import { openFeatureNamespace, writeFileAtomicAtPathIf } from "../main/storage/feature-namespace.js";
import { assertAveHomeInputWritable, AVE_HOME_INPUT_MAX_BYTES, isCachedAveHomeFileTrusted, readAveHomeInputSync } from "../shared/ave-home-trust.js";
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
const ChangePayload = z.object({
  id: Id,
  action: z.enum(["activate", "stage", "apply", "reject", "undo"]),
  at: z.iso.datetime(),
  actor: z.enum(["host", "owner"]),
  before: Lesson.nullable(),
  after: Lesson.nullable(),
}).strict();
const Change = ChangePayload.extend({ prevDigest: Hash.nullable(), digest: Hash });
const Group = z.object({
  scope: Scope.extend({ filePath: z.string().refine(isAbsolute) }),
  active: z.array(z.unknown()),
  staged: z.array(z.unknown()),
  retired: z.array(z.unknown()).optional(),
  history: z.array(z.unknown()),
}).strict();
const Envelope = z.object({ version: z.union([z.literal(1), z.literal(2)]), groups: z.array(z.unknown()) }).strict();

type StoredGroup = Omit<SkillMemoryGroup, "scope"> & { scope: z.infer<typeof Group>["scope"] };
type Document = { version: 2; groups: StoredGroup[] };
type NewLesson = { binding: SkillMemoryBinding; lesson: Omit<SkillMemoryLesson, "id" | "digest" | "fingerprint"> };

const FILENAME = "lessons.json";
const HISTORY_LIMIT = SKILL_MEMORY_SCOPE_LIMIT * 2;
const log = createLogger("skill-memory");

function digestLesson(lesson: Omit<SkillMemoryLesson, "digest">): string {
  const { id, description, body, fingerprint, origin } = lesson;
  return sha256Hex(JSON.stringify([id, description, body, fingerprint, origin.sessionId, origin.messageId, origin.completionId, origin.runKind]));
}

function validLesson(lesson: SkillMemoryLesson): boolean {
  const clean = sanitizeSkillMemoryText(lesson.description, lesson.body);
  return clean?.description === lesson.description && clean.body === lesson.body
    && timingSafeEqualHexDigest(lesson.digest, digestLesson(lesson));
}

function digestChange(scopeId: string, change: Omit<SkillMemoryChange, "digest">): string {
  return sha256Hex(JSON.stringify([scopeId, change.prevDigest, change.id, change.action, change.at, change.actor,
    change.before?.digest ?? null, change.after?.digest ?? null]));
}

function repairChain(scopeId: string, history: SkillMemoryChange[]): SkillMemoryChange[] {
  let prevDigest = history[0]?.prevDigest ?? null;
  return history.map(change => {
    const row = { ...change, prevDigest };
    prevDigest = digestChange(scopeId, row);
    return { ...row, digest: prevDigest };
  });
}

function compactHistory(group: StoredGroup): void {
  let excess = group.history.length - HISTORY_LIMIT;
  if (excess <= 0) return;
  const undoIds = new Set(group.active.flatMap(lesson => {
    const change = group.history.findLast(row => (row.action === "activate" || row.action === "apply")
      && row.after?.digest === lesson.digest);
    return change ? [change.id] : [];
  }));
  group.history = repairChain(group.scope.id, group.history.filter(row => {
    if (excess <= 0 || undoIds.has(row.id)) return true;
    excess--;
    return false;
  }));
}

function addChange(group: StoredGroup, action: SkillMemoryChange["action"], before: SkillMemoryLesson | null, after: SkillMemoryLesson | null): void {
  const actor = action === "activate" || action === "stage" ? "host" : "owner";
  const change = { id: randomUUID(), action, at: new Date().toISOString(), actor, before, after,
    prevDigest: group.history.at(-1)?.digest ?? null } as const;
  group.history.push({ ...change, digest: digestChange(group.scope.id, change) });
  compactHistory(group);
}

function readLessons(input: unknown[]): SkillMemoryLesson[] {
  return input.flatMap(row => {
    const lesson = Lesson.safeParse(row);
    return lesson.success && validLesson(lesson.data) ? [lesson.data] : [];
  }).slice(-SKILL_MEMORY_SCOPE_LIMIT);
}

function readDocument(bytes: Buffer): Document {
  const envelope = Envelope.parse(JSON.parse(bytes.toString("utf8")));
  let isolated = 0;
  const groups = envelope.groups.flatMap(row => {
    const parsed = Group.safeParse(row);
    if (!parsed.success) { isolated++; return []; }
    const { scope, active, staged, retired = [], history } = parsed.data;
    const group: StoredGroup = {
      scope, active: readLessons(active), staged: readLessons(staged), retired: readLessons(retired), history: [],
    };
    isolated += active.length + staged.length + retired.length - group.active.length - group.staged.length - group.retired.length;
    let previous: string | undefined;
    for (const item of history) {
      const legacy = envelope.version === 1 ? ChangePayload.safeParse(item) : undefined;
      const migrated = legacy?.success ? { ...legacy.data, prevDigest: previous ?? null } : undefined;
      const result = Change.safeParse(migrated ? { ...migrated, digest: digestChange(scope.id, migrated) } : item);
      if (!result.success) { isolated++; previous = undefined; continue; }
      const change = result.data;
      const linked = previous === undefined || change.prevDigest === previous;
      previous = change.digest;
      if (!linked || change.digest !== digestChange(scope.id, change)
        || (change.before && !validLesson(change.before)) || (change.after && !validLesson(change.after))) {
        isolated++;
        continue;
      }
      group.history.push(change);
    }
    if (group.history.length !== history.length) {
      // Close gaps after isolating invalid records. The next mutation writes the repaired chain.
      group.history = repairChain(scope.id, group.history);
    }
    compactHistory(group);
    return [group];
  });
  if (isolated) log.warn("Isolated %d invalid or excess skill memory rows", isolated);
  return { version: 2, groups };
}

function groupFor(document: Document, binding: SkillMemoryBinding): Document["groups"][number] {
  const existing = document.groups.find(group => group.scope.id === binding.id);
  if (existing) return existing;
  const { id, skill, projectRoot, filePath } = binding;
  const group = { scope: { id, skill, projectRoot, filePath }, active: [], staged: [], retired: [], history: [] };
  document.groups.push(group);
  return group;
}

function plainDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat === undefined || (stat.isDirectory() && !stat.isSymbolicLink());
}

export class SkillMemoryStore {
  private readonly namespace = openFeatureNamespace("skill-memory");
  private cached: { stamp: string; digest: string; document: Document } | undefined;

  async listCurrent(isCurrent: (scope: StoredGroup["scope"], fingerprint: string) => Promise<boolean>): Promise<SkillMemoryGroup[]> {
    return Promise.all(this.read(true).groups.map(async ({ scope, ...group }) => {
      const fingerprints = new Set([...group.active, ...group.staged].map(row => row.fingerprint));
      const verified = await Promise.all([...fingerprints].map(async fingerprint => [fingerprint, await isCurrent(scope, fingerprint)] as const));
      const current = new Map(verified);
      const isLive = (row: SkillMemoryLesson) => current.get(row.fingerprint) === true;
      const retired = [...group.retired, ...group.active.filter(row => !isLive(row)), ...group.staged.filter(row => !isLive(row))];
      const { id, skill, projectRoot } = scope;
      return structuredClone({
        scope: { id, skill, projectRoot }, active: group.active.filter(isLive), staged: group.staged.filter(isLive),
        retired: retired.slice(-SKILL_MEMORY_SCOPE_LIMIT), history: group.history,
      });
    }));
  }

  list(): SkillMemoryGroup[] {
    return this.read(true).groups.map(({ scope, ...group }) => {
      const { id, skill, projectRoot } = scope;
      return structuredClone({ ...group, scope: { id, skill, projectRoot } });
    });
  }

  recall(binding: SkillMemoryBinding): SkillMemoryLesson[] {
    const group = this.read().groups.find(candidate => candidate.scope.id === binding.id);
    return group?.active.filter(lesson => lesson.fingerprint === binding.fingerprint) ?? [];
  }

  hasCompletion(completionId: string): boolean {
    return this.read().groups.some(group => [...group.active, ...group.staged, ...group.retired]
      .some(lesson => lesson.origin.completionId === completionId)
      || group.history.some(change => change.after?.origin.completionId === completionId));
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
        const isCurrent = (row: SkillMemoryLesson) => row.fingerprint === binding.fingerprint;
        group.retired = [...group.retired, ...group.active.filter(row => !isCurrent(row)),
          ...group.staged.filter(row => !isCurrent(row))].slice(-SKILL_MEMORY_SCOPE_LIMIT);
        group.active = group.active.filter(isCurrent);
        group.staged = group.staged.filter(isCurrent);
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
        if (!current && group.active.filter(row => row.fingerprint === staged.fingerprint).length >= SKILL_MEMORY_SCOPE_LIMIT) return false;
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

  private read(refreshTrust = false): Document {
    if (!plainDirectory(this.namespace.dir)) throw new Error("Invalid skill memory directory");
    const target = join(this.namespace.dir, FILENAME);
    const file = lstatSync(target, { throwIfNoEntry: false, bigint: true });
    if (file && !file.isFile()) throw new Error("Invalid skill memory file");
    const stamp = file && [target, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(":");
    if (!refreshTrust && file && this.cached && this.cached.stamp === stamp
      && isCachedAveHomeFileTrusted(target, this.cached.digest, Number(file.uid))) return this.cached.document;
    const input = readAveHomeInputSync(target);
    if (input.status === "absent") {
      this.cached = undefined;
      return { version: 2, groups: [] };
    }
    if (input.status !== "trusted" || !stamp) throw new Error("Skill memory is unreadable");
    const digest = sha256Hex(input.bytes);
    const document = this.cached?.digest === digest ? this.cached.document : readDocument(input.bytes);
    this.cached = { stamp, digest, document };
    return document;
  }

  private mutate(change: (document: Document) => boolean, canCommit: () => boolean): Promise<boolean> {
    const file = join(this.namespace.dir, FILENAME);
    return withInProcessFileQueue(file, async () => {
      if (!plainDirectory(this.namespace.dir)) return false;
      assertAveHomeInputWritable(file, "update managed skill memory");
      const document = structuredClone(this.read(true));
      if (!change(document)) return false;
      const contents = JSON.stringify(document);
      if (Buffer.byteLength(contents) > AVE_HOME_INPUT_MAX_BYTES) return false;
      const written = await writeFileAtomicAtPathIf(file, contents,
        () => plainDirectory(this.namespace.dir) && canCommit());
      if (written) this.cached = undefined;
      return written;
    });
  }
}
