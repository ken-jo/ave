import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  disposeSessionFileReads,
  hashAndCountLines,
  lookupFileRead,
  recordFileRead,
  sha256Hex,
} from "../file-read-state.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-file-read-state-"));
});

afterEach(async () => {
  await cleanupTmpDir(directory);
});

describe("file read state", () => {
  it.each([
    ["an empty file", "", 0],
    ["LF lines with a final newline", "a\nb\n", 2],
    ["LF lines without a final newline", "a\nb", 2],
    ["CRLF lines", "a\r\nb\r\n", 2],
    ["lone CR lines", "a\rb\rc", 3],
    ["an empty line between lines", "a\n\nb\n", 3],
    ["a CRLF split across stream chunks", `${"a".repeat(65_535)}\r\nb`, 2],
  ])("counts %s like the line-window reader", async (_label, content, lines) => {
    const path = join(directory, "file.txt");
    writeFileSync(path, content);
    await expect(hashAndCountLines(path)).resolves.toEqual({
      sha256: sha256Hex(Buffer.from(content)),
      lineCount: lines,
      size: Buffer.byteLength(content),
    });
  });

  it("keeps records per session and drops them when the session is disposed", () => {
    const record = { mtimeMs: 1, size: 2, sha256: "abc" };
    recordFileRead("session-a", "/w/file.txt", record);
    expect(lookupFileRead("session-a", "/w/file.txt")).toEqual(record);
    expect(lookupFileRead("session-b", "/w/file.txt")).toBeUndefined();
    disposeSessionFileReads("session-a");
    expect(lookupFileRead("session-a", "/w/file.txt")).toBeUndefined();
  });

  it("evicts the least recently used session beyond the bound", () => {
    const record = { mtimeMs: 1, size: 2, sha256: "abc" };
    recordFileRead("oldest", "/w/file.txt", record);
    for (let index = 0; index < 64; index += 1) {
      recordFileRead(`session-${index}`, "/w/file.txt", record);
    }
    expect(lookupFileRead("oldest", "/w/file.txt")).toBeUndefined();
    expect(lookupFileRead("session-63", "/w/file.txt")).toEqual(record);
  });
});
