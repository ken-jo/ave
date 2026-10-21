import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSafeA2AStructuralId } from "../../engine/a2a-agent-message-envelope.js";
import {
  canonicalizeInboundA2ASubAgentMessage,
  isSafeA2AMessageId,
} from "../../engine/a2a-subagent-message-codec.js";
import { A2ARole, A2ATaskState } from "../../shared/a2a.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { isSafeStructuralId } from "../../shared/dlp-safe-id.js";
import { A2ATaskStore, canonicalizeA2ARemoteTask } from "../a2a-task-store.js";
import { monotonicIsoClock } from "./a2a-test-helpers.js";

const COLLIDING_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-010123456789";
const PHONE_CONTENT = "Call 010123456789 or 010-1234-5678 or 212-555-1234";

describe("A2A structural UUID admission", () => {
  it("accepts 10,000 random UUIDs in bare and host namespaced task and message fields", () => {
    for (let index = 0; index < 10_000; index += 1) {
      const uuid = randomUUID();
      const tag = uuid.slice(0, 8);
      for (const id of [uuid, `sub-${tag}-${uuid}`, `a2a-wire-${tag}-${uuid}`]) {
        expect(isSafeStructuralId(id), id).toBe(true);
        expect(isSafeA2AStructuralId(id), id).toBe(true);
        expect(isSafeA2AMessageId(id), id).toBe(true);
        const message = {
          messageId: id,
          contextId: id,
          taskId: id,
          role: A2ARole.USER,
          parts: [{ text: "hello" }],
          referenceTaskIds: [id],
        };
        expect(canonicalizeInboundA2ASubAgentMessage(message), id).toMatchObject({
          ok: true,
          message,
        });
        expect(canonicalizeA2ARemoteTask({
          id,
          contextId: id,
          status: { state: A2ATaskState.SUBMITTED },
          history: [message],
          artifacts: [{ artifactId: id, parts: [{ text: "result" }] }],
        }), id).toMatchObject({
          id,
          contextId: id,
          history: [message],
          artifacts: [{ artifactId: id }],
        });
      }
    }
  });

  it.each([
    COLLIDING_UUID,
    `sub-abcdefab-${COLLIDING_UUID}`,
    `a2a-wire-abcdefab-${COLLIDING_UUID}`,
  ])("persists and reloads a phone-colliding child identifier %s without altering content filtering", async (childSessionId) => {
    expect(maskSensitiveData(COLLIDING_UUID).detections.length).toBeGreaterThan(0);
    let persisted: unknown;
    const namespace = {
      readJson: async <T>(_name: string, fallback: T): Promise<T> =>
        structuredClone(persisted === undefined ? fallback : persisted) as T,
      writeJson: async <T>(_name: string, value: T): Promise<void> => {
        persisted = structuredClone(value);
      },
    };
    const options = {
      namespace,
      maxTasks: 4,
      maxHistoryMessages: 8,
      now: monotonicIsoClock(),
    };
    const store = new A2ATaskStore(options);
    const created = await store.create({
      handlerId: "profile-a",
      childSessionId,
      contextId: COLLIDING_UUID,
      message: {
        messageId: COLLIDING_UUID,
        role: A2ARole.USER,
        parts: [{ text: `${PHONE_CONTENT}; token ${COLLIDING_UUID}` }],
        metadata: { echo: COLLIDING_UUID },
        referenceTaskIds: [COLLIDING_UUID, childSessionId],
      },
    });
    expect(created).toMatchObject({ ok: true, created: true });
    if (!created.ok) throw new Error("Task creation rejected structural UUID");
    const expectedTask = {
      id: childSessionId,
      contextId: COLLIDING_UUID,
      history: [{
        messageId: COLLIDING_UUID,
        taskId: childSessionId,
        contextId: COLLIDING_UUID,
        parts: [{ text: expect.stringContaining("****") }],
        referenceTaskIds: [COLLIDING_UUID, childSessionId],
      }],
    };
    expect(created.record.task).toMatchObject(expectedTask);
    const content = created.record.task.history![0]!.parts[0]!.text;
    expect(content).not.toContain("010123456789");
    expect(content).not.toContain("010-1234-5678");
    expect(content).not.toContain("212-555-1234");
    expect(content).not.toContain(COLLIDING_UUID);
    expect(created.record.task.history![0]!.metadata?.echo).not.toBe(COLLIDING_UUID);
    expect(created.record.task.history![0]!.metadata?.echo).toContain("****");
    await expect(store.get("profile-a", childSessionId)).resolves.toMatchObject({ task: expectedTask });
    const reloaded = new A2ATaskStore(options);
    await expect(reloaded.get("profile-a", childSessionId)).resolves.toMatchObject({ task: expectedTask });
    await expect(reloaded.findByMessageId("profile-a", COLLIDING_UUID)).resolves.toMatchObject({ task: expectedTask });
    expect(persisted).toMatchObject({ records: [{ childSessionId, task: expectedTask }] });
  });

  it.each([
    `custom-010123456789-${COLLIDING_UUID}`,
    `sub-010123456789-${COLLIDING_UUID}`,
    `a2a-wire-010123456789-${COLLIDING_UUID}`,
    `sub-abcdefab-${COLLIDING_UUID}-010123456789`,
  ])("rejects phone-bearing custom identifiers outside complete host shapes: %s", (id) => {
    expect(isSafeStructuralId(id)).toBe(false);
    expect(isSafeA2AStructuralId(id)).toBe(false);
    expect(isSafeA2AMessageId(id)).toBe(false);
    expect(canonicalizeInboundA2ASubAgentMessage({
      messageId: id,
      role: A2ARole.USER,
      parts: [{ text: "hello" }],
    })).toEqual({ ok: false, reason: "invalid-message" });
    expect(canonicalizeA2ARemoteTask({
      id,
      contextId: COLLIDING_UUID,
      status: { state: A2ATaskState.SUBMITTED },
    })).toBeNull();
  });
});
