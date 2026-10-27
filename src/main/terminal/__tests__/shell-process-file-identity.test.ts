import { describe, expect, it, vi } from "vitest";
import { readSandboxedShell } from "../shell-process.js";

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readdir: async () => ["10", "11", "12"],
  readlink: async () => "/work",
  stat: statMock,
  readFile: async (path: string) => {
    if (path === "/proc/12/status") return "NSpid:\t12\t2\n";
    // Full rows as /proc reports them, through the start time (field 22).
    const rows: Record<string, string> = {
      "/proc/10/stat": "10 (bwrap) S 1 10 10 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 110 0 0",
      "/proc/11/stat": "11 (script) S 10 11 11 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 111 0 0",
      "/proc/12/stat": "12 (zsh) S 11 12 12 34816 12 4194560 0 0 0 0 0 0 0 0 20 0 1 0 112 0 0",
    };
    const row = rows[path];
    if (!row) throw new Error("Unexpected process path");
    return row;
  },
}));

const LARGE_ID = 2n ** 60n;

describe("sandboxed shell directory identity", () => {
  it.each([
    { name: "equal identifiers", dev: LARGE_ID, ino: LARGE_ID, matches: true },
    { name: "inodes differing beyond number precision", dev: LARGE_ID, ino: LARGE_ID + 1n, matches: false },
    { name: "devices differing beyond number precision", dev: LARGE_ID + 1n, ino: LARGE_ID, matches: false },
  ])("compares $name exactly", async ({ dev, ino, matches }) => {
    statMock.mockReset().mockImplementation(async (path: string, options: unknown) => {
      expect(options).toEqual({ bigint: true });
      return {
        dev: path === "/work" ? dev : LARGE_ID,
        ino: path === "/work" ? ino : LARGE_ID,
        isDirectory: () => true,
      };
    });

    const reading = await readSandboxedShell(10, "zsh", "/work");
    expect(reading).toMatchObject({ ok: true, shell: { cwdIsReported: matches } });
    expect(statMock).toHaveBeenCalledTimes(2);
  });
});
