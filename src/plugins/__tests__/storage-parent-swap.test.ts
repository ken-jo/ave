/**
 * Regression: a confined plugin re-pointing a parent component of a storage
 * path between the host's containment check and the operation's syscall.
 *
 * The HostApi `storage` surface used to operate in the plugin's `data/` — the
 * directory its confined child writes. Every storage op checks containment
 * (realpath + lstat) and then issues a path-based syscall, so the child could
 * rename `data/sub` aside and put a link to an outside directory in its place
 * inside that window, and the host's syscall followed it: all eleven ops at
 * depth 2 read, wrote, listed, created or deleted outside the plugin's root.
 * No platform offers a path-based "never follow any component" for every op
 * (macOS `O_NOFOLLOW_ANY` covers `open` only; Windows has nothing).
 *
 * The fix moves the surface to the host-only `storage/` beside `data/`, which
 * is in no confined child's write envelope (pinned per platform by the
 * envelope tests). So the swap the child CAN still make — in `data/` — is
 * made here, at the same moment as before, and every op must now land in
 * `storage/` with the outside directory untouched. Against the old layout
 * this file fails all eleven cases.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** The child's move, fired at the first storage syscall under the plugin root. */
const swap = vi.hoisted(() => ({
  armed: false,
  pluginRoot: "",
  childSub: "",
  outside: "",
  fired: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const fs = await import("node:fs");
  const maybeSwap = (op: string, path: unknown): void => {
    if (!swap.armed || typeof path !== "string" || !path.startsWith(swap.pluginRoot + sep)) return;
    swap.armed = false;
    swap.fired.push(op);
    fs.renameSync(swap.childSub, `${swap.childSub}-moved`);
    fs.symlinkSync(swap.outside, swap.childSub, process.platform === "win32" ? "junction" : "dir");
  };
  const wrap = <K extends keyof typeof real>(key: K): (typeof real)[K] =>
    (async (...args: unknown[]) => {
      maybeSwap(String(key), args[0]);
      return (real[key] as (...a: unknown[]) => unknown)(...args);
    }) as unknown as (typeof real)[K];
  return {
    ...real,
    readFile: wrap("readFile"),
    writeFile: wrap("writeFile"),
    mkdir: wrap("mkdir"),
    readdir: wrap("readdir"),
    rm: wrap("rm"),
    stat: wrap("stat"),
    rename: wrap("rename"),
    open: wrap("open"),
  };
});
vi.mock("electron", () => ({}));

import { createNoopHostApi } from "../runtime/sandbox.js";
import type { PluginStorage } from "../types.js";
import { removeLinkOnly } from "../../__tests__/support/tmp-dir-teardown.js";

const encryption = {
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`ENC(${value})`),
  decryptString: (bytes: Buffer) => /^ENC\(([\s\S]*)\)$/.exec(String(bytes))![1]!,
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "ave-storage-parent-swap-")));
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Seed `dir` with the files every op touches, each tagged with where it lives. */
function seed(dir: string, tag: string): void {
  mkdirSync(join(dir, "tree"), { recursive: true });
  writeFileSync(join(dir, "f.txt"), tag);
  writeFileSync(join(dir, "j.json"), JSON.stringify({ tag }));
  writeFileSync(join(dir, "victim"), tag);
  writeFileSync(join(dir, "tree", `t-${tag}`), tag);
  writeFileSync(join(dir, "e.enc"), `ENC(${tag})`);
}

interface Case {
  readonly storage: PluginStorage;
  readonly outside: string;
  readonly storageSub: string;
  readonly childSub: string;
}

function fresh(): Case {
  const root = mkdtempSync(join(base, "c-"));
  const pluginRoot = join(root, "plugins", "acme");
  const dataDir = join(pluginRoot, "data");
  const storageDir = join(pluginRoot, "storage");
  const outside = join(root, "outside");
  // What the child writes, what the host stores for it, and what neither owns.
  seed(join(dataDir, "sub"), "child");
  seed(join(storageDir, "sub"), "inside");
  seed(outside, "OUTSIDE");
  writeFileSync(join(outside, "only-outside"), "x");
  Object.assign(swap, { armed: true, pluginRoot, childSub: join(dataDir, "sub"), outside, fired: [] });
  return {
    storage: createNoopHostApi("acme", dataDir, encryption).storage,
    outside,
    storageSub: join(storageDir, "sub"),
    childSub: join(dataDir, "sub"),
  };
}

const OUTSIDE_LISTING = ["only-outside", "e.enc", "f.txt", "j.json", "tree", "victim"].sort();

const ops: ReadonlyArray<readonly [string, (s: PluginStorage) => Promise<unknown>, (c: Case, result: unknown) => void]> = [
  ["read", (s) => s.read("sub/f.txt"), (_c, r) => expect(Buffer.from(r as Uint8Array).toString()).toBe("inside")],
  ["readJson", (s) => s.readJson("sub/j.json"), (_c, r) => expect(r).toEqual({ tag: "inside" })],
  ["write", (s) => s.write("sub/w.txt", "x"), (c) => expect(existsSync(join(c.storageSub, "w.txt"))).toBe(true)],
  ["writeJson", (s) => s.writeJson("sub/wj.json", { a: 1 }), (c) => expect(existsSync(join(c.storageSub, "wj.json"))).toBe(true)],
  ["mkdir", (s) => s.mkdir("sub/made/deep"), (c) => expect(existsSync(join(c.storageSub, "made", "deep"))).toBe(true)],
  ["list", (s) => s.list("sub/tree"), (_c, r) => expect(r).toEqual(["t-inside"])],
  ["exists", (s) => s.exists("sub/only-outside"), (_c, r) => expect(r).toBe(false)],
  ["rm", (s) => s.rm("sub/victim"), (c) => expect(existsSync(join(c.storageSub, "victim"))).toBe(false)],
  ["rm recursive", (s) => s.rm("sub/tree", { recursive: true }), (c) => expect(existsSync(join(c.storageSub, "tree"))).toBe(false)],
  ["writeEncrypted", (s) => s.writeEncrypted("sub/we.enc", "p"), (c) => expect(readFileSync(join(c.storageSub, "we.enc"), "utf-8")).toBe("ENC(p)")],
  ["readEncrypted", (s) => s.readEncrypted("sub/e.enc"), (_c, r) => expect(r).toBe("inside")],
];

describe("a parent the plugin re-points between the host's check and its syscall", () => {
  beforeEach(() => {
    swap.armed = false;
  });

  it.each(ops)("%s at depth 2 stays in the host-only storage root", async (_name, op, judge) => {
    const c = fresh();
    try {
      const result = await op(c.storage);

      // The child's move really happened, inside the op.
      expect(swap.fired).toHaveLength(1);
      // Nothing outside was read, written, listed, created or deleted.
      expect(readdirSync(c.outside).sort()).toEqual(OUTSIDE_LISTING);
      expect(readdirSync(join(c.outside, "tree"))).toEqual(["t-OUTSIDE"]);
      expect(readFileSync(join(c.outside, "victim"), "utf-8")).toBe("OUTSIDE");
      judge(c, result);
    } finally {
      if (existsSync(`${c.childSub}-moved`)) removeLinkOnly(c.childSub);
    }
  });
});
