import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { SHA256_HEX, sha256Hex, timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import { openFeatureNamespace, writeFileAtomicAtPathIf } from "../main/storage/feature-namespace.js";
import { assertAveHomeInputWritable, AVE_HOME_INPUT_MAX_BYTES, readAveHomeInputSync } from "../shared/ave-home-trust.js";
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
  active: z.array(Lesson).max(SKILL_MEMORY_SCOPE_LIMIT),
  staged: z.array(Lesson).max(SKILL_MEMORY_SCOPE_LIMIT),
  retired: z.array(Lesson).max(SKILL_MEMORY_SCOPE_LIMIT).optional(),
  history: z.array(z.unknown()),
}).strict();
const Envelope = z.object({ version: z.union([z.literal(1), z.literal(2)]), groups: z.array(z.unknown()) }).strict();

type StoredGroup = Omit<SkillMemoryGroup, "scope" | "undo"> & { scope: z.infer<typeof Group>["scope"] };
type Document = { version: 2; groups: StoredGroup[] };
type NewLesson = { binding: SkillMemoryBinding; lesson: Omit<SkillMemoryLesson, "id" | "digest" | "fingerprint"> };

const FILENAME = "lessons.json";
const DOCUMENT_SCOPE_LIMIT = 128;
const HISTORY_LIMIT = SKILL_MEMORY_SCOPE_LIMIT * 2;
// Reserve half the trusted-file limit for owner decisions and retained ledger rows.
const REVIEW_MAX_BYTES = AVE_HOME_INPUT_MAX_BYTES / 2;
// A generated decision row has a UUID, millisecond timestamp and two SHA-256 digests.
const OWNER_CHANGE_HEADER_BYTES = 512;
const log = createLogger("skill-memory");

export class SkillMemoryCapacityError extends Error {
  constructor() {
    super("Skill memory storage capacity exhausted");
  }
}

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

function undoChange(history: SkillMemoryChange[], lesson: SkillMemoryLesson): SkillMemoryChange | undefined {
  const matches = (row: SkillMemoryChange) => row.after?.digest === lesson.digest;
  // An undo may restore a version whose original change was compacted.
  return history.findLast(row => (row.action === "activate" || row.action === "apply") && matches(row))
    ?? history.findLast(row => row.action === "undo" && matches(row));
}

function undoByDigest({ active, history }: StoredGroup): SkillMemoryGroup["undo"] {
  return Object.fromEntries(active.map(lesson => {
    const change = undoChange(history, lesson);
    if (!change) throw new Error("Active skill memory has no undo record");
    return [lesson.digest, change.id];
  }));
}

function compactHistory(group: StoredGroup, limit = HISTORY_LIMIT, keepId?: string): void {
  let excess = group.history.length - limit;
  if (excess <= 0) return;
  const undoIds = new Set(Object.values(undoByDigest(group)));
  group.history = repairChain(group.scope.id, group.history.filter(row => {
    if (excess <= 0 || row.id === keepId || undoIds.has(row.id)) return true;
    excess--;
    return false;
  }));
}

function compactOwnerHistory(document: Document, ownerScopeId?: string): void {
  for (const group of document.groups) {
    group.retired = [];
    const keepId = group.scope.id === ownerScopeId ? group.history.at(-1)?.id : undefined;
    compactHistory(group, 0, keepId);
  }
}

function ownerDecisionsFit(document: Document): boolean {
  let bytes = Buffer.byteLength(JSON.stringify({ version: document.version, groups: [] }));
  let decisionBytes = 0;
  for (const { scope, active, staged, history } of document.groups) {
    bytes += Buffer.byteLength(JSON.stringify({ scope, active: [], staged: [], retired: [], history: [] })) + 1;
    const slots = active.length + staged.length;
    if (slots === 0) continue;

    const lessons = new Map<string, SkillMemoryLesson>();
    let headerBytes = OWNER_CHANGE_HEADER_BYTES;
    for (const lesson of [...active, ...staged]) lessons.set(lesson.digest, lesson);
    for (const row of history) {
      if (row.before) lessons.set(row.before.digest, row.before);
      if (row.after) lessons.set(row.after.digest, row.after);
      headerBytes = Math.max(headerBytes, Buffer.byteLength(JSON.stringify({
        ...row, prevDigest: row.digest, before: null, after: null,
      })));
    }
    let contentBytes = 0;
    let idBytes = 0;
    for (const lesson of lessons.values()) {
      contentBytes = Math.max(contentBytes, Buffer.byteLength(JSON.stringify({ ...lesson, id: "" })));
      idBytes = Math.max(idBytes, Buffer.byteLength(JSON.stringify(lesson.id)));
    }
    const lessonBytes = contentBytes + idBytes;
    // Each slot may become active and need one undo row with two lesson snapshots.
    // Owner actions cannot add slots or introduce new lesson text, provenance or IDs.
    bytes += slots * (3 * lessonBytes + headerBytes + 2);
    decisionBytes = Math.max(decisionBytes, 2 * lessonBytes + OWNER_CHANGE_HEADER_BYTES + 1);
  }
  return bytes + decisionBytes <= AVE_HOME_INPUT_MAX_BYTES;
}

function addChange(group: StoredGroup, action: SkillMemoryChange["action"], before: SkillMemoryLesson | null, after: SkillMemoryLesson | null): void {
  const actor = action === "activate" || action === "stage" ? "host" : "owner";
  const change = { id: randomUUID(), action, at: new Date().toISOString(), actor, before, after,
    prevDigest: group.history.at(-1)?.digest ?? null } as const;
  group.history.push({ ...change, digest: digestChange(group.scope.id, change) });
  compactHistory(group);
}

function readDocument(bytes: Buffer): Document {
  const envelope = Envelope.parse(JSON.parse(bytes.toString("utf8")));
  if (envelope.groups.length > DOCUMENT_SCOPE_LIMIT) throw new SkillMemoryCapacityError();
  const scopeIds = new Set<string>();
  const groups = envelope.groups.map(row => {
    const { scope, active, staged, retired = [], history } = Group.parse(row);
    if (scopeIds.has(scope.id) || ![...active, ...staged, ...retired].every(validLesson)) {
      throw new Error("Invalid skill memory records");
    }
    scopeIds.add(scope.id);
    const group: StoredGroup = { scope, active, staged, retired, history: [] };
    const changeIds = new Set<string>();
    let previous: string | undefined;
    for (const item of history) {
      const legacy = envelope.version === 1 ? ChangePayload.safeParse(item) : undefined;
      const migrated = legacy?.success ? { ...legacy.data, prevDigest: previous ?? null } : undefined;
      const change = Change.parse(migrated ? { ...migrated, digest: digestChange(scope.id, migrated) } : item);
      const linked = previous === undefined || change.prevDigest === previous;
      previous = change.digest;
      if (!linked || changeIds.has(change.id) || change.digest !== digestChange(scope.id, change)
        || (change.before && !validLesson(change.before)) || (change.after && !validLesson(change.after))) {
        throw new Error("Invalid skill memory ledger");
      }
      changeIds.add(change.id);
      group.history.push(change);
    }
    undoByDigest(group);
    compactHistory(group);
    return group;
  });
  const document = { version: 2, groups } as const;
  if (!ownerDecisionsFit(document)) {
    // Older documents may need compaction before they can reserve owner headroom.
    compactOwnerHistory(document);
    if (!ownerDecisionsFit(document)) throw new SkillMemoryCapacityError();
  }
  return document;
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
  private cached: { digest: string; document: Document } | undefined;

  async listCurrent(isCurrent: (scope: StoredGroup["scope"], fingerprint: string) => Promise<boolean>): Promise<SkillMemoryGroup[]> {
    return Promise.all(this.read().groups.map(async ({ scope, ...group }) => {
      const fingerprints = new Set([...group.active, ...group.staged].map(row => row.fingerprint));
      const verified = await Promise.all([...fingerprints].map(async fingerprint => {
        try {
          return [fingerprint, await isCurrent(scope, fingerprint)] as const;
        } catch {
          log.warn("Skill memory source could not be verified for display");
          return [fingerprint, false] as const;
        }
      }));
      const current = new Map(verified);
      const isLive = (row: SkillMemoryLesson) => current.get(row.fingerprint) === true;
      const retired = [...group.retired, ...group.active.filter(row => !isLive(row)), ...group.staged.filter(row => !isLive(row))];
      const { id, skill, projectRoot } = scope;
      return structuredClone({
        scope: { id, skill, projectRoot }, active: group.active.filter(isLive), staged: group.staged.filter(isLive),
        retired, history: group.history, undo: undoByDigest({ scope, ...group }),
      });
    }));
  }

  list(): SkillMemoryGroup[] {
    return this.read().groups.map(({ scope, ...group }) => {
      const { id, skill, projectRoot } = scope;
      return structuredClone({ ...group, scope: { id, skill, projectRoot }, undo: undoByDigest({ scope, ...group }) });
    });
  }

  recall(bindings: readonly SkillMemoryBinding[]): { skill: string; lesson: SkillMemoryLesson }[] {
    if (bindings.length === 0) return [];
    const { groups } = this.read();
    return bindings.flatMap(({ id, skill, fingerprint }) => groups.find(group => group.scope.id === id)?.active
      .filter(lesson => lesson.fingerprint === fingerprint).map(lesson => ({ skill, lesson })) ?? []);
  }

  hasCompletion(completionId: string): boolean {
    return this.read().groups.some(group => [...group.active, ...group.staged, ...group.retired]
      .some(lesson => lesson.origin.completionId === completionId)
      || group.history.some(change => change.after?.origin.completionId === completionId));
  }

  record(candidates: readonly NewLesson[], canCommit: () => boolean, action: "activate" | "stage"): Promise<boolean> {
    const [first] = candidates;
    if (!first || candidates.length > SKILL_MEMORY_COMPLETION_LIMIT) return Promise.resolve(false);
    const origin = first.lesson.origin;
    const { completionId, runKind, sessionId } = origin;
    if (action === "activate" && runKind !== "attended") return Promise.resolve(false);
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
        const rows = action === "activate" ? group.active : group.staged;
        const existing = rows.find(row => row.description === clean.description && row.fingerprint === binding.fingerprint);
        if (existing?.body === clean.body) continue;
        if (!existing && rows.length >= SKILL_MEMORY_SCOPE_LIMIT) return false;
        const version = { ...clean, origin: lesson.origin, fingerprint: binding.fingerprint, id: existing?.id ?? randomUUID() };
        const next = { ...version, digest: digestLesson(version) };
        if (existing) rows.splice(rows.indexOf(existing), 1, next);
        else rows.push(next);
        addChange(group, action, existing ?? null, next);
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
        const current = group.active.find(lesson => timingSafeEqualHexDigest(lesson.digest, decision.digest));
        const change = current && undoChange(group.history, current);
        if (!current || !change || change.id !== decision.changeId) return false;
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
    }, () => target !== undefined && canCommit(target.scope, target.lesson), decision.scopeId);
  }

  private read(): Document {
    if (!plainDirectory(this.namespace.dir)) throw new Error("Invalid skill memory directory");
    const target = join(this.namespace.dir, FILENAME);
    const file = lstatSync(target, { throwIfNoEntry: false });
    if (file && !file.isFile()) throw new Error("Invalid skill memory file");
    // List and recall both require the same write admission as undo.
    assertAveHomeInputWritable(target, "update managed skill memory");
    const input = readAveHomeInputSync(target, { requireRegularFile: true });
    if (input.status === "absent") {
      this.cached = undefined;
      return { version: 2, groups: [] };
    }
    if (input.status !== "trusted") throw new Error("Skill memory is unreadable");
    accessSync(this.namespace.dir, constants.W_OK | constants.X_OK);
    const digest = sha256Hex(input.bytes);
    const document = this.cached?.digest === digest ? this.cached.document : readDocument(input.bytes);
    this.cached = { digest, document };
    return document;
  }

  private mutate(change: (document: Document) => boolean, canCommit: () => boolean, ownerScopeId?: string): Promise<boolean> {
    const file = join(this.namespace.dir, FILENAME);
    return withInProcessFileQueue(file, async () => {
      if (!plainDirectory(this.namespace.dir)) return false;
      const document = structuredClone(this.read());
      if (!change(document)) return false;
      let contents = JSON.stringify(document);
      if (ownerScopeId === undefined) {
        if (document.groups.length > DOCUMENT_SCOPE_LIMIT || Buffer.byteLength(contents) > REVIEW_MAX_BYTES
          || !ownerDecisionsFit(document)) {
          if (!canCommit()) return false;
          throw new SkillMemoryCapacityError();
        }
      } else if (Buffer.byteLength(contents) > AVE_HOME_INPUT_MAX_BYTES) {
        compactOwnerHistory(document, ownerScopeId);
        contents = JSON.stringify(document);
        if (Buffer.byteLength(contents) > AVE_HOME_INPUT_MAX_BYTES) throw new SkillMemoryCapacityError();
      }
      const written = await writeFileAtomicAtPathIf(file, contents,
        () => plainDirectory(this.namespace.dir) && canCommit());
      if (written) this.cached = undefined;
      return written;
    });
  }
}
