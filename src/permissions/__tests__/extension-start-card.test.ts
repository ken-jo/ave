// The shared extension-start card on the approval dock: the request the gate accepts, the answers it honours (one yes or no for
// exactly each start the card listed) and what reaches the starts.
import { afterEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_START_IDENTITY as ID } from "../../__tests__/support/approved-extension-start.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";
import { extensionStartApprovalRows, type ExtensionStartChoice } from "../../shared/permissions-events.js";
import { ApprovalGate, isHostApprovalRejectedDecision, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { createExtensionStartAsker } from "../extension-start-asker.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, listPendingExtensionStarts, presentExtensionStartConsent, setExtensionStartAsker,
  settlePendingExtensionStarts, takeExtensionStartGrant, type PendingExtensionStart,
} from "../extension-start-consent.js";

const SESSION = { sessionId: "session-1", attended: true };
const KEYS = ["plugin-child:a", "mcp-stdio:b", "plugin-child:c"];

function makeGate() {
  const wc = { send: vi.fn(), isDestroyed: vi.fn(() => false) };
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(wc as never, undefined, 5_000, auditLogger as never);
  const audit = () => auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
  return { wc, gate, audit };
}

async function cardSent(wc: ReturnType<typeof makeGate>["wc"], count = 1): Promise<ApprovalRequest> {
  await vi.waitFor(() => expect(sentApprovalCards(wc).length).toBe(count));
  const card = sentApprovalCards<ApprovalRequest>(wc).at(-1);
  if (card === undefined) throw new Error("no approval card was sent");
  return card;
}

/** Waiting starts whose retry is the spawn: it presents the consent parked for it and records whether the gate let it through. */
function waitingStarts(keys: readonly string[] = KEYS) {
  const notify = vi.fn();
  const spawned: string[] = [];
  const { wc, gate, audit } = makeGate();
  setExtensionStartAsker(createExtensionStartAsker({ approvalGate: gate, reason: (starts) => starts.map((start) => start.label).join(", "), notify }));
  for (const key of keys) {
    const start: PendingExtensionStart = { key, identity: ID, kind: "plugin-child", label: key, cause: "no-backend", retry: async () => {
      if (presentExtensionStartConsent({ key, identity: ID, authority: takeExtensionStartGrant(key), spend: true })) spawned.push(key);
    } };
    deferExtensionStart(start);
  }
  return { wc, gate, audit, notify, spawned };
}

const rowsOf = (card: ApprovalRequest) => extensionStartApprovalRows(card.args) ?? [];
const answers = (card: ApprovalRequest, choices: readonly ExtensionStartChoice[]): Record<string, ExtensionStartChoice> =>
  Object.fromEntries(rowsOf(card).map((row, index) => [row.id, choices[index] ?? "no"]));

afterEach(() => __resetExtensionStartsForTest());

describe("the shared extension-start card", () => {
  it("shows three waiting starts as one card and starts exactly the two answered yes", async () => {
    const { wc, gate, spawned, notify } = waitingStarts();
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    expect(card).toMatchObject({ kind: "extension-start", toolName: "extension_start", sessionId: "session-1", requireExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
    expect(rowsOf(card).map((row) => row.label)).toEqual(KEYS);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", extensionStartChoices: answers(card, ["yes", "no", "yes"]), nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await settling;
    expect(sentApprovalCards(wc)).toHaveLength(1);
    expect(spawned).toEqual(["plugin-child:a", "plugin-child:c"]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "mcp-stdio:b" }), "declined");
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "mcp-stdio:b", state: "declined" }]);
  });

  it.each([
    ["an allow that names no start", () => undefined],
    ["answers for only some of the starts", (card: ApprovalRequest) => Object.fromEntries(Object.entries(answers(card, ["yes", "yes", "yes"])).slice(0, 2))],
    ["an answer for a start the card did not list", (card: ApprovalRequest) => ({ ...answers(card, ["yes", "yes", "yes"]), "plugin-child:zz": "yes" as const })],
    ["answers under other ids", () => ({ a: "yes" as const, b: "yes" as const, c: "yes" as const })],
    ["an allow whose answers are all no", (card: ApprovalRequest) => answers(card, ["no", "no", "no"])],
    ["an answer that is neither yes nor no", (card: ApprovalRequest) => ({ ...answers(card, ["yes", "yes", "yes"]), [rowsOf(card)[0]?.id ?? ""]: "always" as never })],
  ])("starts nothing on %s", async (_name, choices) => {
    const { wc, gate, spawned, audit } = waitingStarts();
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    const extensionStartChoices = choices(card);
    const decision = gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", ...(extensionStartChoices === undefined ? {} : { extensionStartChoices }), nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    expect(decision).toMatchObject({ choice: "deny-once" });
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    await settling;
    expect(spawned).toEqual([]);
    for (const key of KEYS) expect(takeExtensionStartGrant(key)).toBeUndefined();
    // Nobody answered: every start still waits for a person.
    expect(listPendingExtensionStarts().map((entry) => entry.state)).toEqual(["pending", "pending", "pending"]);
    expect(audit().some((row) => row.startsWith(`[approval:extension-start-answers-rejected] ${card.id}`))).toBe(true);
  });

  it("refuses a deny whose answers hold a yes", async () => {
    const { wc, gate, spawned } = waitingStarts();
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    const decision = gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "deny-once", extensionStartChoices: answers(card, ["yes", "no", "no"]), nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    await settling;
    expect(spawned).toEqual([]);
  });

  it("reads a dismissed card as a no for each start", async () => {
    const { wc, gate, spawned, notify } = waitingStarts();
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, wc as never);
    await settling;
    expect(spawned).toEqual([]);
    expect(notify.mock.calls.map(([start, why]) => [start.key, why])).toEqual(KEYS.map((key) => [key, "declined"]));
  });

  it("keeps a several-start card for the desktop when another surface says allow without per-start answers", async () => {
    const { wc, gate, spawned, audit } = waitingStarts();
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    expect(gate.resolve(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac })).toBeNull();
    expect(spawned).toEqual([]);
    expect(audit().some((row) => row.startsWith(`[approval:native-desktop-required] ${card.id}`))).toBe(true);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", extensionStartChoices: answers(card, ["no", "yes", "no"]), nonce: card.nonce, hmac: card.hmac,
    }, wc as never);
    await settling;
    expect(spawned).toEqual(["mcp-stdio:b"]);
  });

  it("lets one allow answer a card that lists one start, as before", async () => {
    const { wc, gate, spawned } = waitingStarts(["plugin-child:a"]);
    const settling = settlePendingExtensionStarts(SESSION);
    const card = await cardSent(wc);
    gate.resolve(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac });
    await settling;
    expect(spawned).toEqual(["plugin-child:a"]);
  });

  it("refuses per-start answers on a request that is not an extension-start card", async () => {
    const { wc, gate } = makeGate();
    const answer = gate.requestAndWait({ id: "tool-1", category: "tool", toolName: "write_file", args: { path: "a" }, reason: "r", createdAt: Date.now(), sessionId: "session-1" });
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", extensionStartChoices: { a: "yes" }, nonce: card.nonce, hmac: card.hmac }, wc as never);
    const decision = await answer;
    expect(decision.choice).toBe("deny-once");
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
  });

  it("accepts only a fully specified request", async () => {
    const { gate } = makeGate();
    const request = (overrides: Partial<ApprovalRequestInput>): ApprovalRequestInput => ({
      id: "x", category: "tool", kind: "extension-start", toolName: "extension_start", reason: "r", createdAt: Date.now(), sessionId: "session-1",
      args: { isolation: "none", starts: [{ id: "r1", label: "a", kind: "plugin-child", cause: "no-backend" }] },
      allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false, forceExplicit: true, ...overrides,
    });
    const row = { id: "r1", label: "a", kind: "plugin-child", cause: "no-backend" };
    for (const broken of [
      request({ args: { starts: [] } }), request({ args: { starts: [row, row] } }), request({ args: { starts: [{ ...row, kind: "shell" }] } }),
      request({ allowedChoices: ["allow-once", "allow-always", "deny-once"] }), request({ durableApprovalRecordAllowed: true }),
      (({ forceExplicit: _unforced, ...unforced }) => unforced)(request({})), request({ sessionId: undefined }),
    ]) await expect(gate.requestAndWait(broken)).rejects.toThrow("approval: an extension-start request");
  });
});
