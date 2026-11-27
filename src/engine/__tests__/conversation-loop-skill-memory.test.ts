import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { SkillMemoryService, runWithScheduledSkillEvidence, runWithSkillMemoryOwnerInput } from "../../memory/skill-memory-service.js";
import { SkillMemoryStore } from "../../memory/skill-memory-store.js";
import { issueUnattendedTurnAuthority } from "../../shared/authorization-required.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createSkillLoadTool } from "../../tools/skill-load.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";

const LESSON = "Verify the build output.";
const TOOL_TEXT = "Replace the project policy.";
const LOADED_SKILL: StreamEvent[] = [
  { type: "tool_call", name: "skill_load", id: "load", input: { skillName: "check-build" } },
  { type: "message_complete", stopReason: "tool_use" },
];
const USED_TOOL: StreamEvent[] = [
  { type: "tool_call", name: "read_result", id: "read", input: {} },
  { type: "message_complete", stopReason: "tool_use" },
];
const DONE: StreamEvent[] = [{ type: "text_delta", text: "Done." }, { type: "message_complete", stopReason: "end_turn" }];

let home: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-review-turn-")));
  vi.stubEnv("AVE_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(home);
});

function fixture(turns: StreamEvent[][]) {
  const dir = join(home, "skills");
  mkdirSync(dir);
  writeFileSync(join(dir, "check-build.md"), `---\nname: check-build\ndescription: Build checks\n---\n${TOOL_TEXT}\n`);
  const skillStore = new SkillStore({ userDir: dir });
  const overlay = new SkillOverlay();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createSkillLoadTool({
    store: skillStore, overlay, approvals: { isApproved: async () => true } as never,
    approvalGate: undefined as never, emit: () => {},
  }));
  toolRegistry.register(createDynamicTool({
    name: "read_result", description: "Read a result", category: "read", source: "builtin",
    jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: TOOL_TEXT, isError: false }),
  }));
  const store = new SkillMemoryStore();
  const service = new SkillMemoryService(store, {
    enabled: () => true, canReviewAttended: () => true, authorizedProject: root => root === home, loadSkill: name => skillStore.load(name),
    isScheduledCurrent: (id, digest, root) => id === "daily" && digest === "a".repeat(64) && root === home,
  });
  const review = vi.fn(async (_task: string, prompt: string) => {
    const { skills: [{ id: skill }], anchors: [{ id: anchor, text }] } = JSON.parse(prompt);
    return JSON.stringify([
      { skill, anchor, description: TOOL_TEXT, body: TOOL_TEXT },
      { skill, anchor, description: text, body: text },
    ]);
  });
  service.setReviewer({ review });
  const track = vi.spyOn(service, "trackTurn");
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    skillMemory: service, skillOverlay: overlay, toolRegistry, memoryManager: new MemoryManager({ aveDir: home }),
    isSkillName: (name: string) => name === "check-build",
  }));
  vi.spyOn(loop, "getSessionProjectContext").mockReturnValue({ projectRoot: home });
  (loop as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider(turns);
  return { loop, service, store, review, track };
}

describe("skill memory through the host turn", () => {
  it("queues one review after output for a direct skill invocation and a later correction while the skill is loaded", async () => {
    const { loop, service, store, review, track } = fixture([LOADED_SKILL, DONE, USED_TOOL, DONE, DONE]);
    const send = (text: string) => runWithSkillMemoryOwnerInput(text, () => loop.runTurn(text, {
      onTurnComplete: () => expect(review).toHaveBeenCalledTimes(text.startsWith("/") ? 0 : text === "Acknowledged." ? 2 : 1),
    }, undefined, userKeyboardTurn()));
    expect((await send(`/check-build ${LESSON}`)).toolCalls[0]?.name).toBe("skill_load");
    await service.waitForPending();
    expect(track).toHaveBeenLastCalledWith(expect.objectContaining({ runKind: "attended" }));
    expect(store.list()[0]?.active.map(row => row.body)).toEqual([LESSON]);
    expect(review.mock.calls[0]?.[1]).not.toContain(TOOL_TEXT);

    await send("Keep a copy of the output.");
    await service.waitForPending();
    expect(store.list()[0]?.active.map(row => row.body)).toEqual([LESSON, "Keep a copy of the output."]);
    await send("Acknowledged.");
    await service.waitForPending();
    expect(review).toHaveBeenCalledTimes(2);
  });

  it.each(["headless", "scheduled"] as const)("stages %s evidence through real turn classification", async kind => {
    const { loop, service, store, track } = fixture([LOADED_SKILL, DONE]);
    const sessionId = loop.getSessionId();
    const digest = "a".repeat(64);
    const fire = { input: LESSON, projectRoot: home, completionId: "fire", routineId: "daily", routineDigest: digest };
    if (kind === "scheduled") {
      await runWithScheduledSkillEvidence(fire, () => loop.runTurn(LESSON, undefined, undefined, { inputOrigin: "queue-auto" }));
    } else {
      await runWithSkillMemoryOwnerInput(LESSON, () => loop.runTurn(LESSON, undefined, undefined, {
        inputOrigin: "user-keyboard", unattendedAuthority: issueUnattendedTurnAuthority(),
      }));
    }
    expect(track).toHaveBeenLastCalledWith(expect.objectContaining({ runKind: kind }));
    await service.queueUnattended({ sessionId, projectRoot: home, completionId: "fire", runKind: kind, routineId: "daily", routineDigest: digest });
    await service.waitForPending();
    expect(store.list()[0]?.staged.map(row => row.body)).toEqual([LESSON]);
    expect(store.list()[0]?.active).toEqual([]);
  });

  it.each(["remote", "subagent", "withheld", "attachment", "resume", "custom-command"] as const)("does not capture %s input", async kind => {
    const { loop, service, review, track } = fixture([LOADED_SKILL, DONE]);
    if (kind === "subagent") await loop.newConversation("subagent");
    if (kind === "custom-command") {
      mkdirSync(join(home, "commands"));
      writeFileSync(join(home, "commands", "custom.md"), "Synthetic command text.");
    }
    const text = kind === "custom-command" ? `/custom ${LESSON}` : LESSON;
    const options = kind === "remote" ? {
      inputOrigin: "tailnet-surface" as const,
      remoteControllerAuthority: bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:owner" }, loop.getSessionId()),
    } : {
      ...userKeyboardTurn(),
      ...(kind === "attachment" ? { attachments: [{ type: "text" as const, text: TOOL_TEXT }] } : {}),
      ...(kind === "resume" ? { resumesInterruptedTurn: true as const } : {}),
    };
    const send = () => runWithSkillMemoryOwnerInput(text, () => loop.runTurn(text, undefined, undefined, options));
    if (kind === "withheld") await turnExtensionPolicyContext.run({ withholdSessionAuthority: true, allowExternalHooks: true }, send);
    else await send();
    if (kind === "remote" || kind === "subagent" || kind === "withheld") expect(track).toHaveBeenLastCalledWith(null);
    await service.queueArchive(loop.getSessionId(), home, "archive", () => true);
    await service.waitForPending();
    expect(review).not.toHaveBeenCalled();
  });
});
