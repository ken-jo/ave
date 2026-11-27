import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
import type { SkillMemoryApi, SkillMemoryGroup, SkillMemoryLesson } from "../../../../shared/skill-memory-types.js";
import { SkillMemoryContent } from "../SkillMemoryContent.js";

const LESSON: SkillMemoryLesson = {
  id: "lesson", digest: "lesson-digest", description: "Check the report", body: "Check the lint output.",
  fingerprint: "source", origin: { sessionId: "session", messageId: "message", completionId: "completion", runKind: "attended" },
};

it.each(["active", "retired"] as const)("deletes the %s card directly and uses the ledger's restore eligibility", async kind => {
  const group: SkillMemoryGroup = {
    scope: { id: "scope", skill: "review", projectRoot: "/project" },
    active: [], retired: [], staged: [], history: [], undo: {},
    [kind]: [LESSON],
  };
  const decide = vi.fn<SkillMemoryApi["decide"]>().mockResolvedValueOnce({ ok: false });
  decide.mockImplementationOnce(async () => {
    group[kind] = [];
    group.history = [{
      id: "deletion", action: "delete", actor: "owner", prevDigest: null, digest: "change-digest",
      before: LESSON, after: null, at: "2026-11-27T00:00:00Z",
    }];
    if (kind === "active") group.undo = { [LESSON.digest]: "deletion" };
    return { ok: true };
  });
  decide.mockImplementationOnce(async () => {
    group.active = [LESSON];
    group.undo = {};
    return { ok: true };
  });
  render(<SkillMemoryContent api={{ list: async () => ({ ok: true, groups: [group], review: "ready" }), decide }} />);
  if (kind === "retired") requiredFixture((await screen.findByText("사용 종료")).closest("details")).open = true;
  const deleteButton = await screen.findByRole("button", { name: "교훈 삭제" });
  fireEvent.click(deleteButton);
  expect(decide).toHaveBeenCalledExactlyOnceWith({ scopeId: "scope", action: "delete", lessonId: LESSON.id, digest: LESSON.digest });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  expect(deleteButton).toBeEnabled();

  fireEvent.click(deleteButton);
  const deleted = await screen.findByRole("status");
  expect(deleted).toHaveTextContent("삭제됨");
  expect(screen.queryByRole("button", { name: "교훈 삭제" })).toBeNull();
  const undo = within(requiredFixture(deleted.parentElement)).queryByRole("button", { name: "되돌리기" });
  if (kind === "retired") {
    expect(undo).toBeNull();
    return;
  }
  fireEvent.click(requiredFixture(undo));
  expect(decide).toHaveBeenLastCalledWith({ scopeId: "scope", action: "undo", changeId: "deletion", digest: LESSON.digest });
  const restored = await screen.findByRole("button", { name: "교훈 삭제" });
  expect(within(requiredFixture(restored.closest("article"))).getByRole("heading", { name: LESSON.description })).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
});
