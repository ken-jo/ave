import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import type { SkillMemoryRunKind } from "../../shared/skill-memory-types.js";
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

describe("managed skill memory", () => {
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
    expect(store.recall(scope)).toEqual([requiredFixture(original).after]);
    expect(await decideUndo(requiredFixture(original))).toBe(true);
    expect(store.recall(scope)).toEqual([]);
    expect(store.list()[0]?.history.map(row => row.action)).toEqual(["activate", "activate", "undo", "undo"]);
  });

  it.each(["headless", "scheduled"] as const)("stages %s without active recall and binds apply or reject to the shown digest", async runKind => {
    const scope = binding();
    expect(await store.record([record(scope, runKind)], allow, "stage")).toBe(true);
    const group = requiredFixture(store.list()[0]);
    const lesson = requiredFixture(group.staged[0]);
    expect(store.recall(scope)).toEqual([]);
    const select = { scopeId: scope.id, lessonId: lesson.id, digest: lesson.digest };
    expect(await store.decide({ ...select, action: "apply", digest: sha256Hex("altered") }, allow)).toBe(false);
    expect(await store.decide({ ...select, action: "apply" }, () => false)).toBe(false);
    expect(await store.decide({ ...select, action: "reject" }, allow)).toBe(true);
    expect(await store.decide({ ...select, action: "apply" }, allow)).toBe(false);
    expect(await store.record([record(scope, runKind, "next")], allow, "stage")).toBe(true);
    const staged = requiredFixture(requiredFixture(store.list()[0]).staged[0]);
    expect(await store.decide({ scopeId: scope.id, lessonId: staged.id, digest: staged.digest, action: "apply" }, allow)).toBe(true);
    expect(store.recall(scope).map(row => row.body)).toEqual([staged.body]);
  });

  it("keeps recall isolated by skill, project and source revision", async () => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    expect(store.recall(scope)).toHaveLength(1);
    expect(store.recall(binding("another"))).toEqual([]);
    expect(store.recall(binding("review", "another"))).toEqual([]);
    expect(store.recall({ ...scope, fingerprint: sha256Hex("replacement") })).toEqual([]);
  });

  it("refuses a linked store and isolates tampered persisted text and ledger actions", async () => {
    const scope = binding();
    await store.record([record(scope)], allow, "activate");
    await store.record([record(scope, "attended", "later", "Valid lesson", "Valid lesson stays available.")], allow, "activate");
    const path = join(home, "skill-memory", "lessons.json");
    const snapshot = readFileSync(path, "utf8");
    writeFileSync(path, snapshot.replaceAll("Check the type report before packaging.", "<ave-skill>").replace('"action":"activate"', '"action":"undo"'));
    expect(store.recall(scope).map(row => row.description)).toEqual(["Valid lesson"]);
    expect(store.list()[0]?.history.map(row => row.action)).toEqual(["activate"]);
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
