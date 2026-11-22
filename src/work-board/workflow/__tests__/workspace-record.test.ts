import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { registeredIn } from "../workspace-record.js";

const asked = vi.hoisted(() => [] as string[]);

vi.mock("../owned-fs.js", async (original) => ({
  ...await original<typeof import("../owned-fs.js")>(),
  // Every directory answers as the run folder, so only the path's own form can refuse it.
  realDirId: (path: string) => { asked.push(path); return "1:1"; },
}));

beforeEach(() => { asked.length = 0; });

it("a registration on a local path is looked up on disk", () => {
  expect(registeredIn("1:1", "_join", resolve("/run", "_join", ".git"))).toBe(true);
  expect(asked).toEqual([resolve("/run")]);
});

it("a registration on a network or device path names nothing, and nothing is asked of that path", () => {
  for (const gitdir of [String.raw`\\server\share\run\_join\.git`, "//server/share/run/_join/.git", String.raw`\\?\C:\run\_join\.git`, String.raw`\\.\C:\run\_join\.git`, String.raw`\\?\UNC\server\share\run\_join\.git`]) {
    expect(registeredIn("1:1", "_join", gitdir), gitdir).toBe(false);
  }
  expect(asked).toEqual([]);
});
