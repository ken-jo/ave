// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { ApprovalSurfaceClaims, ApprovalSurfaceProvider, type ApprovalSurfaceContextValue } from "../../hooks/use-approval.js";
import { approvalsForDocks, TerminalEgressBanner } from "../permissions/TerminalEgressBanner.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import type { ApprovalRequest } from "../../types.js";
import { noteTerminalTabLabel } from "../../preview/terminal-tab-labels.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";

/** The labelled buttons of a row (the dropdown chevrons carry only an accessible name). */
const buttonLabels = (scope: HTMLElement) => within(scope).getAllByRole("button").map((button) => button.textContent).filter((text) => text !== "");

const TAB = "terminal:0a1b2c3d-1";
const OTHER_TAB = "terminal:0a1b2c3d-2";

function terminalAsk(id: string, overrides: Partial<NonNullable<ApprovalRequest["egressHost"]>> = {}, tabId = TAB): ApprovalRequest {
  return {
    id,
    category: "tool",
    kind: "egress-host",
    toolName: "terminal",
    args: { host: "github.com", port: 443, tabId },
    reason: `A command in workspace terminal ${tabId} wants to connect to github.com:443.`,
    createdAt: 0,
    allowedChoices: ["allow-once", "deny-once"],
    // Host rules are shell-origin: the host sends a terminal tab's ask with no rule to save.
    egressHost: { host: "github.com", port: 443, rule: null, network: "public", scopes: ["once", "tab", "always"], terminalTabId: tabId, ...overrides },
  } as unknown as ApprovalRequest;
}

const shellAsk: ApprovalRequest = {
  ...terminalAsk("shell-1"),
  toolName: "bash",
  sessionId: "session-1",
  egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", network: "public", scopes: ["once", "session", "project", "always"] },
} as ApprovalRequest;

function surface(queue: ApprovalRequest[], overrides: Partial<ApprovalSurfaceContextValue> = {}): ApprovalSurfaceContextValue {
  return {
    queue,
    decide: vi.fn(async () => {}),
    dropSettled: vi.fn(),
    claims: new ApprovalSurfaceClaims(),
    openPermanentDeny: vi.fn(),
    lockedRequestId: null,
    proposal: null,
    reviewerSuggestion: null,
    ...overrides,
  };
}

function withSurface(value: ApprovalSurfaceContextValue, element: ReactElement) {
  return render(<ApprovalSurfaceProvider value={value}>{element}</ApprovalSurfaceProvider>);
}

describe("TerminalEgressBanner", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  it("shows `<host>:<port> blocked` with the shared row (Deny, Allow for this tab, Allow once) and answers with the scope", () => {
    const value = surface([terminalAsk("ask-1")]);
    withSurface(value, <TerminalEgressBanner tabId={TAB} />);
    const banner = screen.getByRole("region", { name: "Network approval for this terminal" });
    expect(within(banner).getByTestId("terminal-egress-target").textContent).toBe("github.com:443 blocked");
    expect(buttonLabels(banner)).toEqual(["Deny", "Allow for this tab", "Allow once"]);
    expect(banner.textContent).toContain("denied after 2 minutes");
    expect(banner.textContent).toContain("Always grants can be revoked in Settings → Permissions → Network");
    fireEvent.click(within(banner).getByTestId(TEST_IDS.allowSessionButton));
    fireEvent.click(within(banner).getByTestId(TEST_IDS.denyButton));
    fireEvent.click(within(banner).getByTestId(TEST_IDS.approveButton));
    expect(vi.mocked(value.decide).mock.calls).toEqual([
      ["ask-1", "allow-once", undefined, { egressScope: "tab" }],
      ["ask-1", "deny-once"],
      ["ask-1", "allow-once", undefined, { egressScope: "once" }],
    ]);
  });

  it("offers Always but not This project in the allow dropdown, and no allow saves a rule", () => {
    const value = surface([terminalAsk("ask-1")]);
    withSurface(value, <TerminalEgressBanner tabId={TAB} />);
    const row = screen.getByTestId("terminal-egress-row");
    expect(openDecisionMenu("allow-project", row)).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-allow-session")).toHaveTextContent("Allow for this tab");
    expect(screen.getByTestId("approval-choice-allow-everywhere")).not.toHaveAttribute("data-disabled");
    fireEvent.keyDown(screen.getByTestId("approval-choice-allow-session"), { key: "Enter" });
    expect(within(row).queryByTestId("approval-edit-rule")).toBeNull();
    selectDecision("allow-everywhere", row);
    expect(within(row).queryByTestId("approval-edit-rule")).toBeNull();
    fireEvent.click(within(row).getByTestId(TEST_IDS.allowSessionButton));
    expect(vi.mocked(value.decide).mock.calls).toEqual([["ask-1", "allow-once", undefined, { egressScope: "always" }]]);
  });

  it("offers no Always deny: host rules decide the agent's commands, not a terminal tab", () => {
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    const value = surface([terminalAsk("ask-1")]);
    withSurface(value, <TerminalEgressBanner tabId={TAB} />);
    const row = screen.getByTestId("terminal-egress-row");
    expect(openDecisionMenu("deny-always", row)).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-deny-always-reason")).toHaveTextContent("Host rules apply to the agent's commands, not to a terminal tab.");
    expect(record).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // The banner's row is compact but never a fixed height: a wrapped label grows its button, and a narrow row stacks the buttons.
  it("lets compact buttons grow and stacks them when the row is narrow", () => {
    withSurface(surface([terminalAsk("ask-1")]), <TerminalEgressBanner tabId={TAB} />);
    const row = screen.getByTestId("terminal-egress-row");
    const bar = within(row).getByTestId("approval-decision-bar");
    expect(bar.className.split(/\s+/u)).toContain("@container");
    expect(within(row).getByTestId("approval-decision-actions").className).toContain("@max-[14rem]:grid-cols-1");
    for (const id of [TEST_IDS.denyButton, TEST_IDS.allowSessionButton, TEST_IDS.approveButton]) {
      const classes = within(row).getByTestId(id).className.split(/\s+/u);
      expect(classes).toContain("h-auto");
      expect(classes).toContain("min-h-7");
      expect(classes).toContain("whitespace-normal");
      expect(classes.filter((name) => /^h-\d/u.test(name))).toEqual([]);
    }
  });

  it("offers a local destination only Allow once and This tab, with the private-network warning", () => {
    withSurface(surface([terminalAsk("ask-1", { host: "127.0.0.1", port: 3000, network: "local", scopes: ["once", "tab"] })]),
      <TerminalEgressBanner tabId={TAB} />);
    expect(buttonLabels(document.body)).toEqual(["Deny", "Allow for this tab", "Allow once"]);
    openDecisionMenu("allow-everywhere");
    expect(screen.getByTestId("approval-choice-allow-everywhere")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-allow-project")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("terminal-egress-local-warning").textContent).toContain("private network");
    expect(screen.getByTestId("terminal-egress-local-warning").textContent).toContain("until this tab's shell exits");
    expect(screen.queryByTestId("terminal-egress-unverified-warning")).toBeNull();
    expect(screen.getByTestId("terminal-egress-banner").textContent).not.toContain("Settings → Permissions → Network");
  });

  it("says when the upstream proxy decides the address of an unverified destination", () => {
    withSurface(surface([terminalAsk("ask-1", { host: "intranet.corp.test", network: "unverified", scopes: ["once", "tab"] })]),
      <TerminalEgressBanner tabId={TAB} />);
    expect(screen.getByTestId("terminal-egress-unverified-warning").textContent).toContain("proxy server looks up this name");
    expect(buttonLabels(document.body)).toEqual(["Deny", "Allow for this tab", "Allow once"]);
  });

  it("stacks one row per destination of this tab, and draws neither another tab's asks nor a shell call's", () => {
    withSurface(surface([
      terminalAsk("ask-1"),
      shellAsk,
      terminalAsk("ask-2", { host: "registry.npmjs.org" }),
      terminalAsk("ask-3", {}, OTHER_TAB),
    ]), <TerminalEgressBanner tabId={TAB} />);
    expect(screen.getAllByTestId("terminal-egress-row").map((row) => row.getAttribute("data-approval-request-id")))
      .toEqual(["ask-1", "ask-2"]);
  });

  it("draws nothing when this tab has no ask, or outside the app's approval surface", () => {
    const { container } = withSurface(surface([shellAsk, terminalAsk("ask-3", {}, OTHER_TAB)]), <TerminalEgressBanner tabId={TAB} />);
    expect(container.textContent).toBe("");
    const bare = render(<TerminalEgressBanner tabId={TAB} />);
    expect(bare.container.textContent).toBe("");
  });

  it("Escape in an open dropdown of a row closes it and does not deny", () => {
    const value = surface([terminalAsk("ask-1")]);
    withSurface(value, <TerminalEgressBanner tabId={TAB} />);
    const item = openDecisionMenu("deny-always", screen.getByTestId("terminal-egress-row"));
    fireEvent.keyDown(item, { key: "Escape" });
    expect(value.decide).not.toHaveBeenCalled();
  });

  it("is keyboard operable: every action is a focusable button and Escape denies the focused row", () => {
    const value = surface([terminalAsk("ask-1"), terminalAsk("ask-2", { host: "registry.npmjs.org" })]);
    withSurface(value, <TerminalEgressBanner tabId={TAB} />);
    const second = screen.getAllByTestId("terminal-egress-row")[1]!;
    const allowOnce = within(second).getByTestId(TEST_IDS.approveButton);
    allowOnce.focus();
    expect(document.activeElement).toBe(allowOnce);
    expect(allowOnce.tagName).toBe("BUTTON");
    expect(second.getAttribute("role")).toBe("group");
    expect(second.getAttribute("aria-labelledby")).toBe("terminal-egress-ask-2");
    fireEvent.keyDown(allowOnce, { key: "Escape" });
    expect(vi.mocked(value.decide).mock.calls).toEqual([["ask-2", "deny-once"]]);
  });

  it("wraps a long host instead of overflowing, and brackets an IPv6 one", () => {
    const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
    withSurface(surface([terminalAsk("ask-1", { host: longHost }), terminalAsk("ask-2", { host: "2606:4700::1111" })]),
      <TerminalEgressBanner tabId={TAB} />);
    const targets = screen.getAllByTestId("terminal-egress-target");
    expect(targets[0]!.className).toContain("break-all");
    expect(targets[0]!.textContent).toBe(`${longHost}:443 blocked`);
    expect(targets[1]!.textContent).toBe("[2606:4700::1111]:443 blocked");
  });

  it("disables the answers of a row whose request is locked", () => {
    withSurface(surface([terminalAsk("ask-1")], { lockedRequestId: "ask-1" }), <TerminalEgressBanner tabId={TAB} />);
    expect(screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("is translated in every shipped locale (no raw keys)", () => {
    setLocale("ko");
    withSurface(surface([terminalAsk("ask-1", { host: "127.0.0.1", network: "local", scopes: ["once", "tab"] })]),
      <TerminalEgressBanner tabId={TAB} />);
    const text = screen.getByTestId("terminal-egress-banner").textContent ?? "";
    expect(text).toContain("127.0.0.1:443 차단됨");
    expect(text).toContain("이 탭에서 허용");
    expect(text).not.toMatch(/terminalEgressBanner\.|egressApprovalCard\./u);
    expect(screen.getByRole("region").getAttribute("aria-label")).toBe("이 터미널의 네트워크 승인");
  });
});

describe("approvalsForDocks", () => {
  it("leaves a terminal's ask to its tab's banner while a view of the tab is mounted, and to the docks otherwise", () => {
    const queue = [shellAsk, terminalAsk("ask-1"), terminalAsk("ask-2", {}, OTHER_TAB)];
    expect(approvalsForDocks(queue, (tabId) => tabId === TAB).map((request) => request.id)).toEqual(["shell-1", "ask-2"]);
    expect(approvalsForDocks(queue, () => false).map((request) => request.id)).toEqual(["shell-1", "ask-1", "ask-2"]);
  });
});

describe("EgressHostApprovalCard for a terminal tab (drawn when the tab is not on screen)", () => {
  beforeEach(() => { setLocale("en"); });

  it("names the terminal tab by its visible name instead of a conversation and offers This tab", () => {
    noteTerminalTabLabel(TAB, "Terminal 3");
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={terminalAsk("ask-1")} conversationLabel="unused" onDecide={onDecide} />);
    const card = screen.getByTestId("egress-approval-card");
    expect(card.textContent).toContain("A command in a workspace terminal wants to connect");
    expect(card.textContent).toContain("Terminal tab: Terminal 3");
    expect(card.textContent).not.toContain(TAB);
    expect(card.textContent).not.toContain("Conversation:");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton).textContent).toBe("Allow for this tab");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: "tab" });
  });

  it("says when the tab is one this window never showed, never printing its id", () => {
    render(<EgressHostApprovalCard request={terminalAsk("ask-9", {}, "terminal:0a1b2c3d-9")} conversationLabel="unused" onDecide={vi.fn()} />);
    const card = screen.getByTestId("egress-approval-card");
    expect(card.textContent).toContain("Terminal tab: a terminal tab in another window");
    expect(card.textContent).not.toContain("terminal:0a1b2c3d-9");
  });

  it("says a local grant lasts until the tab's shell exits, including an exit and restart", () => {
    render(<EgressHostApprovalCard
      request={terminalAsk("ask-1", { host: "10.0.0.5", network: "local", scopes: ["once", "tab"] })}
      conversationLabel="unused"
      onDecide={vi.fn()}
    />);
    expect(screen.getByTestId("egress-approval-local-warning").textContent).toContain("until this tab's shell exits (the tab closes, or the shell exits and restarts)");
  });
});
