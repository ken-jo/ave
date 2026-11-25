import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { planWindowsSandbox } from "../../boot/steps/windows-sandbox-plan.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import * as aveHome from "../../shared/ave-home.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { assertLocalEmbeddingRuntime } from "../../main/memory-map/local-runtime.js";
import { assertExtensionStartAllowed, probeExtensionStart } from "../asrt-sandbox.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, dropExtensionStart, dropPluginExtensionStarts, EXTENSION_START_CONSENT_REQUIRED_CODE, EXTENSION_START_GRANT_TTL_MS, ExtensionStartConsentRequiredError, listPendingExtensionStarts,
  requestExtensionStartConsent, runExtensionStart, setExtensionStartAsker, settlePendingExtensionStarts, takeExtensionStartGrant,
  type ExtensionStartAsker, type ExtensionStartAuthority, type PendingExtensionStart,
} from "../extension-start-consent.js";
import {
  __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest, getWindowsExtensionBackendPlan,
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

function gate(key: string, authority: ExtensionStartAuthority | undefined, spend = false): string {
  try {
    assertExtensionStartAllowed({ start: { key, authority, spend } });
    return "started";
  } catch (error) {
    return (error as { code?: string }).code ?? `refused:${(error as Error).name}`;
  }
}

function fakeAsker(answers: ("yes" | "no" | "no-approver")[]) {
  return { ask: vi.fn<ExtensionStartAsker["ask"]>(async () => answers.shift() ?? "no"), notify: vi.fn<ExtensionStartAsker["notify"]>() };
}

const start = (key: string, retry?: () => Promise<void>): PendingExtensionStart =>
  ({ key, kind: "plugin-child", label: key, cause: "no-backend", ...(retry ? { retry } : {}) });

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

  it("asks once per waiting start, starts each approved one with its own consent and spends it at the spawn", async () => {
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
    expect(asker.ask).toHaveBeenCalledTimes(2);
    expect(asker.ask.mock.calls.map(([asked]) => (asked as PendingExtensionStart).key)).toEqual(["plugin-child:a", "mcp-stdio:b"]);
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
    expect(gate("plugin-child:a", { key: "plugin-child:a", consent: {} as ExtensionStartAuthority["consent"] }, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
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
    const asker: ExtensionStartAsker = { ask: vi.fn(() => new Promise<"yes">((resolve) => { release = resolve; })), notify: vi.fn() };
    setExtensionStartAsker(asker);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart(start("plugin-child:a", retry));
    const first = settlePendingExtensionStarts(ATTENDED);
    const second = settlePendingExtensionStarts({ sessionId: "s2", attended: true });
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
    publish({ state: "unavailable", reason: "runtime-start-failed" }, "srt-win");
    expect(getWindowsExtensionBackendPlan()).toMatchObject({ readiness: "rejected", reason: "ancestor-already-admitted" });
    expect(gate("plugin-child:a", undefined)).toBe("extension-readiness-refused");
    expect(gate("plugin-child:a", authority, true)).toBe("extension-readiness-refused");
  });

  it("runs a session-bound start with the answer it asked for, and asks again for the next one", async () => {
    const asker = fakeAsker(["yes", "no"]);
    setExtensionStartAsker(asker);
    const run = vi.fn(async (authority: ExtensionStartAuthority | undefined) => {
      const outcome = gate("worker:p/w", authority, true);
      if (outcome !== "started") throw new ExtensionStartConsentRequiredError("no-backend");
      return outcome;
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
      const outcome = gate("worker:p/w", authority, true);
      if (outcome !== "started") throw new ExtensionStartConsentRequiredError("no-backend");
      return outcome;
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
    expect(gate("plugin-child:b", { key: "plugin-child:b", consent: a.consent })).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
    // A crossing that is not the spawn leaves it live for its own start.
    expect(gate("plugin-child:a", a)).toBe("started");
    expect(gate("plugin-child:b", { key: "plugin-child:b", consent: a.consent }, true)).toBe(EXTENSION_START_CONSENT_REQUIRED_CODE);
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
    expect(asker.ask.mock.calls[0]?.[0]).toMatchObject({ key: "plugin-child:a", cause: "home-privacy-unverified" });
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
    let answerCard: (answer: "yes") => void = () => {};
    const ask = vi.fn<ExtensionStartAsker["ask"]>(() => new Promise((resolve) => { answerCard = resolve; }));
    setExtensionStartAsker({ ask, notify: vi.fn() });
    const retry = vi.fn(async () => {});
    for (const key of ["plugin-child:p", "worker:p/w", "plugin-hook:p/h", "plugin-child:pp", "mcp-stdio:p"]) deferExtensionStart(start(key, retry));
    const settling = settlePendingExtensionStarts(ATTENDED);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    dropPluginExtensionStarts("p");
    dropExtensionStart("mcp-stdio:p");
    expect(listPendingExtensionStarts().map((entry) => entry.key)).toEqual(["plugin-child:pp"]);
    answerCard("yes");
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[1]?.[0]).toMatchObject({ key: "plugin-child:pp" });
    expect(retry).not.toHaveBeenCalled();
    expect(takeExtensionStartGrant("plugin-child:p")).toBeUndefined();
    answerCard("yes");
    await settling;
    expect(retry).toHaveBeenCalledTimes(1);
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

describe("extension start after the backend readiness deadline expired", () => {
  const KEY = "plugin-child:a";
  const pending = { key: KEY, kind: "plugin-child" as const, label: "a" };
  const spawn = async (authority: ExtensionStartAuthority | undefined): Promise<string> => {
    assertExtensionStartAllowed({ start: { key: KEY, authority, spend: true } });
    return "started";
  };
  const deadline = { code: EXTENSION_START_CONSENT_REQUIRED_CODE, unconfinedCause: "readiness-deadline" };

  beforeEach(() => {
    __resetWindowsSandboxSubstrateForTest();
    publish({ state: "unavailable", reason: "readiness-deadline" });
  });

  it("is the no-backend plan with its own reason, and every other no-backend start keeps its cause", () => {
    expect(getWindowsExtensionBackendPlan()).toMatchObject({ selectedBackend: "none", readiness: "unavailable", reason: "readiness-deadline" });
    expect(probeExtensionStart()).toBe("readiness-deadline");
    __resetWindowsSandboxSubstrateForTest();
    publish({ state: "unavailable", reason: "runtime-start-failed" });
    expect(probeExtensionStart()).toBe("no-backend");
  });

  it("waits with the readiness reason, starts once on a yes and needs a new yes for the next start", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    await expect(runExtensionStart(pending, undefined, spawn)).rejects.toMatchObject(deadline);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: KEY, cause: "readiness-deadline", state: "pending" }]);
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.ask).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, cause: "readiness-deadline" }), ATTENDED);
    await expect(runExtensionStart(pending, undefined, spawn)).resolves.toBe("started");
    // The consent was spent at that spawn: the next start waits for its own answer.
    await expect(runExtensionStart(pending, undefined, spawn)).rejects.toMatchObject(deadline);
    expect(asker.ask).toHaveBeenCalledTimes(1);
    expect(asker.notify).not.toHaveBeenCalled();
  });

  it("is denied headless: left unstarted with one notice that carries the readiness reason", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    await expect(runExtensionStart(pending, undefined, spawn)).rejects.toMatchObject(deadline);
    await settlePendingExtensionStarts(HEADLESS);
    await settlePendingExtensionStarts(HEADLESS);
    await expect(runExtensionStart(pending, HEADLESS, spawn)).rejects.toMatchObject(deadline);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(asker.notify).toHaveBeenCalledTimes(1);
    expect(asker.notify).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, cause: "readiness-deadline" }), "unattended");
    expect(takeExtensionStartGrant(KEY)).toBeUndefined();
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending"]);
  });

  it("offers no consent while the privacy helper is unavailable: the helper deny wins", async () => {
    const asker = fakeAsker(["yes"]);
    setExtensionStartAsker(asker);
    _resetAveHomePrivacyForTest();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, category: "helper-unavailable", reason: "fixture" });
    expect(gate(KEY, undefined, true)).toBe("refused:Error");
    expect(probeExtensionStart()).toBe("refused");
    await expect(runExtensionStart(pending, ATTENDED, spawn)).rejects.toThrow(/helper-unavailable/u);
    const retry = vi.fn(async () => undefined);
    deferExtensionStart({ ...pending, cause: "readiness-deadline", retry, recheck: () => probeExtensionStart() });
    await settlePendingExtensionStarts(ATTENDED);
    expect(asker.ask).not.toHaveBeenCalled();
    expect(asker.notify).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("gives a start with no consent route no new way to run", () => {
    // The native entry needs a ready container, and local inference needs its offline sandbox: neither is asked about.
    expect(() => assertExtensionStartAllowed({ backend: "mxc" })).toThrow("Native extension backend is not ready for this start");
    expect(() => assertLocalEmbeddingRuntime()).toThrow("local-runtime-unavailable");
  });
});

describe("the removed Settings approval", () => {
  it("has no channel, no approve path and no stored value to read", () => {
    expect(Object.keys(PERMISSIONS)).not.toContain("approveExtensionsWithoutIsolation");
    expect(Object.keys(aveHome).filter((name) => /WithoutIsolation/u.test(name))).toEqual([]);
  });
});
