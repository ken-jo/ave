import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRepository } from "../session-repository.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

describe("SessionRepository", () => {
  let dir: string;
  let repository: SessionRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-session-repository-"));
    repository = new SessionRepository({ aveDir: dir });
  });

  afterEach(async () => {
    repository.closeSearchIndex();
    await cleanupTmpDir(dir);
  });

  it("preserves transcript mtime for identical saves and refreshes the append prefix", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "안녕하세요", meta: { messageId: "row-first" } };
    const second = { role: "assistant", content: "Saved", meta: { messageId: "row-second" } };
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, [first]);
    const earlier = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, earlier, earlier);
    const before = statSync(path);

    await repository.saveSession(sessionId, [first]);

    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(await repository.appendSessionProgress(sessionId, [first, second])).toBe("appended");
    expect(repository.loadSession(sessionId)).toEqual([first, second]);
  });

  it("rewrites changed bytes even when the transcript size is unchanged", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "before" };
    const changed = { ...first, content: "after!" };
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, [first]);
    const earlier = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, earlier, earlier);
    const before = statSync(path);

    await repository.saveSession(sessionId, [changed]);

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(changed)}\n`);
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBeGreaterThan(before.mtimeMs);
  });

  it("replaces invalid on-disk bytes rather than comparing decoded text", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const messages = [{ role: "user", content: "\uFFFD" }];
    const path = join(dir, "sessions", `${sessionId}.jsonl`);
    await repository.saveSession(sessionId, messages);
    const expected = readFileSync(path);
    writeFileSync(path, Buffer.concat([
      Buffer.from('{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
    ]));

    await repository.saveSession(sessionId, messages);

    expect(readFileSync(path)).toEqual(expected);
  });

  it("round trips transcript progress and metadata through disk, lists and deletes the session", async () => {
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const first = { role: "user", content: "Remember this conversation", meta: { messageId: "row-first" } };
    const second = { role: "assistant", content: "Conversation saved", meta: { messageId: "row-second" } };
    await repository.saveSession(sessionId, [first]);
    await repository.appendSessionProgress(sessionId, [first, second]);
    await repository.saveSessionMetadata(sessionId, { sessionKind: "main", title: "Saved conversation" });

    expect(readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf-8"))
      .toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const reopened = new SessionRepository({ aveDir: dir });
    expect(reopened.loadSession(sessionId)).toEqual([first, second]);
    expect(reopened.loadSessionMetadata(sessionId)).toMatchObject({ sessionKind: "main", title: "Saved conversation" });
    expect(reopened.listSessions()).toMatchObject([{ id: sessionId, title: "Saved conversation" }]);

    await reopened.deleteSession(sessionId);
    expect(repository.loadSession(sessionId)).toBeNull();
    expect(repository.loadSessionMetadata(sessionId)).toBeNull();
    expect(repository.listSessions()).toEqual([]);
    reopened.closeSearchIndex();
  });
});
