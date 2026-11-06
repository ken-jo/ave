// Inject a temporary board path and clock so real user work-board files remain untouched.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PROPOSAL_TTL_MAX_MS, PROPOSAL_TTL_MIN_MS } from "../../shared/work-board-types.js";
import type { WorkProposalInput } from "../../shared/work-board-types.js";

const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");

function tempStore(now: () => number = () => FIXED_NOW) {
  const dir = mkdtempSync(join(tmpdir(), "ave-wbp-"));
  const path = join(dir, "board.json");
  return {
    dir,
    path,
    store: new WorkBoardStore(path, now),
    cleanup: () => cleanupTmpDir(dir),
  };
}

function input(overrides: Partial<WorkProposalInput> = {}): WorkProposalInput {
  return {
    kind: "stale-index",
    key: "folder:reports",
    title: "Re-index the reports folder",
    summary: "18 files changed since the last scan.",
    state: "Last scanned 12 days ago; 18 files newer than the index.",
    evidence: [{ label: "Newest change", detail: "quarterly-summary.docx" }],
    blockers: [{ reason: "The folder is on a disconnected share", resolution: "Reconnect the share" }],
    taskBrief: "Re-run the folder scan for the reports folder and report what changed.",
    ...overrides,
  };
}

async function fileProposal(store: WorkBoardStore, value: WorkProposalInput) {
  const result = await store.fileBriefingProposals([value]);
  const listed = await store.listProposals();
  if (listed.status !== "ok") throw new Error("proposal setup failed");
  const id = result.filed[0] ?? result.refreshed[0];
  const proposal = listed.proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error("proposal setup failed");
  return proposal;
}

describe("WorkBoardStore — proposal lifecycle", () => {
  it("posts a proposal, lists it live, and refreshes it in place on the same key", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await fileProposal(store, input());
      // Identity and label are the HOST's: the payload named neither.
      expect(posted.pluginId).toBe("ave.briefing");
      expect(posted.pluginLabel).toBe("Briefing");
      expect(posted.id.startsWith("ave.briefing:stale-index:")).toBe(true);
      expect(posted.id).not.toContain("folder:reports");

      const listed = await store.listProposals();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.proposals).toHaveLength(1);
      expect(listed.proposals[0].title).toBe("Re-index the reports folder");

      const refreshed = await fileProposal(
        store,
        input({ summary: "26 files changed since the last scan." }),
      );
      expect(refreshed.id).toBe(posted.id);
      const after = await store.listProposals();
      expect(after.status === "ok" && after.proposals).toHaveLength(1);
      expect(after.status === "ok" && after.proposals[0].summary).toBe(
        "26 files changed since the last scan.",
      );
      // A refresh keeps the original createdAt — it is the same card.
      expect(after.status === "ok" && after.proposals[0].createdAt).toBe(
        posted.createdAt,
      );
    } finally {
      await cleanup();
    }
  });

  it("survives a restart", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      await fileProposal(store, input());
      const reopened = new WorkBoardStore(path, () => FIXED_NOW);
      const listed = await reopened.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(1);
      expect(listed.status === "ok" && listed.proposals[0].key).toBe("folder:reports");
      // Beside board.json, not inside it.
      expect(JSON.parse(readFileSync(join(path, "..", "proposals.json"), "utf8")).proposals)
        .toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("sweeps a proposal whose TTL has run out", async () => {
    let now = FIXED_NOW;
    const { store, cleanup } = tempStore(() => now);
    try {
      await fileProposal(store, input({ ttlMs: PROPOSAL_TTL_MIN_MS }));
      expect((await store.listProposals()).status).toBe("ok");
      now = FIXED_NOW + PROPOSAL_TTL_MIN_MS + 1;
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("clamps a TTL outside the host's window instead of honouring it", async () => {
    const { store, cleanup } = tempStore();
    try {
      const short = await fileProposal(store, input({ ttlMs: 1 }));
      expect(Date.parse(short.expiresAt)).toBe(
        FIXED_NOW + PROPOSAL_TTL_MIN_MS,
      );
      const long = await fileProposal(
        store,
        input({ key: "folder:archive", kind: "embed-failed", ttlMs: 10 * PROPOSAL_TTL_MAX_MS }),
      );
      expect(Date.parse(long.expiresAt)).toBe(
        FIXED_NOW + PROPOSAL_TTL_MAX_MS,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — briefing proposal validation", () => {
  it("drops malformed briefing entries without storing them", async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await store.fileBriefingProposals([
        input({ title: "   " }), input({ key: "" }), input({ dueAt: "not-a-date" }),
      ]);
      expect(result).toEqual({ filed: [], refreshed: [] });
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("keeps a dismissed card closed through a re-post", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await fileProposal(store, input());
      expect((await store.dismissProposal(posted.id)).status).toBe("dismissed");
      expect((await store.listProposals()).status === "ok").toBe(true);
      expect((await store.listProposals() as { proposals: unknown[] }).proposals).toHaveLength(0);

      // Re-posting the SAME key refreshes the record but must not put the card the user closed back in front of them.
      expect(await store.fileBriefingProposals([input({ summary: "still stale" })]))
        .toEqual({ filed: [], refreshed: [posted.id] });
      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkBoardStore — accepting a proposal", () => {
  it("promotes it through the ordinary create path and closes the card", async () => {
    const { store, cleanup } = tempStore();
    try {
      const posted = await fileProposal(store, input({ priority: "high" }));

      const accepted = await store.acceptProposal(posted.id, {
        projectRoot: "/tmp/project",
        projectName: "project",
      });
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") return;
      expect(accepted.item.title).toBe("Re-index the reports folder");
      expect(accepted.item.priority).toBe("high");
      expect(accepted.item.status).toBe("planned");
      expect(accepted.item.projectRoot).toBe("/tmp/project");
      // The HOST composed the detail out of state + evidence + blockers, so the shape does not depend on how a plugin laid its text out.
      expect(accepted.item.detail).toContain("Last scanned 12 days ago");
      expect(accepted.item.detail).toContain("Newest change: quarterly-summary.docx");
      expect(accepted.item.detail).toContain("disconnected share → Reconnect the share");
      // `taskBrief` is instruction text for the run, not something to render.
      expect(accepted.item.detail).not.toContain("Re-run the folder scan");

      const listed = await store.listProposals();
      expect(listed.status === "ok" && listed.proposals).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("reports not_found for an id that is not open", async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await store.acceptProposal("indexer:stale-index:deadbeefdeadbeef");
      expect(result).toEqual({
        status: "not_found",
        proposalId: "indexer:stale-index:deadbeefdeadbeef",
      });
    } finally {
      await cleanup();
    }
  });
});
