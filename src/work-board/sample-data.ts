/** Seed examples only once and never over real or migrated boards; deleting demos must not reseed. Boot continues on seed failure. */
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemCreateInput,
  WorkItemCreateResult,
  WorkItemListResult,
} from "../shared/work-board-types.js";

export const SAMPLE_SEEDED_FILE = "sample-seeded.json";

export interface SampleSeedStore {
  list(): Promise<WorkItemListResult>;
  create(input: WorkItemCreateInput): Promise<WorkItemCreateResult>;
  setRunResult(
    id: number,
    patch: {
      runStatus: "completed";
      plan?: string | null;
      output?: string | null;
      runSessionId?: string | null;
    },
  ): Promise<unknown>;
}

export interface SampleSeedDeps {
  store: SampleSeedStore;
  marker: Pick<WorkBoardStorage, "readJson" | "writeJson">;
  alreadyMigrated: boolean;
  now: () => number;
}

export interface SampleSeedResult {
  seeded: boolean;
  reason?: string;
  count?: number;
}

interface SampleSeededMarker {
  seeded: boolean;
  decidedAt: string;
  count?: number;
}

function sampleItems(nowMs: number): Array<{
  input: WorkItemCreateInput;
  run?: { plan: string; output: string };
}> {
  const inHours = (h: number) => new Date(nowMs + h * 60 * 60_000).toISOString();
  return [
    {
      input: {
        title: "[Sample] Draft the weekly work report",
        detail:
          "Collect this week's completed and in-progress items into a weekly report draft. Open the card and choose Run; the agent will plan, request approval, and draft the report after approval.",
        priority: "high",
        status: "planned",
        due_at: inHours(20),
      },
    },
    {
      input: {
        title: "[Sample] Organize competitor research",
        detail:
          "The agent is researching sources and drafting a comparison table. The In Progress column shows the live execution state.",
        priority: "medium",
        status: "in_progress",
        due_at: inHours(3 * 24),
      },
    },
    {
      input: {
        title: "[Sample] Summarize the Q2 retrospective",
        detail: "A completed example where a subagent ran autonomously after approval and saved the result.",
        priority: "medium",
        status: "completed",
      },
      run: {
        plan:
          "1) Collect completed Q2 work  2) Sort into wins/issues/lessons learned  3) Derive next-quarter action items  4) Summarize on one page",
        output:
          "## Q2 Retrospective Summary\n\n**Wins** — Shipped three core features and reduced response latency by 28%.\n**Issues** — Review cycle delays repeated, so a checklist was introduced.\n**Next Quarter** — (1) Expand automation coverage (2) refresh onboarding docs (3) make weekly retrospectives routine.\n\n_This result is sample data._",
      },
    },
  ];
}

/** Record every terminal seed decision, including deliberate skips, to prevent repeated onboarding. */
export async function seedSampleWorkBoard(deps: SampleSeedDeps): Promise<SampleSeedResult> {
  const { store, marker, alreadyMigrated, now } = deps;

  const existing = await marker.readJson<SampleSeededMarker>(SAMPLE_SEEDED_FILE);
  if (existing) return { seeded: false, reason: "already-decided" };

  const decidedAt = new Date(now()).toISOString();

  if (alreadyMigrated) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "migrated" };
  }
  const listed = await store.list();
  if (listed.status === "ok" && listed.items.length > 0) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "non-empty" };
  }

  let count = 0;
  for (const sample of sampleItems(now())) {
    const created = await store.create(sample.input);
    if (created.status !== "created") continue;
    count += 1;
    if (sample.run) {
      await store.setRunResult(created.itemId, {
        runStatus: "completed",
        plan: sample.run.plan,
        output: sample.run.output,
        runSessionId: `sample:${created.itemId}`,
      });
    }
  }

  await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: true, decidedAt, count });
  return { seeded: true, count };
}
