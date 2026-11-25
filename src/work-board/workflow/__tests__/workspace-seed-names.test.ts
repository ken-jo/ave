import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listSeedFiles } from "../workspace-seed.js";

/** A folder whose listing also holds a name of bytes that are no text, as a POSIX disk can: read as text, it comes out as another. */
const odd = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const readdir = (async (path: string, options?: { encoding?: string }) => {
    const names = await real.readdir(path, { encoding: "buffer" });
    if (odd.dir !== undefined && path === odd.dir) names.push(Buffer.from([0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74]));
    return options?.encoding === "buffer" ? names : names.map(name => name.toString("utf8"));
  }) as typeof real.readdir;
  return { ...real, readdir };
});

let root: string;
const rules = { sensitive: () => false };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sws-"));
  writeFileSync(join(root, "a.txt"), "a\n");
  // A real name that holds the replacement character is text, and is listed.
  writeFileSync(join(root, "n�.txt"), "n\n");
});

afterEach(() => {
  odd.dir = undefined;
  rmSync(root, { recursive: true, force: true });
});

it("a folder's names are listed as the text they are", async () => {
  expect(await listSeedFiles(root, ["**"], rules)).toMatchObject({ ok: true, files: [{ path: "a.txt" }, { path: "n�.txt" }] });
});

it("a name whose bytes are no text refuses the listing, and is not taken for the name it would be read as", async () => {
  odd.dir = root;
  expect(await listSeedFiles(root, ["**"], rules)).toEqual({ ok: false, code: "seed-unreadable" });
});

it("names and the text that tells a run's registration and record apart are read from their bytes exactly, wherever the workspaces read them", () => {
  const source = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
  const seed = source("workspace-seed.ts");
  expect(seed.match(/\breaddir\(/gu)?.length).toBe(seed.match(/\breaddir\([^)]*\{ encoding: "buffer" \}\)/gu)?.length);
  const workspaces = source("stage-workspaces.ts");
  expect(workspaces).not.toMatch(/readFile\([^)]*\)\??\.toString\(/u);
  expect(workspaces).not.toMatch(/\.trimEnd\(\)/u);
});
