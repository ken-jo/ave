import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerEachStart, FIXTURE_START_IDENTITY as ID } from "../../__tests__/support/approved-extension-start.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { planWindowsSandbox } from "../../boot/steps/windows-sandbox-plan.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import * as aveHome from "../../shared/ave-home.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { assertExtensionStartAllowed } from "../asrt-sandbox.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, dropExtensionStart, dropPluginExtensionStarts, EXTENSION_START_CONSENT_REQUIRED_CODE, EXTENSION_START_GRANT_TTL_MS, extensionStartIdentity, listPendingExtensionStarts,
  requestExtensionStartConsent, runExtensionStart, setExtensionStartAsker, settlePendingExtensionStarts, takeExtensionStartGrant,
  type ExtensionStartAsker, type ExtensionStartAuthority, type PendingExtensionStart,
} from "../extension-start-consent.js";
import {
  __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  setPluginWorkerConfinementRequestedAtBoot, setWindowsSandboxSubstrate,
} from "../sandbox-capability.js";

const HOST_PLATFORM = process.platform;
const HOME = "C:/Users/alice/.ave";
const ATTENDED = { sessionId: "s1", attended: true };
const HEADLESS = { sessionId: "s1", attended: false };

type ExtensionState = NonNullable<Parameters<typeof planWindowsSandbox>[0]["extensionMxc"]>;
function publish(extensionMxc: ExtensionState, admittedAncestorBackend?: "srt-win"): void {
  const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: { state: "available" }, extensionMxc,
    windowsBuild: null, srtWinReady: false, ...(admittedAncestorBackend ? { admittedAncestorBackend } : {}) });
  setWindowsSandboxSubstrate(substrate);
}

function gate(key: string, authority: ExtensionStartAuthority | undefined, spend = false, identity = ID): string {
  try {
    assertExtensionStartAllowed({ start: { key, identity, authority, spend } });
    return "started";
  } catch (error) {
    return (error as { code?: string }).code ?? `refused:${(error as Error).name}`;
  }
}

function fakeAsker(answers: ("yes" | "no" | "no-approver")[]) {
  return { ask: vi.fn<ExtensionStartAsker["ask"]>(answerEachStart(() => answers.shift() ?? "no")), notify: vi.fn<ExtensionStartAsker["notify"]>() };
}

const start = (key: string, retry?: () => Promise<void>): PendingExtensionStart =>
  ({ key, identity: ID, kind: "plugin-child", label: key, cause: "no-backend", ...(retry ? { retry } : {}) });

beforeEach(() => {
  setProcessPlatform("win32");
  setPluginWorkerConfinementRequestedAtBoot(true);
  setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: HOME, sid: "S-1-5-21-1" });
  publish({ state: "unavailable", reason: "runtime-start-failed" });
});
afterEach(() => {
  setProcessPlatform(HOST_PLATFORM);
  __resetExtensionStartsForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
  _resetAveHomePrivacyForTest();
});

describe("extension start with no backend", () => {
  it("never starts without a consent", () => {
    expect(gate("plugin-child:a", undefined)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(gate("plugin-child:a", undefined, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    try {
      assertExtensionStartAllowed();
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: EXTENSION_START_CONSENT_REQUIRED_CODE, unconfinedCause: "no-backend" });
    }
  });

  it("asks about every waiting start on one card, starts each approved one with its own consent and spends it at the spawn", async () => {
    const asker = fakeAsker(["yes", "yes"]);
    setExtensionStartAsker(asker);
    const results: string[] = [];
    for (const key of ["plugin-child:a", "mcp-stdio:b"]) {
      deferExtensionStart(start(key, async () => {
        const authority = takeExtensionStartGrant(key);
        // The gate crossings before the spawn share the one consent; the spawn crossing spends it.
        results.push(gate(key, authority), gate(key, authority), gate(key, authority, true), gate(key, authority, true));
      }));
    }
    expect(listPendingExtensionStarts().map((entry) => entry.key)).toEqual(["plugin-child:a", "mcp-stdio:b"]);
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.ask.mock.calls[0]?.[0].map((asked) => asked.key)).toEqual(["plugin-child:a", "mcp-stdio:b"]);
    const once = ["started", "started", "started", EXTENSION_START_CONSENT_REQUIRED_CODE];
    expect(results).toEqual([...once, ...once]);
    expect(listPendingExtensionStarts()).toEqual([]);
    expect(asker.notify).not.toHaveBeenCalled();
  });

  it("asks again for a second start of the same extension", async () => {
    const asker = fakeAsker(["yes", "yes"]);
    setExtensionStartAsker(asker);
    const first = await requestExtensionStartConsent(start("plugin-hook:a/h"), ATTENDED);
    expect(gate("plugin-hook:a/h", first, true)).toBe("started");
    // The second start presents the spent consent: refused, so it has to ask for itself.
    expect(gate("plugin-hook:a/h", first, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(takeExtensionStartGrant("plugin-hook:a/h")).toBeUndefined();
    const second = await requestExtensionStartConsent(start("plugin-hook:a/h"), ATTENDED);
    expect(second).not.toBe(first);
    expect(gate("plugin-hook:a/h", second, true)).toBe("started");
    expect(asker.ask).toHaveBeenCalledTimes(2);
  });

  it("does not pass a consent given to another start", async () => {
    setExtensionStartAsker(fakeAsker(["yes"]));
    const authority = await requestExtensionStartConsent(start("plugin-child:a"), ATTENDED);
    expect(gate("plugin-child:b", authority, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    // A mismatched presentation burns it.
    expect(gate("plugin-child:a", authority, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(gate("plugin-child:a", { key: "plugin-child:a", identity: ID, consent: {} as ExtensionStartAuthority["consent"] }, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
  });

  it("never starts a waiting start in a headless session and says so once", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart(start("plugin-child:a", retry));
    await settlePendingExtensionStarts(HEADLESS);
    await settlePendingExtensionStarts(HEADLESS);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(takeExtensionStartGrant("plugin-child:a")).toBeUndefined();
    expect(asker.notify).toHaveBeenCalledTimes(1);
    expect(asker.notify).toHaveBeenCalledWith(expect.objectContaining({ key: "plugin-child:a" }), "unattended");
    expect(await requestExtensionStartConsent(start("plugin-hook:a/h"), HEADLESS)).toBeUndefined();
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending"]);
  });

  it("leaves a declined start unstarted with one notice and does not ask again", async () => {
    const asker = fakeAsker(["no", "yes"]);
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart(start("plugin-child:a", retry));
    await settlePendingExtensionStarts(ATTENDED);
    deferExtensionStart(start("plugin-child:a", retry));
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(asker.notify).toHaveBeenCalledTimes(1);
    expect(asker.notify).toHaveBeenCalledWith(expect.objectContaining({ key: "plugin-child:a" }), "declined");
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["declined"]);
    expect(gate("plugin-child:a", takeExtensionStartGrant("plugin-child:a"), true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
  });

  it("shows one card when two turns begin together", async () => {
    let release!: (answer: "yes") => void;
    const asker: ExtensionStartAsker = { ask: vi.fn<ExtensionStartAsker["ask"]>(async (starts) => {
      const given = await new Promise<"yes">((resolve) => { release = resolve; });
      return new Map(starts.map((asked) => [asked.key, given]));
    }), notify: vi.fn() };
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart(start("plugin-child:a", retry));
    const first = settlePendingExtensionStarts(ATTENDED);
    const second = settlePendingExtensionStarts({ sessionId: "s2", attended: true });
    await vi.waitFor(() => expect(asker.ask).toHaveBeenCalledTimes(1));
    release("yes");
    await Promise.all([first, second]);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("drops a consent its approved start never spent", async () => {
    setExtensionStartAsker(fakeAsker(["yes"]));
    deferExtensionStart(start("plugin-child:a", async () => { throw new Error("fixture: failed before spawn"); }));
    await settlePendingExtensionStarts(ATTENDED);
    expect(takeExtensionStartGrant("plugin-child:a")).toBeUndefined();
  });
});

describe("extension start states a consent does not answer", () => {
  it("keeps refusing a rejected plan, with or without a consent", async () => {
    setExtensionStartAsker(fakeAsker(["yes"]));
    const authority = await requestExtensionStartConsent(start("plugin-child:a"), ATTENDED);
    __resetWindowsSandboxSubstrateForTest();
    publish({ state: "unavailable", reason: "readiness-deadline" });
    expect(gate("plugin-child:a", undefined)).toBe("extension-readiness-refused");
    expect(gate("plugin-child:a", authority, true)).toBe("extension-readiness-refused");
  });

  it("runs a session-bound start with the answer it asked for, and asks again for the next one", async () => {
    const asker = fakeAsker(["yes", "no"]);
    setExtensionStartAsker(asker);
    const run = vi.fn(async (authority: ExtensionStartAuthority | undefined) => {
      assertExtensionStartAllowed({ start: { key: "worker:p/w", identity: ID, authority, spend: true } });
      return "started";
    });
    const pending = { key: "worker:p/w", kind: "worker" as const, label: "p (w)" };
    await expect(runExtensionStart(pending, ATTENDED, run)).resolves.toBe("started");
    expect(run).toHaveBeenCalledTimes(2);
    // The first start spent its consent; the second asks for itself and is declined.
    await expect(runExtensionStart(pending, ATTENDED, run)).rejects.toThrow(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(asker.ask).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("leaves a sessionless start waiting, and its next run takes the consent a later turn gave", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    const run = vi.fn(async (authority: ExtensionStartAuthority | undefined) => {
      assertExtensionStartAllowed({ start: { key: "worker:p/w", identity: ID, authority, spend: true } });
      return "started";
    });
    const pending = { key: "worker:p/w", kind: "worker" as const, label: "p (w)" };
    await expect(runExtensionStart(pending, undefined, run)).rejects.toThrow(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "worker:p/w", kind: "worker", state: "pending" }]);
    await settlePendingExtensionStarts(ATTENDED);
    await expect(runExtensionStart(pending, undefined, run)).resolves.toBe("started");
    await expect(runExtensionStart(pending, undefined, run)).rejects.toThrow(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(asker.ask).toHaveBeenCalledTimes(1);
  });

  it("passes any other start failure through without asking", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    await expect(runExtensionStart({ key: "worker:p/w", kind: "worker", label: "p (w)" }, ATTENDED, async () => { throw new Error("spawn failed"); }))
      .rejects.toThrow("spawn failed");
    expect(asker.ask).not.toHaveBeenCalled();
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("binds a consent to its own start: another start cannot use it, and its spawn crossing burns it", async () => {
    setExtensionStartAsker(fakeAsker(["yes", "yes"]));
    const a = await requestExtensionStartConsent(start("plugin-child:a"), ATTENDED);
    if (a === undefined) throw new Error("the fixture consent was not given");
    expect(gate("plugin-child:b", a)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    // Re-labelled for the other start, the same consent is still a's.
    expect(gate("plugin-child:b", { key: "plugin-child:b", identity: ID, consent: a.consent })).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    // A crossing that is not the spawn leaves it live for its own start.
    expect(gate("plugin-child:a", a)).toBe("started");
    expect(gate("plugin-child:b", { key: "plugin-child:b", identity: ID, consent: a.consent }, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(gate("plugin-child:a", a)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
  });

  it("starts a waiting start with no card once a backend confines it, declined or not", async () => {
    const asker = fakeAsker(["no"]);
    setExtensionStartAsker(asker);
    let ready = false;
    const taken: unknown[] = [];
    const waiting = (key: string): PendingExtensionStart => ({ ...start(key, async () => { taken.push(key, takeExtensionStartGrant(key)); }),
      recheck: () => ready ? "confined" : "no-backend" });
    deferExtensionStart(waiting("plugin-child:a"));
    await settlePendingExtensionStarts(ATTENDED);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "plugin-child:a", state: "declined" }]);
    deferExtensionStart(waiting("mcp-stdio:b"));
    ready = true;
    await settlePendingExtensionStarts(HEADLESS);
    expect(taken).toEqual(["plugin-child:a", undefined, "mcp-stdio:b", undefined]);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.notify).toHaveBeenCalledTimes(1);
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("shows no card for a start the gate now refuses outright, and asks with the cause it has now", async () => {
    const asker = fakeAsker(["no"]);
    setExtensionStartAsker(asker);
    let now: "refused" | "home-privacy-unverified" = "refused";
    deferExtensionStart({ ...start("plugin-child:a"), recheck: () => now });
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(listPendingExtensionStarts()).toMatchObject([{ state: "pending" }]);
    now = "home-privacy-unverified";
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask.mock.calls[0]?.[0]).toMatchObject([{ key: "plugin-child:a", cause: "home-privacy-unverified" }]);
  });

  it("keeps a start waiting when nobody answered its card, and asks again at the next turn", async () => {
    const asker = fakeAsker(["no-approver", "no"]);
    setExtensionStartAsker(asker);
    deferExtensionStart(start("plugin-child:a"));
    await settlePendingExtensionStarts(ATTENDED);
    expect(listPendingExtensionStarts()).toMatchObject([{ state: "pending" }]);
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(2);
    expect(listPendingExtensionStarts()).toMatchObject([{ state: "declined" }]);
    // The unanswered card and the real no each get their own notice.
    expect(asker.notify.mock.calls.map(([, why]) => why)).toEqual(["unattended", "declined"]);
  });

  it("lets a no for a session-bound start cover that run only, without touching a declined waiting start", async () => {
    const asker = fakeAsker(["no", "no", "yes"]);
    setExtensionStartAsker(asker);
    deferExtensionStart(start("worker:p/w"));
    await settlePendingExtensionStarts(ATTENDED);
    await expect(requestExtensionStartConsent(start("worker:p/w"), ATTENDED)).resolves.toBeUndefined();
    const authority = await requestExtensionStartConsent(start("worker:p/w"), ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(3);
    expect(gate("worker:p/w", authority, true)).toBe("started");
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "worker:p/w", state: "declined" }]);
  });

  it("forgets a removed extension's starts: a card still open cannot start it", async () => {
    let answerCard: () => void = () => {};
    const ask = vi.fn<ExtensionStartAsker["ask"]>(async (starts) => {
      await new Promise<void>((resolve) => { answerCard = resolve; });
      return new Map(starts.map((asked) => [asked.key, "yes"]));
    });
    setExtensionStartAsker({ ask, notify: vi.fn() });
    const retried: string[] = [];
    const keys = ["plugin-child:p", "worker:p/w", "plugin-hook:p/h", "plugin-child:pp", "mcp-stdio:p"];
    for (const key of keys) deferExtensionStart(start(key, async () => { retried.push(key); }));
    const settling = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0]?.[0].map((asked) => asked.key)).toEqual(keys);
    dropPluginExtensionStarts("p");
    dropExtensionStart("mcp-stdio:p");
    expect(listPendingExtensionStarts().map((entry) => entry.key)).toEqual(["plugin-child:pp"]);
    // Every row is answered yes; only the start that is still there runs.
    answerCard();
    await settling;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(retried).toEqual(["plugin-child:pp"]);
    for (const key of keys) expect(takeExtensionStartGrant(key)).toBeUndefined();
  });

  it("expires the consent of a start with no retry when its owner does not start in time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      setExtensionStartAsker(fakeAsker(["yes", "yes"]));
      deferExtensionStart(start("worker:p/w"));
      await settlePendingExtensionStarts(ATTENDED);
      vi.advanceTimersByTime(EXTENSION_START_GRANT_TTL_MS - 1);
      expect(gate("worker:p/w", takeExtensionStartGrant("worker:p/w"), true)).toBe("started");
      deferExtensionStart(start("worker:p/w"));
      await settlePendingExtensionStarts(ATTENDED);
      vi.advanceTimersByTime(EXTENSION_START_GRANT_TTL_MS);
      expect(takeExtensionStartGrant("worker:p/w")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a waiting start, a start nobody could answer and a declined one, including starts deferred before the sink was set", async () => {
    deferExtensionStart(start("plugin-child:early"));
    const record = vi.fn();
    setExtensionStartAsker({ ...fakeAsker(["no"]), record });
    deferExtensionStart({ ...start("mcp-stdio:b"), cause: "home-privacy-unverified" });
    expect(record.mock.calls.map(([event, entry]) => [event, entry.key, entry.cause])).toEqual([
      ["waiting", "plugin-child:early", "no-backend"], ["waiting", "mcp-stdio:b", "home-privacy-unverified"]]);
    record.mockClear();
    await settlePendingExtensionStarts(HEADLESS);
    await settlePendingExtensionStarts(HEADLESS);
    expect(record.mock.calls.map(([event, entry]) => [event, entry.key])).toEqual([["unattended", "plugin-child:early"], ["unattended", "mcp-stdio:b"]]);
    record.mockClear();
    await settlePendingExtensionStarts(ATTENDED);
    expect(record.mock.calls.map(([event, entry]) => [event, entry.key])).toContainEqual(["declined", "plugin-child:early"]);
  });

  it("cannot publish a checking plan, so no start meets one", () => {
    const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: { state: "available" },
      extensionMxc: { state: "unavailable", reason: "runtime-start-failed" }, windowsBuild: null, srtWinReady: false });
    expect(() => setWindowsSandboxSubstrate({ ...substrate, extensionPlan: { ...substrate.extensionPlan, readiness: "checking", reason: "checking" } as NonNullable<typeof substrate.extensionPlan> }))
      .toThrow("cannot be published");
  });

  it("does not ask when the user turned extension isolation off", () => {
    setPluginWorkerConfinementRequestedAtBoot(false);
    expect(gate("plugin-child:a", undefined, true)).toBe("started");
  });

  it("asks per start under an unverified home, and refuses outright when the privacy helper gave no answer", async () => {
    setExtensionStartAsker(fakeAsker(["yes"]));
    _resetAveHomePrivacyForTest();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, category: "read-back-failed", reason: "fixture" });
    try {
      assertExtensionStartAllowed();
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: EXTENSION_START_CONSENT_REQUIRED_CODE, unconfinedCause: "home-privacy-unverified" });
    }
    const authority = await requestExtensionStartConsent({ ...start("plugin-child:a"), cause: "home-privacy-unverified" }, ATTENDED);
    _resetAveHomePrivacyForTest();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, category: "helper-unavailable", reason: "fixture" });
    expect(gate("plugin-child:a", authority, true)).toBe("refused:Error");
  });
});

/** An asker whose card stays open until the test answers it. */
function heldAsker() {
  const cards: { keys: string[]; answer: (answers: Record<string, "yes" | "no">) => void }[] = [];
  const ask = vi.fn<ExtensionStartAsker["ask"]>((starts) => new Promise((resolve) => {
    cards.push({ keys: starts.map((asked) => asked.key), answer: (answers) => resolve(new Map(Object.entries(answers))) });
  }));
  return { cards, ask, notify: vi.fn<ExtensionStartAsker["notify"]>() };
}

describe("one card for every waiting start", () => {
  it("lists three waiting starts on one card and starts exactly the two that got a yes, each once", async () => {
    const asker = fakeAsker(["yes", "no", "yes"]);
    setExtensionStartAsker(asker);
    const spawned: string[] = [];
    const keys = ["plugin-child:a", "mcp-stdio:b", "plugin-child:c"];
    for (const key of keys) deferExtensionStart(start(key, async () => { spawned.push(`${key} ${gate(key, takeExtensionStartGrant(key), true)}`); }));
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.ask.mock.calls[0]?.[0].map((asked) => asked.key)).toEqual(keys);
    expect(spawned).toEqual(["plugin-child:a started", "plugin-child:c started"]);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "mcp-stdio:b", state: "declined" }]);
    expect(asker.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "mcp-stdio:b" }), "declined");
    // Nothing is left over: no consent waits for a later start and the next turn asks about none of them.
    for (const key of keys) expect(gate(key, takeExtensionStartGrant(key), true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(2);
  });

  it("keeps the starts that need a person on one card when a confined start waits between them", async () => {
    const asker = fakeAsker(["yes", "yes"]);
    setExtensionStartAsker(asker);
    const ran: string[] = [];
    const waiting = (key: string, now: "confined" | "no-backend"): PendingExtensionStart =>
      ({ ...start(key, async () => { ran.push(`${key} ${takeExtensionStartGrant(key) === undefined ? "confined" : "consent"}`); }), recheck: () => now });
    deferExtensionStart(waiting("plugin-child:a", "no-backend"));
    deferExtensionStart(waiting("mcp-stdio:b", "confined"));
    deferExtensionStart(waiting("plugin-child:c", "no-backend"));
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.ask.mock.calls[0]?.[0].map((asked) => asked.key)).toEqual(["plugin-child:a", "plugin-child:c"]);
    expect(ran).toEqual(["mcp-stdio:b confined", "plugin-child:a consent", "plugin-child:c consent"]);
    expect(listPendingExtensionStarts()).toEqual([]);
  });

  it("gives a start the card did not answer no consent, even when the others got a yes", async () => {
    const asker = { ask: vi.fn<ExtensionStartAsker["ask"]>(async () => new Map([["plugin-child:a", "yes" as const], ["plugin-child:zz", "yes" as const]])), notify: vi.fn() };
    setExtensionStartAsker(asker);
    const spawned: string[] = [];
    for (const key of ["plugin-child:a", "plugin-child:b"]) deferExtensionStart(start(key, async () => { spawned.push(key); }));
    await settlePendingExtensionStarts(ATTENDED);
    expect(spawned).toEqual(["plugin-child:a"]);
    expect(takeExtensionStartGrant("plugin-child:b")).toBeUndefined();
    expect(takeExtensionStartGrant("plugin-child:zz")).toBeUndefined();
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "plugin-child:b", state: "pending" }]);
  });

  it("does not start on a yes when what the start runs changed after the card was shown", async () => {
    const asker = heldAsker();
    setExtensionStartAsker(asker);
    let manifest = { version: "1.0.0", entry: "dist/index.js" };
    const outcomes: string[] = [];
    const key = "plugin-child:a";
    deferExtensionStart({ ...start(key, async () => {
      outcomes.push(gate(key, takeExtensionStartGrant(key), true, extensionStartIdentity(manifest)));
    }), identity: extensionStartIdentity(manifest) });
    const settling = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(asker.cards).toHaveLength(1));
    manifest = { version: "1.0.0", entry: "dist/other.js" };
    asker.cards[0]?.answer({ [key]: "yes" });
    await settling;
    expect(outcomes).toEqual([EXTENSION_START_CONSENT_REQUIRED_CODE]);
    // The refused presentation spent the old yes: it cannot start the old identity either.
    expect(takeExtensionStartGrant(key)).toBeUndefined();
  });

  it("voids an open card's yes when the same extension waits again as another start, and asks about the new one", async () => {
    const asker = heldAsker();
    setExtensionStartAsker(asker);
    const key = "plugin-child:a";
    const started: string[] = [];
    const version = (identity: string): PendingExtensionStart => ({ ...start(key, async () => {
      started.push(`${identity} ${gate(key, takeExtensionStartGrant(key), true, identity)}`);
    }), identity });
    deferExtensionStart(version("v1"));
    const first = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(asker.cards).toHaveLength(1));
    deferExtensionStart(version("v2"));
    asker.cards[0]?.answer({ [key]: "yes" });
    await first;
    expect(started).toEqual([]);
    expect(listPendingExtensionStarts()).toMatchObject([{ key, identity: "v2", state: "pending" }]);
    const second = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(asker.cards).toHaveLength(2));
    asker.cards[1]?.answer({ [key]: "yes" });
    await second;
    expect(started).toEqual(["v2 started"]);
  });

  it("clears an earlier yes and an earlier no when the start comes back with another identity", async () => {
    const asker = fakeAsker(["yes", "no", "yes"]);
    setExtensionStartAsker(asker);
    const waiting = (key: string, identity: string): PendingExtensionStart => ({ ...start(key), identity });
    deferExtensionStart(waiting("worker:p/w", "v1"));
    deferExtensionStart(waiting("mcp-stdio:b", "v1"));
    await settlePendingExtensionStarts(ATTENDED);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "mcp-stdio:b", state: "declined" }]);
    // The worker's yes waits for its owner's next start; the server's no stands. Both are for v1 only.
    deferExtensionStart(waiting("worker:p/w", "v2"));
    deferExtensionStart(waiting("mcp-stdio:b", "v2"));
    expect(takeExtensionStartGrant("worker:p/w")).toBeUndefined();
    expect(listPendingExtensionStarts()).toMatchObject([
      { key: "worker:p/w", identity: "v2", state: "pending" }, { key: "mcp-stdio:b", identity: "v2", state: "pending" }]);
    // The same identity again changes nothing: a no stays a no.
    await settlePendingExtensionStarts(ATTENDED);
    deferExtensionStart(waiting("mcp-stdio:b", "v2"));
    expect(listPendingExtensionStarts().find((entry) => entry.key === "mcp-stdio:b")).toMatchObject({ identity: "v2", state: "declined" });
  });

  it("starts none of several waiting starts in a headless session, with one notice each and no card", async () => {
    const asker = fakeAsker(["yes", "yes", "yes"]);
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    const keys = ["plugin-child:a", "mcp-stdio:b", "plugin-child:c"];
    for (const key of keys) deferExtensionStart(start(key, retry));
    await settlePendingExtensionStarts(HEADLESS);
    await settlePendingExtensionStarts(HEADLESS);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(asker.notify.mock.calls.map(([entry, why]) => [entry.key, why])).toEqual(keys.map((key) => [key, "unattended"]));
    for (const key of keys) expect(takeExtensionStartGrant(key)).toBeUndefined();
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("shows a start that arrives while a card is open on the next card, never on the open one", async () => {
    const asker = heldAsker();
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart(start("plugin-child:a", retry));
    const settling = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(asker.cards).toHaveLength(1));
    // Two starts ask while the first card is open: a hook and a worker of the same session.
    const hook = requestExtensionStartConsent(start("plugin-hook:p/h"), ATTENDED);
    const worker = requestExtensionStartConsent(start("worker:p/w"), ATTENDED);
    await Promise.resolve();
    expect(asker.cards.map((card) => card.keys)).toEqual([["plugin-child:a"]]);
    asker.cards[0]?.answer({ "plugin-child:a": "yes", "plugin-hook:p/h": "yes", "worker:p/w": "yes" });
    await settling;
    expect(retry).toHaveBeenCalledTimes(1);
    // The late arrivals were not answered by the first card; they share the second.
    await vi.waitFor(() => expect(asker.cards).toHaveLength(2));
    expect(asker.cards[1]?.keys).toEqual(["plugin-hook:p/h", "worker:p/w"]);
    asker.cards[1]?.answer({ "plugin-hook:p/h": "no", "worker:p/w": "yes" });
    expect(await hook).toBeUndefined();
    expect(gate("worker:p/w", await worker, true)).toBe("started");
  });

  it("does not make another session wait behind an open card", async () => {
    const asker = heldAsker();
    setExtensionStartAsker(asker);
    const first = requestExtensionStartConsent(start("plugin-hook:p/h"), ATTENDED);
    const other = requestExtensionStartConsent(start("plugin-hook:q/h"), { sessionId: "s2", attended: true });
    await vi.waitFor(() => expect(asker.cards).toHaveLength(2));
    expect(asker.ask.mock.calls.map(([, session]) => session.sessionId)).toEqual(["s1", "s2"]);
    asker.cards[1]?.answer({ "plugin-hook:q/h": "yes" });
    expect(gate("plugin-hook:q/h", await other, true)).toBe("started");
    asker.cards[0]?.answer({ "plugin-hook:p/h": "no" });
    expect(await first).toBeUndefined();
  });

  it("treats a start cancelled while its card was open as unanswered and leaves the card to the others", async () => {
    const asker = heldAsker();
    setExtensionStartAsker(asker);
    const cancelled = new AbortController();
    const hook = requestExtensionStartConsent(start("plugin-hook:p/h"), { ...ATTENDED, abortSignal: cancelled.signal });
    const worker = requestExtensionStartConsent(start("worker:p/w"), { ...ATTENDED, abortSignal: new AbortController().signal });
    await vi.waitFor(() => expect(asker.cards).toHaveLength(1));
    expect(asker.cards[0]?.keys).toEqual(["plugin-hook:p/h", "worker:p/w"]);
    cancelled.abort();
    // The card is withdrawn only when every start on it was cancelled.
    expect(asker.ask.mock.calls[0]?.[1].abortSignal?.aborted).toBe(false);
    asker.cards[0]?.answer({ "plugin-hook:p/h": "yes", "worker:p/w": "yes" });
    expect(await hook).toBeUndefined();
    expect(gate("worker:p/w", await worker, true)).toBe("started");
  });

  it("burns a yes whose start was removed while an earlier start on the same card was still starting", async () => {
    const asker = fakeAsker(["yes", "yes"]);
    setExtensionStartAsker(asker);
    const started: string[] = [];
    deferExtensionStart(start("plugin-child:a", async () => { dropExtensionStart("mcp-stdio:b"); started.push("plugin-child:a"); }));
    deferExtensionStart(start("mcp-stdio:b", async () => { started.push(`mcp-stdio:b ${gate("mcp-stdio:b", takeExtensionStartGrant("mcp-stdio:b"), true)}`); }));
    await settlePendingExtensionStarts(ATTENDED);
    expect(started).toEqual(["plugin-child:a"]);
    expect(takeExtensionStartGrant("mcp-stdio:b")).toBeUndefined();
  });
});

describe("the removed Settings approval", () => {
  it("has no channel, no approve path and no stored value to read", () => {
    expect(Object.keys(PERMISSIONS)).not.toContain("approveExtensionsWithoutIsolation");
    expect(Object.keys(aveHome).filter((name) => /WithoutIsolation/u.test(name))).toEqual([]);
  });
});
