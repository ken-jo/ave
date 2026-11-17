// Inject a temporary board path and clock so real user work-board files remain untouched.
import { describe, it, expect, vi } from "vitest";
import { withTz } from "../../__tests__/test-helpers.js";
import {
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore, itemDigestOf, planHashOf } from "../work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { localDateKey } from "../../shared/local-date.js";

// Lets a test fail the next board write, or every write to a path holding `failPath`; every other write goes to disk as usual.
const writeFault = vi.hoisted(() => ({ failNext: false, failPath: "" }));
vi.mock("../storage/feature-namespace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/feature-namespace.js")>();
  return {
    ...actual,
    writeFileAtomicAtPath: async (...args: Parameters<typeof actual.writeFileAtomicAtPath>) => {
      if (writeFault.failNext || (writeFault.failPath !== "" && args[0].includes(writeFault.failPath))) {
        writeFault.failNext = false;
        throw new Error("disk full");
      }
      return actual.writeFileAtomicAtPath(...args);
    },
  };
});

function tempBoard(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "ave-wb-"));
  const path = join(dir, "board.json");
  const store = new WorkBoardStore(path, now);
  const cleanup = () => cleanupTmpDir(dir);
  return { store, dir, path, cleanup };
}

// A clock pinned to a fixed instant so timestamps + overdue are deterministic.
const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");
const fixedClock = () => FIXED_NOW;

describe("WorkBoardStore — CRUD round-trip", () => {
  it("creates, lists, gets, updates, transitions, completes, reopens, and removes", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      // create
      const created = await store.create({ title: "write report", priority: "high" });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("unreachable");
      const id = created.itemId;
      expect(created.item.title).toBe("write report");
      expect(created.item.status).toBe("planned");
      expect(created.item.status_resolved).toBe("planned");
      expect(created.item.priority).toBe("high");

      // list
      const listed = await store.list();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].id).toBe(id);

      // get
      const got = await store.get(id);
      expect(got.status).toBe("found");
      if (got.status !== "found") throw new Error("unreachable");
      expect(got.item.id).toBe(id);

      // update
      const updated = await store.update(id, { detail: "Q2 summary", priority: "low" });
      expect(updated.status).toBe("updated");
      if (updated.status !== "updated") throw new Error("unreachable");
      expect(updated.item.detail).toBe("Q2 summary");
      expect(updated.item.priority).toBe("low");

      // transition (any-to-any): planned → in_progress
      const moved = await store.transition(id, "in_progress");
      expect(moved.status).toBe("transitioned");
      if (moved.status !== "transitioned") throw new Error("unreachable");
      expect(moved.to).toBe("in_progress");
      expect(moved.item.status).toBe("in_progress");
      expect(moved.item.completed_at).toBeUndefined();

      // complete: stamps completed_at
      const done = await store.complete(id);
      expect(done.status).toBe("completed");
      if (done.status !== "completed") throw new Error("unreachable");
      expect(done.item.status).toBe("completed");
      expect(done.item.completed_at).toBe(new Date(FIXED_NOW).toISOString());

      // reopen: clears completed_at
      const reopened = await store.reopen(id);
      expect(reopened.status).toBe("reopened");
      if (reopened.status !== "reopened") throw new Error("unreachable");
      expect(reopened.item.status).toBe("in_progress");
      expect(reopened.item.completed_at).toBeUndefined();

      // remove
      const removed = await store.remove(id);
      expect(removed.status).toBe("deleted");
      const afterRemove = await store.list();
      if (afterRemove.status !== "ok") throw new Error("unreachable");
      expect(afterRemove.items).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("get / update / transition / remove return not_found for an unknown id", async () => {
    const { store, cleanup } = tempBoard();
    try {
      expect((await store.get(999)).status).toBe("not_found");
      expect((await store.update(999, { title: "x" })).status).toBe("not_found");
      expect((await store.transition(999, "completed")).status).toBe("not_found");
      expect((await store.remove(999)).status).toBe("not_found");
    } finally {
      await cleanup();
    }
  });

  it("persists across a reload through a fresh store instance on the same path", async () => {
    const { path, cleanup } = tempBoard(fixedClock);
    try {
      const first = new WorkBoardStore(path, fixedClock);
      const a = await first.create({ title: "alpha" });
      const b = await first.create({ title: "beta", priority: "high" });
      if (a.status !== "created" || b.status !== "created") throw new Error("setup failed");
      await first.transition(b.itemId, "in_progress");

      // A brand-new instance reads only from disk.
      const second = new WorkBoardStore(path, fixedClock);
      const reloaded = await second.list();
      expect(reloaded.status).toBe("ok");
      if (reloaded.status !== "ok") throw new Error("unreachable");
      expect(reloaded.items).toHaveLength(2);
      const beta = reloaded.items.find((i) => i.id === b.itemId);
      expect(beta?.status).toBe("in_progress");
      expect(beta?.title).toBe("beta");
      // next id continues monotonically after a reload (no id reuse).
      const c = await second.create({ title: "gamma" });
      if (c.status !== "created") throw new Error("unreachable");
      expect(c.itemId).toBeGreaterThan(b.itemId);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — overdue projection", () => {
  it("resolves overdue only for planned|in_progress with a past due_at", async () => {
    const past = new Date(FIXED_NOW - 60_000).toISOString();
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      // planned + past due → overdue
      const planned = await store.create({ title: "p", due_at: past, status: "planned" });
      // in_progress + past due → overdue
      const inProg = await store.create({ title: "i", due_at: past, status: "in_progress" });
      // completed + past due → stays completed (never overdue)
      const doneItem = await store.create({ title: "c", due_at: past, status: "completed" });
      if (
        planned.status !== "created" ||
        inProg.status !== "created" ||
        doneItem.status !== "created"
      ) {
        throw new Error("setup failed");
      }

      expect(planned.item.status_resolved).toBe("overdue");
      expect(inProg.item.status_resolved).toBe("overdue");
      expect(doneItem.item.status_resolved).toBe("completed");

      const listed = await store.list();
      if (listed.status !== "ok") throw new Error("unreachable");
      const byId = new Map(listed.items.map((i) => [i.id, i]));
      expect(byId.get(planned.itemId)?.status_resolved).toBe("overdue");
      expect(byId.get(inProg.itemId)?.status_resolved).toBe("overdue");
      expect(byId.get(doneItem.itemId)?.status_resolved).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  it("does not resolve overdue for a future due_at", async () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const r = await store.create({ title: "future", due_at: future });
      if (r.status !== "created") throw new Error("setup failed");
      expect(r.item.status_resolved).toBe("planned");
    } finally {
      await cleanup();
    }
  });

  it("never persists the overdue projection to disk (status_resolved is read-only)", async () => {
    const past = new Date(FIXED_NOW - 60_000).toISOString();
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const r = await store.create({ title: "ghost", due_at: past });
      if (r.status !== "created") throw new Error("setup failed");
      expect(r.item.status_resolved).toBe("overdue");

      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as { items: Record<string, unknown>[] };
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].status).toBe("planned");
      expect(parsed.items[0]).not.toHaveProperty("status_resolved");
      // The literal string must not appear anywhere in the serialized file.
      expect(raw).not.toContain("status_resolved");
      expect(raw).not.toContain("overdue");
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — project scope", () => {
  it("persists project identity and filters list results by projectRoot", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const legacy = await store.create({ title: "legacy" });
      const alpha = await store.create({
        title: "alpha",
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      });
      const beta = await store.create({
        title: "beta",
        projectRoot: "C:\\workspace\\beta",
        projectName: "beta",
      });
      if (legacy.status !== "created" || alpha.status !== "created" || beta.status !== "created") {
        throw new Error("setup failed");
      }

      const alphaOnly = await store.list({ projectRoot: "c:/workspace/alpha/" });
      expect(alphaOnly.status).toBe("ok");
      if (alphaOnly.status !== "ok") throw new Error("unreachable");
      expect(alphaOnly.items.map((item) => item.title)).toEqual(["alpha"]);
      expect(alphaOnly.items[0].projectName).toBe("alpha");

      const defaultWithLegacy = await store.list({
        projectRoot: "C:\\workspace\\default",
        includeUnscoped: true,
      });
      expect(defaultWithLegacy.status).toBe("ok");
      if (defaultWithLegacy.status !== "ok") throw new Error("unreachable");
      expect(defaultWithLegacy.items.map((item) => item.title)).toEqual(["legacy"]);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — no item cap", () => {
  it("accepts create beyond the former 200-item cap", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const timestamp = new Date(FIXED_NOW).toISOString();
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          nextId: 251,
          items: Array.from({ length: 250 }, (_, index) => ({
            id: index + 1,
            title: `item-${index}`,
            status: "planned",
            priority: "medium",
            created_at: timestamp,
            updated_at: timestamp,
          })),
        }),
        "utf-8",
      );

      const created = await store.create({ title: "item 251" });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("unreachable");
      expect(created.itemId).toBe(251);

      const listed = await store.list();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(251);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — corrupt board.json recovery", () => {
  it("backs up corrupt JSON and seeds an empty board on read", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      writeFileSync(path, "{ this is not json", "utf-8");

      // First read triggers the backup-and-reset path.
      const listed = await store.list();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(0);

      // The corrupt original is preserved under a .corrupt-*-*.bak sibling.
      const backups = readdirSync(dir).filter((f) => /\.corrupt-\d+-[0-9a-f]{8}\.bak$/.test(f));
      expect(backups).toHaveLength(1);

      // The store now functions normally — a create succeeds with id 1.
      const created = await store.create({ title: "recovered" });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("unreachable");
      expect(created.itemId).toBe(1);
    } finally {
      await cleanup();
    }
  });

  for (const [how, text] of [["null", "null"], ["without an items list", '{"version":1,"nextId":9,"items":{}}'], ["a list", "[]"]] as const) {
    it(`moves a board file that is ${how} aside as corrupt JSON before a create, never writing over it`, async () => {
      const { store, dir, path, cleanup } = tempBoard();
      try {
        writeFileSync(path, text, "utf-8");
        expect(await store.create({ title: "after" })).toMatchObject({ status: "created", itemId: 1 });
        const backups = readdirSync(dir).filter((f) => /\.corrupt-\d+-[0-9a-f]{8}\.bak$/.test(f));
        expect(backups.map((f) => readFileSync(join(dir, f), "utf-8"))).toEqual([text]);
        expect(JSON.parse(readFileSync(path, "utf-8")).items.map((item: { id: number }) => item.id)).toEqual([1]);
      } finally {
        await cleanup();
      }
    });
  }

  it("keeps only the board's fields in its cache after a read that changed nothing: never what the read marked or the file bytes it kept", async () => {
    const { store, path, cleanup } = tempBoard();
    const cached = () => Object.keys((store as unknown as { cache: object }).cache).sort();
    const fields = ["items", "nextId", "unreadable", "version"];
    try {
      // Absent: the read marks the board unread.
      expect(await store.remove(1)).toEqual({ status: "not_found", itemId: 1 });
      expect(cached()).toEqual(fields);
      // A row that does not validate, spaced by hand: the read keeps the file's bytes.
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 3, items: [{ id: 2, title: 5 }] }), "utf-8");
      expect(await store.remove(1)).toEqual({ status: "not_found", itemId: 1 });
      expect(await store.removeUnreadable(9, () => true)).toEqual({ status: "not_found", itemId: 9 });
      expect(cached()).toEqual(fields);
      // Damaged and held open: the read marks it as not moved aside.
      writeFileSync(path, "{ damaged", "utf-8");
      vi.spyOn(fsPromises, "rename").mockRejectedValue(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }));
      expect(await store.remove(1)).toEqual({ status: "not_found", itemId: 1 });
      expect(cached()).toEqual(fields);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });

  it("refuses a create over a damaged board file it could not move aside, issues no id and leaves that file byte for byte as it was", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      expect(await store.create({ title: "first" })).toMatchObject({ status: "created", itemId: 1 });
      const damaged = `${readFileSync(path, "utf-8").slice(0, -5)} damaged by hand`;
      writeFileSync(path, damaged, "utf-8");
      const rename = fsPromises.rename.bind(fsPromises);
      const moves = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
        if (String(to).includes(".corrupt-")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        return rename(from, to);
      });
      const corrupt = () => readdirSync(dir).filter((f) => /\.corrupt-\d+-[0-9a-f]{8}\.bak$/.test(f));
      for (let i = 0; i < 2; i += 1) {
        expect(await store.create({ title: "second" })).toEqual({ status: "invalid", reason: "work-board-file-not-set-aside" });
        expect(readFileSync(path, "utf-8")).toBe(damaged);
        expect(corrupt()).toEqual([]);
      }
      moves.mockRestore();
      // Once the file can be moved, the next create goes on as over any damaged board, with the next id.
      expect(await store.create({ title: "third" })).toMatchObject({ status: "created", itemId: 2 });
      expect(corrupt().map((f) => readFileSync(join(dir, f), "utf-8"))).toEqual([damaged]);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });

  it("lists only the valid records, keeps the tampered ones in the file and repairs nextId", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          nextId: 1, // deliberately stale / colliding counter
          items: [
            { id: 5, title: "valid", status: "planned", priority: "medium", created_at: "x", updated_at: "x" },
            { id: 6, title: "", status: "planned", priority: "medium", created_at: "x", updated_at: "x" }, // empty title → dropped
            { id: 7, title: "bad-status", status: "weird", priority: "medium", created_at: "x", updated_at: "x" }, // invalid status → dropped
          ],
        }),
        "utf-8",
      );

      const listed = await store.list();
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].id).toBe(5);

      // nextId must be repaired to exceed every row id in the file, valid or not (7) → new id 8.
      const created = await store.create({ title: "next" });
      if (created.status !== "created") throw new Error("unreachable");
      expect(created.itemId).toBe(8);
    } finally {
      await cleanup();
    }
  });

  it("puts an unrelated row that does not validate back unchanged on every board write, and lists it by its id", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const valid = { id: 1, title: "valid", status: "planned", priority: "medium", created_at: "x", updated_at: "x" };
      const invalid = { id: 2, title: "hand-edited", status: "planned", priority: 42, created_at: "x", updated_at: "x", note: { kept: [1, "two"] } };
      const text = `${JSON.stringify({ version: 1, nextId: 3, items: [valid, invalid] }, null, 2)}\n`;
      // The row as the file holds it, at its depth in the items list.
      const rowText = JSON.stringify(invalid, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
      expect(text).toContain(rowText);
      writeFileSync(path, text, "utf-8");

      const listed = await store.list();
      expect(listed).toMatchObject({ status: "ok", unreadableRows: [{ id: 2 }] });
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items.map((item) => item.id)).toEqual([1]);
      const created = await store.create({ title: "next" });
      expect(created).toMatchObject({ status: "created", itemId: 3 });
      expect(readFileSync(path, "utf-8")).toContain(rowText);
      expect(await store.update(1, { title: "renamed" })).toMatchObject({ status: "updated" });
      expect(await store.remove(3)).toMatchObject({ status: "deleted" });
      const after = readFileSync(path, "utf-8");
      expect(after).toContain(rowText);
      expect(JSON.parse(after).items).toEqual([{ ...valid, title: "renamed", updated_at: expect.any(String) }, invalid]);
      // Written back byte for byte: no copy of the file is kept.
      expect(readdirSync(dirname(path)).filter((name) => name.includes(".invalid-rows-"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("deletes from an invalid card every entry with that id that does not validate, twins included, keeps a listed row with it, and copies the file aside first", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      const valid = (id: number, title: string) => ({ id, title, status: "planned", priority: "medium", created_at: "x", updated_at: "x" });
      const rows = [valid(1, "one"), valid(2, "a"), valid(2, "b"), valid(3, "three"), { id: 3, title: 5 }, { id: 4, title: "damaged", status: "nope" }, null];
      // Written as a board write writes it, so no read of it keeps a copy on its own.
      const text = `${JSON.stringify({ version: 1, nextId: 5, items: [rows[0], rows[3], ...rows.filter((_, i) => i !== 0 && i !== 3)] }, null, 2)}\n`;
      writeFileSync(path, text, "utf-8");
      expect(await store.removeUnreadable(1, () => true)).toEqual({ status: "not_found", itemId: 1 });
      expect(await store.removeUnreadable(4, () => false)).toEqual({ status: "not_found", itemId: 4 });
      expect(readFileSync(path, "utf-8")).toBe(text);
      expect(await store.removeUnreadable(2, () => true)).toEqual({ status: "deleted", itemId: 2 });
      expect(JSON.parse(readFileSync(path, "utf-8")).items).toEqual([rows[0], rows[3], rows[4], rows[5], null]);
      expect(await store.removeUnreadable(3, () => true)).toEqual({ status: "deleted", itemId: 3 });
      expect(JSON.parse(readFileSync(path, "utf-8")).items).toEqual([rows[0], rows[3], rows[5], null]);
      const copies = readdirSync(dir).filter((f) => f.includes(".invalid-rows-")).map((f) => readFileSync(join(dir, f), "utf-8"));
      expect(copies).toHaveLength(2);
      expect(copies).toContain(text);
      const listed = await store.list();
      expect(listed.status === "ok" && listed.unreadableRows).toEqual([{ id: 4 }, {}]);
    } finally {
      await cleanup();
    }
  });

  it("lists each row that does not validate with its id, and one without a usable id without it", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const valid = { id: 1, title: "valid", status: "planned", priority: "medium", created_at: "x", updated_at: "x" };
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 9, items: [valid, { id: 4 }, "text", { id: 0 }, { id: "5" }, null, { id: 8, title: 1 }] }), "utf-8");
      const listed = await store.list();
      expect(listed.status === "ok" && listed.unreadableRows).toEqual([{ id: 4 }, {}, {}, {}, {}, { id: 8 }]);
    } finally {
      await cleanup();
    }
  });

  it("lists no valid row whose id another valid row has too and keeps them all on a write; a valid row with an invalid twin is listed", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const valid = (id: number, title: string) => ({ id, title, status: "planned", priority: "medium", created_at: "x", updated_at: "x" });
      const rows = [valid(1, "one"), valid(2, "a"), valid(2, "b"), valid(3, "three"), { id: 3, title: 5 }];
      writeFileSync(path, JSON.stringify({ version: 1, nextId: 4, items: rows }), "utf-8");
      const listed = await store.list();
      expect(listed.status === "ok" && listed.items.map((item) => item.id)).toEqual([3, 1]);
      expect(listed.status === "ok" && listed.unreadableRows).toEqual([{ id: 2 }, { id: 2 }, { id: 3 }]);
      const standing = await store.runRowsOnDisk();
      expect([2, 3].map((itemId) => standing?.({ itemId, runId: "run-1" }))).toEqual(["unreadable", "unnamed"]);
      expect(await store.create({ title: "next" })).toMatchObject({ status: "created", itemId: 4 });
      expect(JSON.parse(readFileSync(path, "utf-8")).items).toEqual([rows[0], rows[3], expect.objectContaining({ id: 4 }), rows[1], rows[2], rows[4]]);
    } finally {
      await cleanup();
    }
  });

  // A row whose number is past the safe-integer limit parses to another value: the file would lose its bytes on the next write.
  const bigIntBoard = () => {
    const valid = { id: 1, title: "valid", status: "planned", priority: "medium", created_at: "x", updated_at: "x" };
    const text = `${JSON.stringify({ version: 1, nextId: 3, items: [valid, { id: 2, title: "hand-edited", size: 0 }] }, null, 2)}
`;
    return text.replace('"size": 0', '"size": 12345678901234567890');
  };

  it("keeps the file as it was beside it before a write that would change the bytes of a row that does not validate, once per content", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      const text = bigIntBoard();
      writeFileSync(path, text, "utf-8");
      for (let i = 0; i < 3; i += 1) expect(await store.create({ title: `next ${i}` })).toMatchObject({ status: "created" });
      const copies = readdirSync(dir).filter((name) => name.includes(".invalid-rows-"));
      expect(copies).toEqual([`board.json.invalid-rows-${createHash("sha256").update(text).digest("hex")}.bak`]);
      expect(readFileSync(join(dir, copies[0]))).toEqual(Buffer.from(text, "utf-8"));
      // The row itself is written back with its parsed value, after the valid rows.
      expect(JSON.parse(readFileSync(path, "utf-8")).items.at(-1)).toEqual(JSON.parse(text).items[1]);
    } finally {
      await cleanup();
    }
  });

  it("fails a write over a board whose rows that do not validate would change bytes, and writes nothing, while the copy of it cannot be made", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      const text = bigIntBoard();
      writeFileSync(path, text, "utf-8");
      await store.load();
      writeFault.failPath = ".invalid-rows-";
      await expect(store.update(1, { title: "renamed" })).rejects.toThrow("disk full");
      expect(readFileSync(path, "utf-8")).toBe(text);
      expect(readdirSync(dir).filter((name) => name.includes(".invalid-rows-"))).toEqual([]);
    } finally {
      writeFault.failPath = "";
      await cleanup();
    }
  });
});

describe("WorkBoardStore — due dates stamped in another zone", () => {
  // The end-to-end half of `work-board/__tests__/due-at-normalization.test.ts`: a `board.json` written by the old KST-anchored panel, loaded on a host
  // west of Seoul. What the picker shows is `localDateKey(due_at)`, so that is what this asserts.
  function seedBoard(path: string, dueAt: string): void {
    writeFileSync(path, JSON.stringify({
      version: 1,
      nextId: 2,
      items: [{
        id: 1,
        title: "picked the 16th",
        status: "planned",
        priority: "medium",
        created_at: "2026-06-16T01:00:00.000Z",
        updated_at: "2026-06-16T01:00:00.000Z",
        due_at: dueAt,
      }],
    }, null, 2), "utf-8");
  }

  it("shows the originally picked day on a host west of the stamped zone", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      await withTz("America/Los_Angeles", async () => {
        seedBoard(path, "2026-06-16T00:00:00+09:00");

        const listed = await store.list();
        if (listed.status !== "ok") throw new Error("unreachable");
        expect(localDateKey(new Date(listed.items[0].due_at as string))).toBe("2026-06-16");
      });
    } finally {
      await cleanup();
    }
  });

  it("leaves a due date with a real time of day exactly as stored", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      await withTz("America/Los_Angeles", async () => {
        seedBoard(path, "2026-06-16T14:30:00+09:00");

        const listed = await store.list();
        if (listed.status !== "ok") throw new Error("unreachable");
        expect(listed.items[0].due_at).toBe("2026-06-16T14:30:00+09:00");
      });
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — user-stopped runs (cancelled)", () => {
  it("persists cancelled as a terminal status, logs run-cancelled, survives reload, and is left alone by boot reconcile", async () => {
    const { store, dir, path, cleanup } = tempBoard(fixedClock);
    try {
      const created = await store.create({ title: "stopped by the user" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      await store.beginRun(id, "run-1", new Date(FIXED_NOW).toISOString());
      await store.setRunStatus(id, "executing");
      await store.setRunResult(id, { runStatus: "cancelled" });

      const activity = readFileSync(join(dir, "activity.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; to?: string });
      expect(activity.at(-1)).toMatchObject({ kind: "run-cancelled", to: "cancelled" });

      const reloaded = new WorkBoardStore(path, fixedClock);
      expect(await reloaded.reconcileInterruptedRuns()).toBe(0);
      const got = await reloaded.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("cancelled");
      expect(got.item.runHistory?.at(-1)).toMatchObject({ runId: "run-1", status: "cancelled", endedAt: expect.any(String) });
    } finally {
      await cleanup();
    }
  });
});

// Plan approval is a work approval stored on the item (permission-decision-tree.md "Work approvals"): written with the plan in one
// write, decided inside the board lock against the stored plan, and kept across restarts while it is whole.
describe("WorkBoardStore — plan approval", () => {
  async function planned(store: WorkBoardStore, title = "plan me") {
    const created = await store.create({ title, detail: "details" });
    if (created.status !== "created") throw new Error("setup failed");
    await store.beginRun(created.itemId, "run-1", new Date(FIXED_NOW).toISOString());
    const stored = await store.setPlanAwaitingApproval(created.itemId, {
      runId: "run-1", plan: "PLAN: A", runSessionId: "s", revision: 0, itemDigest: itemDigestOf(created.item),
    });
    if (stored?.status !== "updated") throw new Error("setup failed");
    return { id: created.itemId, approval: stored.item.planApproval! };
  }

  it("stores the plan and its pending decision in one write, bound to the plan and the item", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const { id, approval } = await planned(store);
      expect(approval).toMatchObject({ runId: "run-1", planHash: planHashOf("PLAN: A"), status: "pending", revision: 0 });
      const onDisk = JSON.parse(readFileSync(path, "utf-8")).items.find((i: { id: number }) => i.id === id);
      expect(onDisk.runStatus).toBe("awaiting_approval");
      expect(onDisk.planApproval.planHash).toBe(planHashOf("PLAN: A"));
      // A plan for a run the item has moved on from is not stored.
      expect(await store.setPlanAwaitingApproval(id, { runId: "run-0", plan: "OLD", runSessionId: "s", revision: 0, itemDigest: "x" })).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps a whole pending plan across a restart and turns anything less into error", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const whole = await planned(store, "whole");
      const noApproval = await planned(store, "no approval");
      const otherRun = await planned(store, "other run");
      const editedPlan = await planned(store, "edited plan");
      const board = JSON.parse(readFileSync(path, "utf-8"));
      for (const item of board.items) {
        if (item.id === noApproval.id) delete item.planApproval;
        if (item.id === otherRun.id) item.planApproval.runId = "run-x";
        if (item.id === editedPlan.id) item.plan = "PLAN: B";
      }
      writeFileSync(path, JSON.stringify(board));

      const reloaded = new WorkBoardStore(path, fixedClock);
      expect(await reloaded.reconcileInterruptedRuns()).toBe(3);
      const status = async (id: number) => {
        const got = await reloaded.get(id);
        if (got.status !== "found") throw new Error("missing");
        return got.item.runStatus;
      };
      expect(await status(whole.id)).toBe("awaiting_approval");
      expect(await status(noApproval.id)).toBe("error");
      expect(await status(otherRun.id)).toBe("error");
      expect(await status(editedPlan.id)).toBe("error");
    } finally {
      await cleanup();
    }
  });

  it("judges whether the item changed since its pending plan, for every reader", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const { id } = await planned(store);
      const fresh = await store.get(id);
      expect(fresh.status === "found" && fresh.item.planStale).toBe(false);
      await store.update(id, { detail: "changed after planning" });
      const edited = await store.get(id);
      expect(edited.status === "found" && edited.item.planStale).toBe(true);
      const listed = await store.list();
      expect(listed.status === "ok" && listed.items.find((item) => item.id === id)?.planStale).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("leaves the plan pending in memory when the decision cannot be written", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const { id, approval } = await planned(store);
      writeFault.failNext = true;
      await expect(store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "approved" })).rejects.toThrow("disk full");
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing");
      expect(got.item.runStatus).toBe("awaiting_approval");
      expect(got.item.planApproval?.status).toBe("pending");
      expect(JSON.parse(readFileSync(path, "utf-8")).items[0].planApproval.status).toBe("pending");
      // The same decision goes through once the disk accepts it.
      const retried = await store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "approved" });
      expect(retried.status).toBe("decided");
    } finally {
      writeFault.failNext = false;
      await cleanup();
    }
  });

  it("drops only an unreadable decision and keeps the item", async () => {
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const { id } = await planned(store);
      const board = JSON.parse(readFileSync(path, "utf-8"));
      board.items[0].planApproval.status = "allow-always";
      writeFileSync(path, JSON.stringify(board));
      const reloaded = new WorkBoardStore(path, fixedClock);
      const got = await reloaded.get(id);
      if (got.status !== "found") throw new Error("item dropped");
      expect(got.item.planApproval).toBeUndefined();
      expect(await reloaded.reconcileInterruptedRuns()).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("decides only the pending plan it names: wrong run, wrong hash, or a second decision are refused", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const { id, approval } = await planned(store);
      expect(await store.decidePlan(id, { runId: "run-x", planHash: approval.planHash, status: "approved" }))
        .toEqual({ status: "refused", reason: "not_pending" });
      expect(await store.decidePlan(id, { runId: "run-1", planHash: planHashOf("PLAN: other"), status: "approved" }))
        .toEqual({ status: "refused", reason: "plan_mismatch" });
      const decisions = await Promise.all([
        store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "approved" }),
        store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "approved" }),
      ]);
      expect(decisions.map((d) => d.status).sort()).toEqual(["decided", "refused"]);
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing");
      // The approval and the move to executing land in the same write.
      expect(got.item.runStatus).toBe("executing");
      expect(got.item.planApproval).toMatchObject({ status: "approved" });
    } finally {
      await cleanup();
    }
  });

  it("refuses to approve a plan made for an item that changed since, but still lets the user send it back", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const { id, approval } = await planned(store);
      expect((await store.update(id, { title: "a different job" })).status).toBe("updated");
      expect(await store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "approved" }))
        .toEqual({ status: "refused", reason: "plan_stale" });
      const sentBack = await store.decidePlan(id, { runId: "run-1", planHash: approval.planHash, status: "changes_requested", note: "redo it" });
      expect(sentBack.status).toBe("decided");
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing");
      expect(got.item.runStatus).toBe("planning");
      expect(got.item.planApproval).toMatchObject({ status: "changes_requested", note: "redo it" });
    } finally {
      await cleanup();
    }
  });

  it("refuses a patch that names run fields or the plan decision instead of ignoring it", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const { id } = await planned(store);
      for (const patch of [
        { planApproval: { status: "approved" } },
        { runStatus: "executing" },
        { plan: "PLAN: forged" },
        { title: "ok", runStatus: "completed" },
      ]) {
        const result = await store.update(id, patch as never);
        expect(result.status).toBe("invalid");
      }
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing");
      expect(got.item.title).toBe("plan me");
      expect(got.item.runStatus).toBe("awaiting_approval");
      expect(got.item.planApproval?.status).toBe("pending");
    } finally {
      await cleanup();
    }
  });
});
