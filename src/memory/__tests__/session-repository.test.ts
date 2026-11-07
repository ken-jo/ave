import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
