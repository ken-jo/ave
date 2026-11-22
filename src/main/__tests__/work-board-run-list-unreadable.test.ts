import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

it.each(["EIO", "EACCES", "EBUSY"])("lists a held view and one coded banner during a run-file %s episode", async code => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const running = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    child.finish();
    await running;
    const path = join(h.dir, "workflow-runs.json");
    const original = homeTrust.readAveHomeInput;
    const spy = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async target => {
      if (target === path) throw Object.assign(new Error("private raw I/O cause"), { code });
      return original(target);
    });
    for (let count = 0; count < 2; count += 1) {
      const listed = await h.board.list();
      expect(listed).toMatchObject({ status: "ok", writesRefused: "work-board-runs-unreadable" });
      expect(JSON.stringify(listed)).not.toContain("private raw");
      if (listed.status !== "ok") throw new Error("List refused");
      expect(listed.items.find(item => item.id === id)?.templateRunError).toBe("template-runs-pending-review");
    }
    spy.mockRestore();
    expect(await h.board.list()).not.toHaveProperty("writesRefused");
    await h.board.recoverRuns(() => false);
    expect(await h.board.list()).not.toHaveProperty("writesRefused");
    const bytes = readFileSync(path, "utf8");
    for (const [invalid, reason] of [["{", "invalid-template-run"], ['{"version":1,"runs":[],"runs":[]}', "workflow-runs-duplicate-key"]]) {
      writeFileSync(path, invalid);
      await expect(h.board.list()).rejects.toMatchObject({ code: reason });
    }
    writeFileSync(path, bytes);
  } finally {
    vi.restoreAllMocks();
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});
