/** Alert-contract plugins get scoped, once-per-30-day suggestions; legacy plugins retain the unscoped path. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateTriggerSpec,
  TriggerConversationDedupe,
  TriggerConversationRateLimiter,
} from "../plugin-runtime.js";
import { SuggestionLedger } from "../../../alerts/suggestion-ledger.js";
import { getDeclaredSuggestionSources } from "../../../plugins/runtime/manifest-validation.js";
import type { PluginManifest } from "../../../plugins/types.js";

const NOW = Date.parse("2026-09-26T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const DECLARED = "overlay:fixturemail-routine";

let dir: string;
const ledgers: SuggestionLedger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "trigger-suggestion-scope-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Drain background persistence before cleanup so writes cannot recreate the directory.
  for (const ledger of ledgers.splice(0)) await ledger.flush();
  await rm(dir, { recursive: true, force: true });
});

async function loadedLedger(): Promise<SuggestionLedger> {
  const ledger = new SuggestionLedger(() => dir);
  ledgers.push(ledger);
  await ledger.load();
  return ledger;
}

function evaluate(input: {
  source: string;
  declared: readonly string[] | null;
  ledger?: SuggestionLedger;
  rateLimiter?: TriggerConversationRateLimiter;
  dedupeKey?: string;
  now?: number;
}) {
  return evaluateTriggerSpec({
    spec: { source: input.source, prompt: "Set up a morning briefing?", dedupeKey: input.dedupeKey },
    pluginId: "fixturemail",
    capabilities: ["host:overlay"],
    dedupe: new TriggerConversationDedupe(),
    rateLimiter: input.rateLimiter ?? new TriggerConversationRateLimiter(),
    auditLogger: { log: vi.fn() },
    now: () => input.now ?? NOW,
    suggestions: input.declared === null || input.ledger === undefined
      ? undefined
      : { declared: input.declared, ledger: input.ledger },
  });
}

describe("triggerConversation suggestion scoping", () => {
  it("refuses an undeclared source with source_not_declared and charges no window", async () => {
    const ledger = await loadedLedger();
    const rateLimiter = new TriggerConversationRateLimiter(60_000, 1);
    const outcome = evaluate({ source: "overlay:fixturemail-other", declared: [DECLARED], ledger, rateLimiter });
    expect(outcome).toMatchObject({ kind: "deny", result: { accepted: false, reason: "source_not_declared" } });
    expect(rateLimiter.isOverCap("fixturemail", NOW)).toBe(false);
    expect(ledger.isLimited("fixturemail", "overlay:fixturemail-other", NOW)).toBe(false);
  });

  it("accepts a declared source once, then refuses it with suggestion_limit for 30 days", async () => {
    const ledger = await loadedLedger();
    expect(evaluate({ source: DECLARED, declared: [DECLARED], ledger }).kind).toBe("allow");

    const rateLimiter = new TriggerConversationRateLimiter(60_000, 1);
    const again = evaluate({ source: DECLARED, declared: [DECLARED], ledger, rateLimiter, now: NOW + 29 * DAY });
    expect(again).toMatchObject({ kind: "deny", result: { accepted: false, reason: "suggestion_limit", source: DECLARED } });
    expect(rateLimiter.isOverCap("fixturemail", NOW + 29 * DAY)).toBe(false);

    expect(evaluate({ source: DECLARED, declared: [DECLARED], ledger, now: NOW + 30 * DAY }).kind).toBe("allow");
  });

  it("keeps the limit across a restart", async () => {
    const before = await loadedLedger();
    expect(evaluate({ source: DECLARED, declared: [DECLARED], ledger: before }).kind).toBe("allow");
    await before.flush();

    const after = await loadedLedger();
    expect(evaluate({ source: DECLARED, declared: [DECLARED], ledger: after, now: NOW + DAY }))
      .toMatchObject({ kind: "deny", result: { reason: "suggestion_limit" } });
  });

  it("counts each declared source separately", async () => {
    const ledger = await loadedLedger();
    const declared = [DECLARED, "overlay:fixturemail-rescan"];
    expect(evaluate({ source: DECLARED, declared, ledger }).kind).toBe("allow");
    expect(evaluate({ source: "overlay:fixturemail-rescan", declared, ledger }).kind).toBe("allow");
  });

  it("treats a refused alerts block as declared, with no source granted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = { alerts: { reasoning: "x", kinds: [], suggestions: [DECLARED] } } as unknown as PluginManifest;
    const declared = getDeclaredSuggestionSources(refused, "fixturemail");
    expect(declared).toEqual([]);
    const ledger = await loadedLedger();
    expect(evaluate({ source: DECLARED, declared, ledger }))
      .toMatchObject({ kind: "deny", result: { reason: "source_not_declared" } });
  });

  it("does not limit a plugin without an alerts block", () => {
    const declared = getDeclaredSuggestionSources({}, "fixturemail");
    expect(declared).toBeNull();
    for (let i = 0; i < 3; i += 1) {
      expect(evaluate({ source: DECLARED, declared, dedupeKey: `obs-${i}` }).kind).toBe("allow");
    }
  });
});
