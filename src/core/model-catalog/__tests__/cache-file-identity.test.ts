import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { readRegularFile } from "../cache.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: vi.fn(),
  open: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

it("refuses a cache file whose opened identity differs beyond number precision", async () => {
  const entry = statSync(fileURLToPath(import.meta.url), { bigint: true });
  const before = Object.assign(Object.create(entry), { ino: 2n ** 60n });
  const opened = Object.assign(Object.create(entry), { ino: 2n ** 60n + 1n });
  const close = vi.fn(async () => {});
  const read = vi.fn();
  const stat = vi.fn(async () => opened);
  vi.mocked(fs.lstat).mockResolvedValue(before);
  vi.mocked(fs.open).mockResolvedValue({ stat, close, read } as unknown as fs.FileHandle);

  await expect(readRegularFile("catalog.json", 1024)).rejects.toThrow("file changed while opening");
  expect(fs.lstat).toHaveBeenCalledWith("catalog.json", { bigint: true });
  expect(stat).toHaveBeenCalledWith({ bigint: true });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
