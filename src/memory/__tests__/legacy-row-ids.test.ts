// Independent legacy-session readers must derive identical row ids before anything writes them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "bbbbbbbb-1111-2222-3333-555555555555";

let dir: string;
let mm: MemoryManager;

function writeRawSession(rows: readonly unknown[]): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "sessions", `${SESSION}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

// Derive collision candidates independently so the test pins the formula instead of importing its result.
function derivedRowId(index: number, step: number): string {
  const digest = createHash("sha256")
    .update(`${SESSION}:${index}:${step}`)
    .digest("hex")
    .slice(0, 32);
  return `row-${digest}`;
}

function idsOf(messages: unknown[] | null): string[] {
  return (messages ?? []).map((row) => (row as { meta?: { messageId?: string } }).meta?.messageId ?? "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-legacy-row-ids-"));
  mm = new MemoryManager({ aveDir: dir });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("loadSession — legacy row identity", () => {
  it("gives an id-less row an id, and the same one on a second read", () => {
    writeRawSession([
      { role: "user", content: "no id here" },
      { role: "assistant", content: "nor here" },
    ]);

    const first = idsOf(mm.loadSession(SESSION));
    expect(first.every((id) => id.startsWith("row-"))).toBe(true);
    expect(new Set(first).size).toBe(2);
    expect(idsOf(mm.loadSession(SESSION))).toEqual(first);
  });

  it("re-mints the second of two rows claiming one id, and leaves the first alone", () => {
    // Duplicate persisted ids make id lookup ambiguous and must be reminted.
    writeRawSession([
      { role: "user", content: "original", meta: { messageId: "row-collision" } },
      { role: "assistant", content: "impostor", meta: { messageId: "row-collision" } },
      { role: "user", content: "no id at all" },
    ]);

    const ids = idsOf(mm.loadSession(SESSION));
    expect(ids[0]).toBe("row-collision");
    expect(ids[1]).not.toBe("row-collision");
    expect(ids[1]).toMatch(/^row-[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(3);
    expect(idsOf(mm.loadSession(SESSION))).toEqual(ids);
  });

  it("lets a stored id win over a derived one that wants the same name", () => {
    // Reserve later stored ids before deriving earlier ones so synthetic identity cannot displace durable evidence.
    writeRawSession([
      { role: "user", content: "no id" },
      { role: "assistant", content: "b" },
    ]);
    const derivedForRowZero = idsOf(mm.loadSession(SESSION))[0];

    writeRawSession([
      { role: "user", content: "no id" },
      { role: "assistant", content: "owns it", meta: { messageId: derivedForRowZero } },
    ]);
    const ids = idsOf(mm.loadSession(SESSION));

    expect(ids[1]).toBe(derivedForRowZero);
    expect(ids[0]).not.toBe(derivedForRowZero);
    expect(new Set(ids).size).toBe(2);
  });

  it("opens a session even when stored ids squat on a row's whole retry run", () => {
    // Collision retries must not spend the independent DLP-rejection budget or block session loading.
    const squatters = Array.from({ length: 8 }, (_, step) => derivedRowId(8, step));
    expect(new Set(squatters).size).toBe(8);

    writeRawSession([
      ...squatters.map((messageId, n) => ({ role: "user", content: `squatter ${n}`, meta: { messageId } })),
      { role: "assistant", content: "the row that has to move" },
    ]);

    const ids = idsOf(mm.loadSession(SESSION));
    expect(ids).toHaveLength(9);
    expect(ids.slice(0, 8)).toEqual(squatters);
    expect(ids[8]).toBe(derivedRowId(8, 8));
    expect(new Set(ids).size).toBe(9);
  });

  it("leaves a session whose rows already have distinct ids untouched", () => {
    writeRawSession([
      { role: "user", content: "a", meta: { messageId: "row-aaa" } },
      { role: "assistant", content: "b", meta: { messageId: "row-bbb" } },
    ]);

    expect(idsOf(mm.loadSession(SESSION))).toEqual(["row-aaa", "row-bbb"]);
  });
});
