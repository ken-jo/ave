/** Survey prompts are bounded, autonomous, and read-only; repeated proposals must refresh existing cards. */
import { describe, it, expect } from "vitest";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type {
  SubAgentRunner,
  SubAgentToolScope,
} from "../../engine/subagent-runner.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { BRIEFING_PROPOSAL_SOURCE_ID } from "../../shared/work-board-types.js";
import {
  boardParentToolRegistry,
  tempBoardStore as tempBoard,
} from "../../work-board/__tests__/board-test-fixtures.js";

interface SurveySpawn {
  title: string;
  instructions: string;
  toolScope: SubAgentToolScope;
  maxRounds?: number;
  profileMode?: string;
  originSessionId?: string;
}

function fakeRunner(answers: string[]): {
  runner: SubAgentRunner;
  spawns: SurveySpawn[];
} {
  const spawns: SurveySpawn[] = [];
  const registry = boardParentToolRegistry();
  const runner = {
    parentToolRegistry: () => registry,
    async spawn(input: SurveySpawn) {
      spawns.push(input);
      return {
        summary: answers[spawns.length - 1] ?? "[]",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e70",
        entries: [],
        ok: true,
      };
    },
  } as unknown as SubAgentRunner;
  return { runner, spawns };
}

const unusedGate = new ApprovalGate(null);

function engineOver(store: WorkBoardStore, runner: SubAgentRunner) {
  return createWorkBoardEngine({
    store,
    getRunner: () => runner,
    approvalGate: unusedGate,
    emitProgress: () => {},
  });
}

const ONE_ITEM = `Here you go:
\`\`\`json
[
  {
    "title": "Reply to the design review",
    "summary": "Three reviewers are waiting on your answer.",
    "state": "Opened four days ago; two comments unanswered.",
    "evidence": [{ "label": "Thread", "detail": "design review, 4 days old" }],
    "blockers": [{ "reason": "The spec link is dead", "resolution": "Ask for a new link" }],
    "taskBrief": "Open the review thread and answer the two open comments.",
    "priority": "high"
  }
]
\`\`\``;

describe("WorkBoardEngine — briefing survey", () => {
  it("hands the survey a bounded, autonomous, read-only prompt naming the open board", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "finish the migration" });
      expect(created.status).toBe("created");

      const { runner, spawns } = fakeRunner([ONE_ITEM]);
      const result = await engineOver(store, runner).runBriefing("daily");

      expect(result.status).toBe("ok");
      expect(spawns).toHaveLength(1);
      const spawn = spawns[0];

      expect(spawn.maxRounds).toBe(20);
      expect(spawn.toolScope.kind).toBe("exactly");
      const granted = spawn.toolScope.kind === "exactly" ? spawn.toolScope.names : [];
      expect(granted).toContain("read_file");
      expect(granted).not.toContain("write_file");
      expect(granted).not.toContain("web_fetch");
      expect(spawn.profileMode).toBe("plan");
      expect(spawn.instructions).toContain("AUTONOMOUSLY");
      expect(spawn.instructions).toContain("Do NOT ask the user any questions");
      expect(spawn.instructions).toContain("finish the migration");
    } finally {
      await cleanup();
    }
  });

  it("files each parsed action item as a proposal carrying the host source id", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner([ONE_ITEM]);
      const result = await engineOver(store, runner).runBriefing("daily");

      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.filed).toHaveLength(1);
      expect(result.refreshed).toHaveLength(0);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(1);
      const proposal = listed.proposals[0];
      expect(proposal.pluginId).toBe(BRIEFING_PROPOSAL_SOURCE_ID);
      expect(proposal.kind).toBe("daily-briefing");
      expect(proposal.title).toBe("Reply to the design review");
      expect(proposal.priority).toBe("high");
      expect(proposal.evidence).toEqual([
        { label: "Thread", detail: "design review, 4 days old" },
      ]);
      expect(proposal.blockers).toEqual([
        { reason: "The spec link is dead", resolution: "Ask for a new link" },
      ]);
      expect(proposal.taskBrief).toContain("Open the review thread");
    } finally {
      await cleanup();
    }
  });

  it("reports an empty survey rather than filing nothing silently", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner(["```json\n[]\n```"]);
      const result = await engineOver(store, runner).runBriefing("weekly");
      expect(result.status).toBe("empty");
      expect(result.kind).toBe("weekly");
    } finally {
      await cleanup();
    }
  });

  it("treats a survey answer with no action-item array as a failure", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner(["I could not read your mailbox."]);
      const result = await engineOver(store, runner).runBriefing("daily");
      expect(result.status).toBe("error");
    } finally {
      await cleanup();
    }
  });

  it("drops an action item missing a field the card renders", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const answer = `\`\`\`json
[
  { "title": "No state or brief" },
  {
    "title": "Complete row",
    "summary": "s",
    "state": "st",
    "taskBrief": "tb"
  }
]
\`\`\``;
      const { runner } = fakeRunner([answer]);
      const result = await engineOver(store, runner).runBriefing("daily");

      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.filed).toHaveLength(1);
      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals.map((p) => p.title)).toEqual(["Complete row"]);
    } finally {
      await cleanup();
    }
  });

  it("refreshes rather than duplicates when the same action item is surveyed twice", async () => {
    const { store, cleanup } = tempBoard();
    try {
      // Normalize title case and punctuation so reworded surveys refresh the same card.
      const reworded = ONE_ITEM
        .replace("Reply to the design review", "Reply to the Design Review!")
        .replace("Three reviewers are waiting on your answer.", "Still unanswered after five days.");

      const { runner } = fakeRunner([ONE_ITEM, reworded]);
      const engine = engineOver(store, runner);

      const first = await engine.runBriefing("daily");
      const second = await engine.runBriefing("daily");

      if (first.status !== "ok" || second.status !== "ok") throw new Error("both runs must file");
      expect(first.filed).toHaveLength(1);
      expect(second.filed).toHaveLength(0);
      expect(second.refreshed).toEqual(first.filed);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(1);
      expect(listed.proposals[0].summary).toBe("Still unanswered after five days.");
    } finally {
      await cleanup();
    }
  });

  it("does not re-open a card the user already dismissed", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner([ONE_ITEM, ONE_ITEM]);
      const engine = engineOver(store, runner);

      const first = await engine.runBriefing("daily");
      if (first.status !== "ok") throw new Error("first run must file");
      await store.dismissProposal(first.filed[0]);

      const second = await engine.runBriefing("daily");
      if (second.status !== "ok") throw new Error("second run must complete");
      expect(second.filed).toHaveLength(0);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("surfaces a survey that could not run as an error", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const registry = boardParentToolRegistry();
      const runner = {
        parentToolRegistry: () => registry,
        async spawn() {
          return {
            summary: "no LLM provider configured",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e71",
            entries: [],
            ok: false,
            error: "no LLM provider configured",
          };
        },
      } as unknown as SubAgentRunner;

      const result = await engineOver(store, runner).runBriefing("daily");
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("unreachable");
      expect(result.reason).toContain("no LLM provider configured");
    } finally {
      await cleanup();
    }
  });

  it("returns an error instead of spawning a second survey for the same window", async () => {
    const { store, cleanup } = tempBoard();
    try {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let spawnCount = 0;
      const registry = boardParentToolRegistry();
      const runner = {
        parentToolRegistry: () => registry,
        async spawn() {
          spawnCount += 1;
          await gate;
          return {
            summary: "[]",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e72",
            entries: [],
            ok: true,
          };
        },
      } as unknown as SubAgentRunner;

      const engine = engineOver(store, runner);
      const inFlight = engine.runBriefing("daily");
      const second = await engine.runBriefing("daily");
      expect(second.status).toBe("error");

      release?.();
      expect((await inFlight).status).toBe("empty");
      expect(spawnCount).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
