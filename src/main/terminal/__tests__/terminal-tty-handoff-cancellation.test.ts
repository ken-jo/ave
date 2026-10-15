import { expect, it, vi } from "vitest";
import { constants, openSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createTerminalTtyHandoff } from "../terminal-tty-handoff.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  open: vi.fn(),
}));

it.runIf(process.platform !== "win32")("unblocks the FIFO synchronously on abort before disposal and closes a late handle once", async () => {
  let resolveOpen!: (handle: FileHandle) => void;
  const opening = new Promise<FileHandle>((resolve) => { resolveOpen = resolve; });
  vi.mocked(open).mockReturnValueOnce(opening);
  const writeFile = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const handle = { writeFile, close } as unknown as FileHandle;
  const handoff = await createTerminalTtyHandoff();
  const gone = new AbortController();
  const delivering = handoff.deliver("exec true\n", { signal: gone.signal });
  try {
    gone.abort();
    // Cancellation disposes the handoff in the same turn as abort. The
    // pending open must be unblocked while its FIFO still has a pathname.
    const unblockedAtAbort = vi.mocked(openSync).mock.calls.some(([file, flags]) =>
      file === handoff.trampoline.args[0] && flags === (constants.O_RDONLY | constants.O_NONBLOCK),
    );
    handoff.dispose();
    resolveOpen(handle);
    await expect(delivering).rejects.toThrow(/exited before taking its command/);
    expect(unblockedAtAbort).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    resolveOpen(handle);
    await delivering.catch(() => {});
    handoff.dispose();
  }
});
