// windows-native: retargets a real junction across the file-open boundary.
// read_file text must come from the file its judged path names. These tests change the filesystem around the open that
// reads the text, so they hook both ways a file is opened for reading and keep the hooks out of the real-filesystem suite.
import {
  constants, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
  type ReadStream,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `swap` runs just before the open that reads the text and `restore` once that open is done; `keep` leaves the swap in
 * place until the test ends. The open never gets the flag that refuses a link in the last name, as on Windows. */
const hook = vi.hoisted(() => ({
  target: "",
  around: undefined as { swap: () => void; restore: () => void; keep: boolean } | undefined,
}));

function takeHook(): { swap: () => void; restore: () => void; keep: boolean } | undefined {
  const around = hook.around;
  hook.around = undefined;
  return around;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // A text stream opened by name (an encoding and no handle) reads the text.
  const createReadStream = ((path: string, options?: { encoding?: string; fd?: unknown }) => {
    const around = typeof path === "string" && path === hook.target && options?.encoding === "utf8" && options.fd === undefined
      ? takeHook() : undefined;
    around?.swap();
    const stream = actual.createReadStream(path, options as never) as ReadStream;
    if (around && !around.keep) {
      stream.once("open", around.restore);
      stream.once("error", around.restore);
    }
    return stream;
  }) as typeof actual.createReadStream;
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // A handle opened on the file reads the text through it.
  const open = (async (path: string, flags?: unknown, ...rest: unknown[]) => {
    const around = path === hook.target ? takeHook() : undefined;
    around?.swap();
    try {
      const opening = typeof flags === "number" ? flags & ~(constants.O_NOFOLLOW ?? 0) : flags;
      return await (actual.open as (path: string, ...rest: unknown[]) => Promise<FileHandle>)(path, opening, ...rest);
    } finally {
      if (around && !around.keep) around.restore();
    }
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

const { ReadFileTool } = await import("../file-tools.js");

let base: string;
let folder: string;
let elsewhere: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-read-binding-")));
  folder = join(base, "project", "notes");
  elsewhere = join(base, "elsewhere", "secrets");
  file = join(folder, "todo.txt");
  mkdirSync(folder, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(file, "buy milk\n");
  writeFileSync(join(elsewhere, "todo.txt"), "API_TOKEN=PROTECTED\n");
  hook.target = file;
  hook.around = undefined;
});

afterEach(() => {
  hook.around = undefined;
  rmSync(base, { recursive: true, force: true });
});

const linkFolder = (): void => {
  renameSync(folder, `${folder}.orig`);
  symlinkSync(elsewhere, folder, "junction");
};
const restoreFolder = (): void => {
  unlinkSync(folder);
  renameSync(`${folder}.orig`, folder);
};
// A second name for the protected file stands in for a link the open follows.
const linkLastName = (): void => {
  renameSync(file, `${file}.orig`);
  linkSync(join(elsewhere, "todo.txt"), file);
};
const restoreLastName = (): void => {
  unlinkSync(file);
  renameSync(`${file}.orig`, file);
};

async function readTodo() {
  return new ReadFileTool().execute({ path: "notes/todo.txt" },
    { cwd: join(base, "project"), extraAllowedDirectories: [], metadata: {} });
}

describe("read_file binds its text to the judged path", () => {
  it.each([
    ["a folder", linkFolder, restoreFolder],
    ["the last name", linkLastName, restoreLastName],
  ])("refuses text read through %s that led elsewhere only while the file was opened", async (_label, swap, restore) => {
    hook.around = { swap, restore, keep: false };
    const result = await readTodo();
    expect(hook.around).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.output).toContain("changed while it was read");
    expect(result.output).not.toContain("PROTECTED");
  });

  it("refuses text read through a folder that still leads elsewhere after the read", async () => {
    hook.around = { swap: linkFolder, restore: () => {}, keep: true };
    try {
      const result = await readTodo();
      expect(hook.around).toBeUndefined();
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain("PROTECTED");
    } finally {
      restoreFolder();
    }
  });

  it("reads the file when nothing changes, through a linked folder too", async () => {
    symlinkSync(folder, join(base, "project", "alias"), "junction");
    const direct = await readTodo();
    expect(direct.isError, direct.output).toBe(false);
    expect(direct.output).toContain("buy milk");
    const linked = await new ReadFileTool().execute({ path: "alias/todo.txt" },
      { cwd: join(base, "project"), extraAllowedDirectories: [], metadata: {} });
    expect(linked.isError, linked.output).toBe(false);
    expect(linked.output).toContain("buy milk");
  });
});
