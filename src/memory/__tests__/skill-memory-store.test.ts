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
    expect(await store.record([record(target)], allow)).toBe(true);
    expect(readFileSync(target.filePath, "utf8")).toBe("owner skill");
    expect(existsSync(join(target.projectRoot, "lessons.json"))).toBe(false);
    const path = join(home, "skill-memory", "lessons.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const group = requiredFixture(store.list()[0]);
    expect(group.history).toEqual([expect.objectContaining({ action: "activate", before: null, after: group.active[0] })]);
    expect(group.active[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.record([record(target)], allow)).toBe(false);
  });

  it("restores the before version and rejects replayed or stale undo", async () => {
    const scope = binding();
    await store.record([record(scope)], allow);
    await store.record([record(scope, "attended", "later", "Check the type report", "Check the type report on all supported platforms.")], allow);
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
    expect(await store.record([record(scope, runKind)], allow)).toBe(true);
    const group = requiredFixture(store.list()[0]);
    const lesson = requiredFixture(group.staged[0]);
    expect(store.recall(scope)).toEqual([]);
    const select = { scopeId: scope.id, lessonId: lesson.id, digest: lesson.digest };
    expect(await store.decide({ ...select, action: "apply", digest: sha256Hex("altered") }, allow)).toBe(false);
    expect(await store.decide({ ...select, action: "apply" }, () => false)).toBe(false);
    expect(await store.decide({ ...select, action: "reject" }, allow)).toBe(true);
    expect(await store.decide({ ...select, action: "apply" }, allow)).toBe(false);
    expect(await store.record([record(scope, runKind, "next")], allow)).toBe(true);
    const staged = requiredFixture(requiredFixture(store.list()[0]).staged[0]);
    expect(await store.decide({ scopeId: scope.id, lessonId: staged.id, digest: staged.digest, action: "apply" }, allow)).toBe(true);
    expect(store.recall(scope).map(row => row.body)).toEqual([staged.body]);
  });

  it("keeps recall isolated by skill, project and source revision", async () => {
    const scope = binding();
    await store.record([record(scope)], allow);
    expect(store.recall(scope)).toHaveLength(1);
    expect(store.recall(binding("another"))).toEqual([]);
    expect(store.recall(binding("review", "another"))).toEqual([]);
    expect(store.recall({ ...scope, fingerprint: sha256Hex("replacement") })).toEqual([]);
  });

  it("refuses a linked store and tampered persisted text", async () => {
    const scope = binding();
    await store.record([record(scope)], allow);
    const path = join(home, "skill-memory", "lessons.json");
    const snapshot = readFileSync(path, "utf8");
    writeFileSync(path, snapshot.replace("Check the type report before packaging.", "<ave-skill>"));
    expect(() => store.recall(scope)).toThrow("Invalid skill memory version");
    const outside = join(home, "other-directory");
    mkdirSync(outside);
    const alternate = join(home, "alternate");
    mkdirSync(alternate);
    symlinkSync(outside, join(alternate, "skill-memory"), "junction");
    vi.stubEnv("AVE_HOME", alternate);
    expect(await store.record([record(scope)], allow)).toBe(false);
    expect(existsSync(join(outside, "lessons.json"))).toBe(false);
  });

  it("enforces separate 100 active and staged quotas without eviction", async () => {
    const scope = binding();
    const writes = async (runKind: SkillMemoryRunKind) => {
      for (let count = 0; count < 100; count += 3) {
        const id = `${runKind}-${count}`;
        const lessons = Array.from({ length: Math.min(3, 100 - count) }, (_, offset) =>
          record(scope, runKind, id, `Lesson ${count + offset}`));
        expect(await store.record(lessons, allow)).toBe(true);
      }
      expect(await store.record([record(scope, runKind, `${runKind}-overflow`, "Overflow")], allow)).toBe(false);
    };
    await writes("attended");
    await writes("headless");
    expect(store.list()[0]).toMatchObject({ active: expect.any(Array), staged: expect.any(Array) });
    expect(store.list()[0]?.active).toHaveLength(100);
    expect(store.list()[0]?.staged).toHaveLength(100);
    expect(store.list()[0]?.history).toHaveLength(200);
  });
});
