import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { MemoryManager, type SessionMetadata } from "../memory-manager.js";

const COLLIDING_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-010123456789";
const CHILD_ID = `sub-abcdefab-${COLLIDING_UUID}`;
const ORIGIN_ID = `a2a-wire-abcdefab-${COLLIDING_UUID}`;
let directory: string;
let memory: MemoryManager;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-a2a-uuid-metadata-"));
  memory = new MemoryManager({ aveDir: directory });
});

afterEach(async () => {
  memory.closeSearchIndex();
  await cleanupTmpDir(directory);
});

describe("A2A structural UUID metadata", () => {
  function metadata(): SessionMetadata {
    return {
      sessionKind: "subagent",
      projectRoot: directory,
      sourceTools: [],
      originSessionId: ORIGIN_ID,
      a2aWireHandlerId: "agent-handler",
      a2aWireInternalOrigin: ORIGIN_ID,
      subAgentTaskState: "TASK_STATE_SUBMITTED",
    };
  }

  it("writes and reloads phone-colliding child and internal-origin UUIDs", async () => {
    await memory.saveSessionMetadata(CHILD_ID, metadata());
    expect(memory.loadSessionMetadata(CHILD_ID)).toMatchObject(metadata());
    const reloaded = new MemoryManager({ aveDir: directory });
    try {
      expect(reloaded.loadSessionMetadata(CHILD_ID)).toMatchObject(metadata());
    } finally {
      reloaded.closeSearchIndex();
    }
  });

  it("retains rejection for phone-bearing handler names and invalid origin shapes", async () => {
    await expect(memory.saveSessionMetadata(CHILD_ID, {
      ...metadata(),
      a2aWireHandlerId: "agent-010123456789",
    })).rejects.toThrow("a2a-wire-binding-invalid");
    await expect(memory.saveSessionMetadata(CHILD_ID, {
      ...metadata(),
      originSessionId: `custom-${COLLIDING_UUID}`,
      a2aWireInternalOrigin: `custom-${COLLIDING_UUID}`,
    })).rejects.toThrow("a2a-wire-binding-invalid");
  });
});
