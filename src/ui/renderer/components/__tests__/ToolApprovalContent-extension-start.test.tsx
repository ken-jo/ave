// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";
import { useApproval } from "../../hooks/use-approval.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";

afterEach(() => vi.unstubAllGlobals());

const ROWS = [
  { id: "row-1", label: "Notes (notes)", kind: "plugin-child", cause: "no-backend" },
  { id: "row-2", label: "files", kind: "mcp-stdio", cause: "no-backend" },
  { id: "row-3", label: "Notes (notes) / index", kind: "worker", cause: "home-privacy-unverified" },
] as const;

function request(starts: readonly unknown[] = ROWS, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "starts-card", category: "tool", kind: "extension-start", toolName: "extension_start", sessionId: "conversation",
    args: { isolation: "none", starts }, reason: "3 extension starts would run without OS isolation", createdAt: Date.now(), requireExplicit: true,
    exactRecordAllowed: false, persistentAllowAllowed: false, allowedChoices: ["allow-once", "deny-once"], ...overrides,
  };
}

const rows = () => screen.getAllByTestId("extension-start-row");
function row(index: number): HTMLElement {
  const found = rows()[index];
  if (found === undefined) throw new Error(`the card has no row ${index}`);
  return found;
}
const choose = (index: number, choice: "allow" | "deny") => fireEvent.click(within(row(index)).getByTestId(`extension-start-${choice}`));

describe("the shared extension-start approval card", () => {
  it("lists every waiting start with its own allow and deny, and offers no shared decision bar", () => {
    const decide = vi.fn();
    renderApproval(request(), decide);
    expect(screen.getByTestId("extension-start-approval-card")).toBeInTheDocument();
    expect(rows().map((row) => within(row).getByTestId("extension-start-label").textContent)).toEqual(ROWS.map((row) => row.label));
    expect(rows().map((row) => row.dataset.extensionStartKind)).toEqual(["plugin-child", "mcp-stdio", "worker"]);
    for (const row of rows()) {
      expect(within(row).getByTestId("extension-start-allow")).toHaveAttribute("aria-pressed", "false");
      expect(within(row).getByTestId("extension-start-deny")).toHaveAttribute("aria-pressed", "false");
    }
    expect(within(row(2)).getByText(new RegExp(t("extensionStartCard.causeHomePrivacy")))).toBeInTheDocument();
    expect(screen.queryByTestId("approval-decision-bar")).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("sends nothing until every start has its own answer, then sends each one", () => {
    const decide = vi.fn();
    renderApproval(request(), decide);
    const confirm = screen.getByTestId("extension-start-confirm");
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId("extension-start-incomplete")).toBeInTheDocument();
    choose(0, "allow");
    choose(1, "deny");
    fireEvent.click(confirm);
    expect(decide).not.toHaveBeenCalled();
    choose(2, "deny");
    // An answer can be changed until the card is confirmed.
    choose(2, "allow");
    expect(rows().map((row) => row.dataset.extensionStartChoice)).toEqual(["yes", "no", "yes"]);
    expect(screen.queryByTestId("extension-start-incomplete")).toBeNull();
    fireEvent.click(confirm);
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { extensionStartChoices: { "row-1": "yes", "row-2": "no", "row-3": "yes" } });
    // One answer per card: a second click, or a late change, sends nothing more.
    fireEvent.click(confirm);
    choose(1, "allow");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("sends a deny carrying every no when no start was allowed", () => {
    const decide = vi.fn();
    renderApproval(request(), decide);
    for (const index of [0, 1, 2]) choose(index, "deny");
    fireEvent.click(screen.getByTestId("extension-start-confirm"));
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once", undefined, { extensionStartChoices: { "row-1": "no", "row-2": "no", "row-3": "no" } });
  });

  it.each(["button", "escape"] as const)("starts nothing when the card is dismissed by %s, whatever was already picked", (method) => {
    const decide = vi.fn();
    renderApproval(request(), decide);
    choose(0, "allow");
    if (method === "button") fireEvent.click(screen.getByTestId("extension-start-deny-all"));
    else fireEvent.keyDown(screen.getByTestId("tool-approval-panel"), { key: "Escape" });
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once");
  });

  it("forwards each start's answer through the real approval queue with the card's signature", async () => {
    const card = request(ROWS, { nonce: "native-nonce", hmac: "native-hmac" });
    const respond = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("ave", { approval: { onRequest: vi.fn(() => () => {}), onSettled: vi.fn(() => () => {}), listPending: vi.fn(async () => [card]), respond } });
    const hook = renderHook(useApproval);
    await waitFor(() => expect(hook.result.current.queue).toHaveLength(1));
    const extensionStartChoices = { "row-1": "yes", "row-2": "no", "row-3": "yes" } as const;
    await act(async () => { await hook.result.current.decide(card.id, "allow-once", undefined, { extensionStartChoices }); });
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: card.id, choice: "allow-once", extensionStartChoices, nonce: card.nonce, hmac: card.hmac }));
    hook.unmount();
  });

  it("shows a row another surface already answered as answered and locked, and confirms only the rest", () => {
    const decide = vi.fn();
    const shown = renderApproval(request(ROWS, { extensionStartAnswered: { "row-1": "yes", "row-2": "no" } }), decide);
    expect(rows().map((item) => item.dataset.extensionStartChoice)).toEqual(["yes", "no", "none"]);
    expect(rows().map((item) => item.dataset.extensionStartAnswered)).toEqual(["remote", "remote", "none"]);
    expect(within(row(0)).getByTestId("extension-start-answered")).toHaveTextContent(`${t("extensionStartCard.answeredAllowed")} · ${t("extensionStartCard.answeredRemotely")}`);
    expect(within(row(1)).getByTestId("extension-start-answered")).toHaveTextContent(`${t("extensionStartCard.answeredDenied")} · ${t("extensionStartCard.answeredRemotely")}`);
    // An answered row offers no choice: its first answer stands.
    for (const index of [0, 1]) {
      expect(within(row(index)).queryByTestId("extension-start-allow")).toBeNull();
      expect(within(row(index)).queryByTestId("extension-start-deny")).toBeNull();
    }
    const confirm = screen.getByTestId("extension-start-confirm");
    expect(confirm).toBeDisabled();
    choose(2, "deny");
    fireEvent.click(confirm);
    // The answered rows go back as they were answered; the pick decides the row that was left.
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { extensionStartChoices: { "row-1": "yes", "row-2": "no", "row-3": "no" } });
    shown.unmount();
  });

  it("says dismissing leaves the rest unstarted once a row was answered elsewhere, since that row's answer stands", () => {
    const decide = vi.fn();
    const shown = renderApproval(request(), decide);
    expect(screen.getByTestId("extension-start-deny-all")).toHaveTextContent(t("extensionStartCard.denyAll"));
    shown.rerender(<ToolApprovalContent conversationLabel="conversation" open request={request(ROWS, { extensionStartAnswered: { "row-1": "yes" } })} onDecide={decide} />);
    expect(screen.getByTestId("extension-start-deny-all")).toHaveTextContent(t("extensionStartCard.denyRest"));
    expect(t("extensionStartCard.denyRest")).not.toBe(t("extensionStartCard.denyAll"));
    expect(ko["extensionStartCard.denyRest"]).not.toBe(ko["extensionStartCard.denyAll"]);
    fireEvent.click(screen.getByTestId("extension-start-deny-all"));
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once");
    shown.unmount();
  });

  it("drops a pick for a row that another surface answers while the card is open", () => {
    const decide = vi.fn();
    const shown = renderApproval(request(), decide);
    choose(0, "allow");
    choose(1, "allow");
    choose(2, "allow");
    shown.rerender(<ToolApprovalContent conversationLabel="conversation" open request={request(ROWS, { extensionStartAnswered: { "row-1": "no" } })} onDecide={decide} />);
    expect(rows().map((item) => item.dataset.extensionStartChoice)).toEqual(["no", "yes", "yes"]);
    fireEvent.click(screen.getByTestId("extension-start-confirm"));
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { extensionStartChoices: { "row-1": "no", "row-2": "yes", "row-3": "yes" } });
    shown.unmount();
  });

  it("takes a card update for a request it holds in place, without a second card or a second alert", async () => {
    const card = request(ROWS, { nonce: "native-nonce", hmac: "native-hmac" });
    let deliver: (req: ApprovalRequest) => void = () => {};
    vi.stubGlobal("ave", { approval: { onRequest: vi.fn((cb: (req: ApprovalRequest) => void) => { deliver = cb; return () => {}; }), onSettled: vi.fn(() => () => {}),
      listPending: vi.fn(async () => [card]), respond: vi.fn(async () => ({ ok: true })) } });
    const hook = renderHook(useApproval);
    await waitFor(() => expect(hook.result.current.queue).toHaveLength(1));
    act(() => deliver({ ...card, extensionStartAnswered: { "row-2": "yes" } }));
    expect(hook.result.current.queue).toHaveLength(1);
    expect(hook.result.current.queue[0]).toMatchObject({ id: card.id, extensionStartAnswered: { "row-2": "yes" } });
    // An update for a card this window does not hold shows nothing.
    act(() => deliver({ ...card, id: "another-card", extensionStartAnswered: { "row-2": "yes" } }));
    expect(hook.result.current.queue.map((held) => held.id)).toEqual([card.id]);
    hook.unmount();
  });

  it("shows one start the same way", () => {
    const decide = vi.fn();
    renderApproval(request([ROWS[1]]), decide);
    expect(rows()).toHaveLength(1);
    choose(0, "allow");
    fireEvent.click(screen.getByTestId("extension-start-confirm"));
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { extensionStartChoices: { "row-2": "yes" } });
  });

  it("can only refuse a request whose list of starts is missing or malformed", () => {
    for (const starts of [[], [{ ...ROWS[0] }, { ...ROWS[0] }], [{ id: "row-1", label: "x", kind: "shell", cause: "no-backend" }]]) {
      const decide = vi.fn();
      const shown = renderApproval(request(starts), decide);
      expect(screen.getByRole("alert")).toHaveTextContent(t("extensionStartCard.invalid"));
      expect(screen.queryByTestId("extension-start-confirm")).toBeNull();
      expect(screen.queryByTestId("extension-start-allow")).toBeNull();
      fireEvent.click(screen.getByTestId("extension-start-deny-all"));
      expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once");
      shown.unmount();
    }
  });

  it("reveals hidden characters in a name an extension chose for itself", () => {
    renderApproval(request([{ ...ROWS[0], label: "safe\u202Eevil" }]), vi.fn());
    expect(within(row(0)).getByTestId("extension-start-label").textContent).not.toContain("\u202E");
  });

  it("has every card string in both languages", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("extensionStartCard.") || key === "extensionStart.cardBatch");
    expect(keys).toHaveLength(19);
    for (const key of keys) {
      expect(ko[key as keyof typeof ko], key).toEqual(expect.any(String));
      expect(ko[key as keyof typeof ko], key).not.toBe("");
    }
    expect(Object.keys(ko).filter((key) => key.startsWith("extensionStartCard.")).sort()).toEqual(keys.filter((key) => key.startsWith("extensionStartCard.")).sort());
  });
});
