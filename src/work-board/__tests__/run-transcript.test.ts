/** Persist each run independently and append without overwriting earlier runs; fresh readers must recover all events. */
import { describe, it, expect } from "vitest";
import {
  createRunTranscript,
  readRunTranscript,
  runTranscriptPath,
} from "../run-transcript.js";
import { memTranscriptStorage } from "./board-test-fixtures.js";

const NOW = Date.parse("2026-06-16T00:00:00.000Z");

describe("run-transcript", () => {
  it("accumulates appended events into one JSONL file", async () => {
    const storage = memTranscriptStorage();
    const t = createRunTranscript(storage, 1, "run-A", () => NOW);

    await t.append({ phase: "planning", kind: "turn", turn: 1, text: "investigating" });
    await t.append({ phase: "awaiting_approval", kind: "plan", text: "the plan" });
    await t.append({ phase: "executing", kind: "turn", turn: 1, text: "doing work" });
    await t.append({ phase: "done", kind: "output", text: "the result" });

    const events = await readRunTranscript(storage, 1, "run-A");
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.kind)).toEqual(["turn", "plan", "turn", "output"]);
    expect(events[1]).toMatchObject({ kind: "plan", text: "the plan" });
    expect(events[0].ts).toBe(new Date(NOW).toISOString());
  });

  it("survives a restart — a fresh reader sees all prior appends", async () => {
    const storage = memTranscriptStorage();
    await createRunTranscript(storage, 7, "run-X", () => NOW).append({
      phase: "planning",
      kind: "turn",
      turn: 1,
      text: "before restart",
    });

    const after = await readRunTranscript(storage, 7, "run-X");
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe("before restart");
  });

  it("keeps re-runs in separate files (prior run never overwritten)", async () => {
    const storage = memTranscriptStorage();
    await createRunTranscript(storage, 1, "run-1", () => NOW).append({ phase: "done", kind: "output", text: "first" });
    await createRunTranscript(storage, 1, "run-2", () => NOW).append({ phase: "done", kind: "output", text: "second" });

    expect(storage.files[runTranscriptPath(1, "run-1")]).toContain("first");
    expect(storage.files[runTranscriptPath(1, "run-2")]).toContain("second");
    expect((await readRunTranscript(storage, 1, "run-1"))[0].text).toBe("first");
    expect((await readRunTranscript(storage, 1, "run-2"))[0].text).toBe("second");
  });

  it("rejects a traversal-bearing runId (path-escape guard)", async () => {
    const storage = memTranscriptStorage();
    storage.files["../secret.jsonl"] = JSON.stringify({ ts: "x", phase: "done", kind: "output", text: "leak" }) + "\n";
    expect(await readRunTranscript(storage, 1, "../../secret")).toEqual([]);
    expect(await readRunTranscript(storage, 1, "..")).toEqual([]);
  });

  it("returns [] for a missing transcript and skips a torn final line", async () => {
    const storage = memTranscriptStorage();
    expect(await readRunTranscript(storage, 99, "nope")).toEqual([]);

    storage.files[runTranscriptPath(1, "torn")] =
      JSON.stringify({ ts: "x", phase: "done", kind: "output", text: "ok" }) + "\n{ partial";
    const events = await readRunTranscript(storage, 1, "torn");
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("ok");
  });
});
