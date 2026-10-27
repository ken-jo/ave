import { appendFileSync, linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentJournalReader } from "../journal-reader.js";
import type { DocumentEditJournalRecord } from "../../shared/document-edit-journal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ave-observation-journal-"));
  roots.push(home);
  mkdirSync(join(home, "document-observation"));
  return { home, path: join(home, "document-observation", "journal.jsonl") };
}
const begin = { v: 1, kind: "begin", editId: "edit-1", target: "/workspace/book.xlsx", beforeHash: "a".repeat(64) } as const;

describe("bounded action journal tail", () => {
  it("retains a partial final line and emits it only after the newline", () => {
    const { home, path } = fixture();
    const records: DocumentEditJournalRecord[] = [];
    const reader = new DocumentJournalReader(home, (record) => records.push(record));
    writeFileSync(path, JSON.stringify(begin));
    reader.poll();
    expect(records).toEqual([]);
    appendFileSync(path, "\n");
    reader.poll();
    expect(records).toEqual([begin]);
    reader.dispose();
  });

  it("rejects a replaced or truncated journal rather than following its new contents", () => {
    const { home, path } = fixture();
    const reader = new DocumentJournalReader(home, () => undefined);
    writeFileSync(path, `${JSON.stringify(begin)}\n`);
    reader.poll();
    writeFileSync(path, "");
    expect(() => reader.poll()).toThrow("Invalid document journal identity or size.");
    writeFileSync(`${path}.replacement`, `${JSON.stringify(begin)}\n`);
    renameSync(`${path}.replacement`, path);
    expect(() => reader.poll()).toThrow("Invalid document journal identity or size.");
  });

  it("refuses malformed lines and an oversized unterminated line", () => {
    const malformed = fixture();
    writeFileSync(malformed.path, "{broken}\n");
    expect(() => new DocumentJournalReader(malformed.home, () => undefined).poll()).toThrow("Invalid document journal record.");
    const oversized = fixture();
    writeFileSync(oversized.path, "x".repeat(16_385));
    expect(() => new DocumentJournalReader(oversized.home, () => undefined).poll()).toThrow("Document journal line limit exceeded.");
  });

  it("refuses a journal exceeding the invocation cap before reading any records", () => {
    const { home, path } = fixture();
    writeFileSync(path, Buffer.alloc(2_097_153));
    expect(() => new DocumentJournalReader(home, () => undefined).poll()).toThrow("Invalid document journal identity or size.");
  });

  it("refuses a linked journal that escapes the action directory", () => {
    const { home, path } = fixture();
    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify(begin)}\n`);
    linkSync(outside, path);
    expect(() => new DocumentJournalReader(home, () => undefined).poll()).toThrow("Invalid document journal identity or size.");
    expect(readFileSync(outside, "utf8")).toBe(`${JSON.stringify(begin)}\n`);
  });

  it("refuses a substituted action subdirectory", () => {
    const { home, path } = fixture();
    const reader = new DocumentJournalReader(home, () => undefined);
    const directory = join(home, "document-observation");
    renameSync(directory, `${directory}.old`);
    mkdirSync(directory);
    writeFileSync(path, `${JSON.stringify(begin)}\n`);
    expect(() => reader.poll()).toThrow("Invalid document journal action directory.");
  });

  it("refuses a truncation above the consumed offset after a bounded partial read", () => {
    const { home, path } = fixture();
    const bytes = Buffer.from(`${JSON.stringify(begin)}\n`.repeat(1_200));
    writeFileSync(path, bytes);
    const reader = new DocumentJournalReader(home, () => undefined);
    expect(reader.poll()).toBe(true);
    writeFileSync(path, bytes.subarray(0, 83_000));
    expect(() => reader.poll()).toThrow("Invalid document journal identity or size.");
  });
});
