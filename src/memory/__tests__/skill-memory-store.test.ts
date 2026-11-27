import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { AVE_HOME_INPUT_MAX_BYTES } from "../../shared/ave-home-trust.js";
import type { SkillMemoryGroup, SkillMemoryRunKind } from "../../shared/skill-memory-types.js";
import { SkillMemoryStore, skillMemoryScopeId, type SkillMemoryBinding } from "../skill-memory-store.js";

let home: string;
let store: SkillMemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ave-skill-memory-"));
  vi.stubEnv("AVE_HOME", home);
  store = new SkillMemoryStore();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(home);
});

function binding(skill = "review", project = "project"): SkillMemoryBinding {
  const filePath = join(home, "skills", skill, "SKILL.md");
  const projectRoot = join(home, project);
  const projectIdentity = sha256Hex(projectRoot);
  return { id: skillMemoryScopeId(filePath, projectRoot, projectIdentity), skill, filePath, projectRoot, projectIdentity, approval: sha256Hex("approved material"), fingerprint: sha256Hex("skill version") };
}

function record(scope = binding(), runKind: SkillMemoryRunKind = "attended", completionId = "completion",
  description = "Check the type report", body = "Check the type report before packaging.") {
  return { binding: scope, lesson: { description, body, origin: { sessionId: "session", messageId: "message", completionId, runKind } } };
}

const allow = () => true;
const recall = (scope: SkillMemoryBinding) => store.recall([scope]).map(row => row.lesson);

async function seedCapacityFixture() {
  const scope = binding();
  await store.record([record(scope)], allow, "activate");
  await store.record([record(scope, "attended", "revision", "Check the type report", "Check the revised type report.")], allow, "activate");
  await store.record([record(scope, "attended", "other", "Review the release", "Review the release.")], allow, "activate");
  await store.record([record(scope, "headless", "staged", "Review the summary", "Review the summary.")], allow, "stage");
  const path = join(home, "skill-memory", "lessons.json");
  const document = JSON.parse(readFileSync(path, "utf8")) as { version: 2; groups: (Omit<SkillMemoryGroup, "scope" | "undo"> & {
    scope: SkillMemoryGroup["scope"] & { filePath: string };
  })[] };
  const group = requiredFixture(document.groups[0]);
  const staged = requiredFixture(group.staged[0]);
  const reject = { scopeId: scope.id, action: "reject", lessonId: staged.id, digest: staged.digest } as const;
  // Pad a stored string to exercise the real byte ceilings without thousands of writes.
  const fill = (bytes: number) => {
    group.scope.filePath += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(document)));
    writeFileSync(path, JSON.stringify(document));
  };
  return { scope, path, document, group, reject, fill };
}

function undo(lesson: SkillMemoryGroup["active"][number], group: SkillMemoryGroup) {
  return { scopeId: group.scope.id, action: "undo", changeId: requiredFixture(group.undo[lesson.digest]), digest: lesson.digest } as const;
}

describe("managed skill memory", () => {
  it.each(["activate", "stage"] as const)("refuses reviewer %s at the soft cap while reject and undo still write", async action => {
    const { path, scope, reject, fill } = await seedCapacityFixture();
    fill(AVE_HOME_INPUT_MAX_BYTES / 2 - 1);
    const before = readFileSync(path, "utf8");
    const candidate = record(binding("another"), action === "stage" ? "headless" : "attended", "refused");
    await expect(store.record([candidate], allow, action)).rejects.toThrow(/capacity/i);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(recall(candidate.binding)).toEqual([]);
    expect(store.hasCompletion("refused")).toBe(false);
    expect(await store.decide(reject, allow)).toBe(true);
    const group = requiredFixture(store.list()[0]);
    expect(await store.decide(undo(requiredFixture(group.active[0]), group), allow)).toBe(true);
    expect(recall(scope)[0]?.body).toBe("Check the type report before packaging.");
  });

  it("compacts retired data and old history under pressure while keeping every current undo target and a valid ledger", async () => {
    const { group, path, reject, fill, scope } = await seedCapacityFixture();
    group.retired = Array.from({ length: 20 }, () => group.active).flat();
    fill(AVE_HOME_INPUT_MAX_BYTES);
    const before = requiredFixture(store.list()[0]);
    expect(await store.decide(reject, allow)).toBe(true);
    const after = requiredFixture(new SkillMemoryStore().list()[0]);
    expect(statSync(path).size).toBeLessThan(AVE_HOME_INPUT_MAX_BYTES);
    expect(after.retired).toEqual([]);
    expect(after.undo).toEqual(before.undo);
    expect(after.history.map(row => row.action)).toEqual(["activate", "activate", "reject"]);
    expect(after.history.slice(1).map(row => row.prevDigest)).toEqual(after.history.slice(0, -1).map(row => row.digest));
    for (const lesson of before.active) expect(await store.decide(undo(lesson, after), allow)).toBe(true);
    expect(recall(scope).map(lesson => lesson.body)).toEqual(["Check the type report before packaging."]);
  });

  it("refuses owner decisions, listing and recall together when compaction cannot leave decision headroom", async () => {
    const { scope, reject, path, fill } = await seedCapacityFixture();
    const before = requiredFixture(store.list()[0]);
    fill(AVE_HOME_INPUT_MAX_BYTES);
    const snapshot = readFileSync(path, "utf8");
    expect(() => store.list()).toThrow(/capacity/i);
    await expect(store.listCurrent(async () => true)).rejects.toThrow(/capacity/i);
    expect(() => recall(scope)).toThrow(/capacity/i);
    for (const decision of [reject, { ...reject, action: "apply" as const }, undo(requiredFixture(before.active[0]), before)]) {
      await expect(store.decide(decision, allow)).rejects.toThrow(/capacity/i);
    }
    expect(readFileSync(path, "utf8")).toBe(snapshot);
  });

  it("refuses a 129th scope while keeping existing owner decisions available", async () => {
    const { group, document, path, reject } = await seedCapacityFixture();
    for (let index = 1; index < 128; index++) {
      const { id, skill, projectRoot, filePath } = binding(`skill-${index}`);
      document.groups.push({ ...group, scope: { id, skill, projectRoot, filePath }, active: [], staged: [], history: [] });
    }
    writeFileSync(path, JSON.stringify(document));
    expect(store.list()).toHaveLength(128);
    await expect(store.record([record(binding("extra"), "attended", "extra-scope")], allow, "activate")).rejects.toThrow(/capacity/i);
    expect(await store.decide(reject, allow)).toBe(true);
    expect(store.list()).toHaveLength(128);
  });

  it("commits only to the private managed file and records before and after hashes", async () => {
    const target = binding();
    mkdirSync(target.projectRoot);
    mkdirSync(join(home, "skills", target.skill), { recursive: true });
    writeFileSync(target.filePath, "owner skill");
    expect(await store.record([record(target)], allow, "activate")).toBe(true);
    expect(readFileSync(target.filePath, "utf8")).toBe("owner skill");
    expect(existsSync(join(target.projectRoot, "lessons.json"))).toBe(false);
    const path = join(home, "skill-memory", "lessons.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const group = requiredFixture(store.list()[0]);
    expect(group.history).toEqual([expect.objectContaining({ action: "activate", before: null, after: group.active[0] })]);
    expect(group.active[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.record([record(target)], allow, "activate")).toBe(false);
  });

  it("restores the before version and rejects replayed or stale undo", async () => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    await store.record([record(scope, "attended", "later", "Check the type report", "Check the type report on all supported platforms.")], allow, "activate");
    const group = requiredFixture(store.list()[0]);
    const [original, update] = group.history;
    expect(update?.before?.digest).toBe(original?.after?.digest);
    const decideUndo = (change: NonNullable<typeof update>) => store.decide({
      scopeId: scope.id, action: "undo", changeId: change.id, digest: requiredFixture(change.after).digest,
    }, allow);
    expect(await decideUndo(requiredFixture(original))).toBe(false);
    expect(await decideUndo(requiredFixture(update))).toBe(true);
    expect(await decideUndo(requiredFixture(update))).toBe(false);
    expect(recall(scope)).toEqual([requiredFixture(original).after]);
    expect(await decideUndo(requiredFixture(original))).toBe(true);
    expect(recall(scope)).toEqual([]);
    expect(store.list()[0]?.history.map(row => row.action)).toEqual(["activate", "activate", "undo", "undo"]);
  });

  it.each(["headless", "scheduled"] as const)("stages %s without active recall and binds apply or reject to the shown digest", async runKind => {
    const scope = binding();
    expect(await store.record([record(scope, runKind)], allow, "stage")).toBe(true);
    const group = requiredFixture(store.list()[0]);
    const lesson = requiredFixture(group.staged[0]);
    expect(recall(scope)).toEqual([]);
    const select = { scopeId: scope.id, lessonId: lesson.id, digest: lesson.digest };
    expect(await store.decide({ ...select, action: "apply", digest: sha256Hex("altered") }, allow)).toBe(false);
    expect(await store.decide({ ...select, action: "apply" }, () => false)).toBe(false);
    expect(await store.decide({ ...select, action: "reject" }, allow)).toBe(true);
    expect(await store.decide({ ...select, action: "apply" }, allow)).toBe(false);
    expect(await store.record([record(scope, runKind, "next")], allow, "stage")).toBe(true);
    const staged = requiredFixture(requiredFixture(store.list()[0]).staged[0]);
    expect(await store.decide({ scopeId: scope.id, lessonId: staged.id, digest: staged.digest, action: "apply" }, allow)).toBe(true);
    expect(recall(scope).map(row => row.body)).toEqual([staged.body]);
  });

  it("keeps recall isolated by skill, project and source revision", async () => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    expect(recall(scope)).toHaveLength(1);
    expect(recall(binding("another"))).toEqual([]);
    expect(recall(binding("review", "another"))).toEqual([]);
    expect(recall({ ...scope, fingerprint: sha256Hex("replacement") })).toEqual([]);
  });

  it.each(["text", "ledger", "undo record"] as const)("refuses recall and owner access when persisted %s is corrupt", async damage => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    await store.record([record(scope, "attended", "later", "Valid lesson", "Valid lesson stays available.")], allow, "activate");
    const path = join(home, "skill-memory", "lessons.json");
    const snapshot = readFileSync(path, "utf8");
    const change = requiredFixture(store.list()[0]?.history.at(-1));
    const document = JSON.parse(snapshot);
    if (damage === "undo record") document.groups[0].history.pop();
    const corrupt = damage === "text" ? snapshot.replaceAll("Check the type report before packaging.", "<ave-skill>")
      : damage === "ledger" ? snapshot.replace('"action":"activate"', '"action":"undo"') : JSON.stringify(document);
    writeFileSync(path, corrupt);
    expect(() => store.list()).toThrow();
    await expect(store.listCurrent(async () => true)).rejects.toThrow();
    expect(() => recall(scope)).toThrow();
    await expect(store.decide({ scopeId: scope.id, action: "undo", changeId: change.id, digest: requiredFixture(change.after).digest }, allow)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(corrupt);
    writeFileSync(path, snapshot);
    expect(recall(scope)).toHaveLength(2);
  });

  it("keeps an undo target when undo restores a version whose original change was compacted", async () => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    await store.record([record(scope, "attended", "later", "Check the type report", "Use the revised type report.")], allow, "activate");
    const path = join(home, "skill-memory", "lessons.json");
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.groups[0].history.shift();
    writeFileSync(path, JSON.stringify(document));

    const undoVisible = async () => {
      const group = requiredFixture((await store.listCurrent(async () => {
        throw new Error("Skill source unavailable");
      }))[0]);
      expect(group.active).toEqual([]);
      const lesson = requiredFixture(group.retired[0]);
      expect(recall(scope)).toEqual([lesson]);
      const changeId = requiredFixture(group.undo[lesson.digest]);
      expect(await store.decide({ action: "undo", scopeId: scope.id, changeId, digest: lesson.digest }, allow)).toBe(true);
      return lesson.body;
    };
    expect(await undoVisible()).toBe("Use the revised type report.");
    expect(await undoVisible()).toBe("Check the type report before packaging.");
  });

  it("refuses a linked store", async () => {
    const scope = binding();
    const outside = join(home, "other-directory");
    mkdirSync(outside);
    const alternate = join(home, "alternate");
    mkdirSync(alternate);
    symlinkSync(outside, join(alternate, "skill-memory"), "junction");
    vi.stubEnv("AVE_HOME", alternate);
    expect(await store.record([record(scope)], allow, "activate")).toBe(false);
    expect(existsSync(join(outside, "lessons.json"))).toBe(false);
  });

  it("enforces separate 100 active and staged quotas without eviction", async () => {
    const scope = binding();
    const writes = async (runKind: SkillMemoryRunKind) => {
      for (let count = 0; count < 100; count += 3) {
        const id = `${runKind}-${count}`;
        const lessons = Array.from({ length: Math.min(3, 100 - count) }, (_, offset) =>
          record(scope, runKind, id, `Lesson ${count + offset}`));
        expect(await store.record(lessons, allow, runKind === "attended" ? "activate" : "stage")).toBe(true);
      }
      expect(await store.record([record(scope, runKind, `${runKind}-overflow`, "Overflow")], allow, runKind === "attended" ? "activate" : "stage")).toBe(false);
    };
    await writes("attended");
    await writes("headless");
    expect(store.list()[0]).toMatchObject({ active: expect.any(Array), staged: expect.any(Array) });
    expect(store.list()[0]?.active).toHaveLength(100);
    expect(store.list()[0]?.staged).toHaveLength(100);
    expect(store.list()[0]?.history).toHaveLength(200);
    const original = requiredFixture(store.list()[0]?.active[0]);
    for (let count = 0; count < 3; count++) {
      await store.record([record(scope, "attended", `revision-${count}`, "Lesson 1", `Lesson 1 revision ${count}.`)], allow, "activate");
    }
    const history = requiredFixture(store.list()[0]?.history);
    expect(history).toHaveLength(200);
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ after: original })]));
    expect(history.slice(1).map(row => row.prevDigest)).toEqual(history.slice(0, -1).map(row => row.digest));

    const next = { ...scope, fingerprint: sha256Hex("changed content") };
    await expect(store.record([record(next, "attended", "changed")], allow, "activate")).resolves.toBe(true);
    const display = await store.listCurrent(async (_scope, fingerprint) => fingerprint === next.fingerprint);
    expect(display[0]?.active).toHaveLength(1);
    expect(display[0]?.staged).toHaveLength(0);
    expect(display[0]?.retired).toHaveLength(100);
  });
});
