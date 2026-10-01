/**
 * The apply queue (design §18.7.4): one package at a time, only while the
 * real conversation activity coordinator is idle, with the 30-minute
 * escalation and *Apply now*; and what an install throws, classified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationActivityCoordinator } from "../../../engine/conversation-activity-coordinator.js";
import { CommittedPluginGenerationPublicationError } from "../../../plugins/committed-generation-publication-error.js";
import { CarriedApprovalWithdrawnError } from "../../../plugins/plugin-contribution-trust.js";
import { MarketplaceError } from "../../errors.js";
import { ApplyQueue, applyOrder, CALLS_RETRY_MS, classifyApplyError, ESCALATE_AFTER_MS, type ApplyItem, type ApplyOutcome } from "../apply.js";
import { UpdateNeedsReviewError } from "../consent.js";

function item(name: string, options: Partial<ApplyItem> = {}): ApplyItem {
  return { id: `acme:${options.kind ?? "plugin"}:${name}`, kind: "plugin", name, provides: [], needs: [], ...options };
}

function queueOf(options: { busy?: () => boolean; calls?: (item: ApplyItem) => boolean } = {}) {
  const activity = createConversationActivityCoordinator();
  const applied: string[] = [];
  const outcomes: Array<[string, ApplyOutcome]> = [];
  const shutdown = new AbortController();
  const apply = vi.fn(async (next: ApplyItem): Promise<ApplyOutcome> => {
    applied.push(next.name);
    return { state: "applied" };
  });
  const queue = new ApplyQueue<ApplyItem>({
    activity,
    apply,
    callsInFlight: async (next) => options.calls?.(next) ?? false,
    settled: async (next, outcome) => {
      outcomes.push([next.name, outcome]);
    },
    changed: vi.fn(),
    signal: shutdown.signal,
    now: () => Date.now(),
    log: { warn: vi.fn() },
  });
  return { activity, queue, applied, outcomes, apply, shutdown };
}

/** A lease the test holds until it calls the returned release. */
function hold(track: (factory: () => Promise<void>) => Promise<void> | null): () => Promise<void> {
  let release!: () => void;
  const lease = track(() => new Promise<void>((resolve) => { release = resolve; }));
  if (!lease) throw new Error("the coordinator was busy");
  return async () => {
    await Promise.resolve();
    release();
    await lease;
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the idle gate", () => {
  it("waits while a session mutation with no turn holds the conversation, and applies when the mutation ends", async () => {
    const { activity, queue, applied } = queueOf();
    const end = hold((factory) => activity.trackMutation(factory));
    queue.replace([item("notes")]);
    await flush();
    expect(applied).toEqual([]);
    expect(queue.state().waitingSince).not.toBeNull();

    await end();
    await queue.drained();
    expect(applied).toEqual(["notes"]);
    expect(queue.state()).toMatchObject({ waitingSince: null, escalated: false, queued: [] });
  });

  it("waits at boot too: a turn already running holds the first package", async () => {
    const { activity, queue, applied } = queueOf();
    const end = hold((factory) => activity.tryTrackTurn(factory));
    queue.replace([item("notes"), item("wiki")]);
    await flush();
    expect(applied).toEqual([]);
    await end();
    await queue.drained();
    expect(applied).toEqual(["notes", "wiki"]);
  });

  it("does not miss an idle moment between its check and its subscription", async () => {
    const { activity, queue, applied } = queueOf();
    const release = activity.beginSessionTransitionAdmission();
    queue.replace([item("notes")]);
    await flush();
    release!.release();
    await queue.drained();
    expect(applied).toEqual(["notes"]);
  });

  it("reads the gate again once subscribed: idle reached with no notice in between still applies", async () => {
    // Busy at the first read, idle by the time the queue has subscribed, and no idle notice ever comes.
    const isBusy = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const applied: string[] = [];
    const queue = new ApplyQueue<ApplyItem>({
      activity: { isBusy, onIdle: () => () => undefined },
      apply: async (next) => {
        applied.push(next.name);
        return { state: "applied" };
      },
      callsInFlight: async () => false,
      settled: async () => undefined,
      changed: vi.fn(),
      signal: new AbortController().signal,
      now: () => Date.now(),
      log: { warn: vi.fn() },
    });
    queue.replace([item("notes")]);
    await queue.drained();
    expect(applied).toEqual(["notes"]);
  });

  it("escalates after 30 minutes, keeps waiting without Apply now, and Apply now skips only the idle gate", async () => {
    const { activity, queue, applied } = queueOf();
    const end = hold((factory) => activity.tryTrackTurn(factory));
    queue.replace([item("notes"), item("wiki")]);
    await flush();
    await vi.advanceTimersByTimeAsync(ESCALATE_AFTER_MS - 1);
    expect(queue.state().escalated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.state().escalated).toBe(true);
    // Hours later, still waiting: the escalation is not a bound.
    await vi.advanceTimersByTimeAsync(5 * ESCALATE_AFTER_MS);
    expect(applied).toEqual([]);

    queue.applyNow();
    await queue.drained();
    expect(applied).toEqual(["notes", "wiki"]);
    expect(queue.state()).toMatchObject({ waitingSince: null, escalated: false });
    await end();

    // The next queue waits for idle again.
    const again = hold((factory) => activity.tryTrackTurn(factory));
    queue.replace([item("later")]);
    await flush();
    expect(applied).toEqual(["notes", "wiki"]);
    await again();
    await queue.drained();
    expect(applied).toEqual(["notes", "wiki", "later"]);
  });
});

describe("the queue", () => {
  it("waits for an agent plugin's calls, applying the others first, and tries it again", async () => {
    let calls = true;
    const { queue, applied } = queueOf({ calls: (next) => next.kind === "agent-plugin" && calls });
    queue.replace([item("assist", { kind: "agent-plugin" }), item("theme", { kind: "theme" })]);
    await flush();
    expect(applied).toEqual(["theme"]);
    expect(queue.state().waitingForCalls).toEqual(["acme:agent-plugin:assist"]);
    calls = false;
    await vi.advanceTimersByTimeAsync(CALLS_RETRY_MS);
    await queue.drained();
    expect(applied).toEqual(["theme", "assist"]);
    expect(queue.state().waitingForCalls).toEqual([]);
  });

  it("orders extensions by what they provide and require, then the rest by key", () => {
    const ordered = applyOrder([
      item("zeta", { kind: "skill" }),
      item("viewer", { needs: ["pdf"] }),
      item("alpha", { kind: "agent-plugin" }),
      item("parser", { provides: ["pdf"] }),
    ]);
    expect(ordered.map((entry) => entry.name)).toEqual(["parser", "viewer", "alpha", "zeta"]);
  });

  it("replaces what is queued and leaves the package applying alone", async () => {
    const { queue, applied, apply } = queueOf();
    let finish!: () => void;
    apply.mockImplementationOnce(async (next) => {
      applied.push(next.name);
      await new Promise<void>((resolve) => { finish = resolve; });
      return { state: "applied" };
    });
    queue.replace([item("notes"), item("wiki")]);
    await flush();
    expect(queue.state().applying).toBe("acme:plugin:notes");
    queue.replace([item("notes"), item("mail")]);
    expect(queue.state().queued).toEqual(["acme:plugin:mail"]);
    finish();
    await queue.drained();
    expect(applied).toEqual(["notes", "mail"]);
  });

  it("applies nothing more once the app shuts down; the package applying finishes", async () => {
    const { queue, applied, apply, outcomes, shutdown } = queueOf();
    let finish!: () => void;
    apply.mockImplementationOnce(async (next) => {
      applied.push(next.name);
      await new Promise<void>((resolve) => { finish = resolve; });
      return { state: "applied" };
    });
    queue.replace([item("notes"), item("wiki")]);
    await flush();
    shutdown.abort();
    expect(queue.state().queued).toEqual([]);
    finish();
    await queue.drained();
    expect(applied).toEqual(["notes"]);
    expect(outcomes.map(([name]) => name)).toEqual(["notes"]);
    queue.replace([item("later")]);
    queue.applyNow();
    await queue.drained();
    expect(applied).toEqual(["notes"]);
  });

  it("classifies what an apply throws", async () => {
    const { queue, apply, outcomes } = queueOf();
    apply.mockRejectedValueOnce(new UpdateNeedsReviewError("notes", [{ field: "hook:audit", checkpoint: "staged", before: null, after: "a".repeat(64) }]));
    queue.replace([item("notes")]);
    await queue.drained();
    expect(outcomes).toEqual([["notes", { state: "needs-review", delta: [{ field: "hook:audit", checkpoint: "staged", before: null, after: "a".repeat(64) }] }]]);
  });
});

describe("classifyApplyError (§18.7.4's table)", () => {
  const transition = {} as never;

  it("a consent deferral: checkpoint two, or a carried approval withdrawn, found in the cause chain and aggregated errors", () => {
    const review = new UpdateNeedsReviewError("notes", []);
    expect(classifyApplyError(review)).toEqual({ state: "needs-review", delta: [] });
    expect(classifyApplyError(new Error("install failed", { cause: review }))).toEqual({ state: "needs-review", delta: [] });
    expect(classifyApplyError(new AggregateError([new Error("x"), new CarriedApprovalWithdrawnError("notes", "audit")]))).toEqual({ state: "needs-review", delta: null });
  });

  it("a publication failure after the durable commit: applied when active, applied-not-running when inactive", () => {
    expect(classifyApplyError(new CommittedPluginGenerationPublicationError("notes", "g".repeat(64), new Error("publish"), transition))).toEqual({ state: "applied" });
    const inactive = new CommittedPluginGenerationPublicationError("notes", undefined, new Error("publish"), transition);
    expect(classifyApplyError(inactive)).toEqual({ state: "applied-not-running" });
    expect(classifyApplyError(new Error("wrapped", { cause: inactive }))).toEqual({ state: "applied-not-running" });
  });

  it("anything else failed before commit", () => {
    const error = new MarketplaceError("SOURCE_UNREACHABLE", "offline", { detail: { reason: "offline" } });
    expect(classifyApplyError(error)).toEqual({ state: "failed", error });
  });
});
