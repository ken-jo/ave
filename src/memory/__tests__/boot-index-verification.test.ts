import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../memory-manager.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

describe("MemoryManager boot index verification", () => {
  let aveDir: string;

  beforeEach(async () => {
    aveDir = await mkdtemp(join(tmpdir(), "ave-memory-boot-index-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(aveDir);
  });

  it("does not enumerate session JSONL files when the index is healthy and populated", async () => {
    const manager = new MemoryManager({ aveDir });
    const close = vi.fn();
    const internals = manager as unknown as {
      searchIndex: {
        open(): boolean;
        rowCount(): number;
        close(): void;
      };
      listSessionJsonlFiles(): string[];
    };
    internals.searchIndex = {
      open: vi.fn(() => true),
      rowCount: vi.fn(() => 3),
      close,
    };
    const listSessionJsonlFiles = vi.fn(() => {
      throw new Error("healthy index must not scan the sessions directory");
    });
    internals.listSessionJsonlFiles = listSessionJsonlFiles;

    await expect(manager.verifyOrRebuildSearchIndex()).resolves.toBeUndefined();

    expect(listSessionJsonlFiles).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
