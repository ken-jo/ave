// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import { EgressGrantsList } from "../permissions/EgressGrantsList.js";
import { noteTerminalTabLabel } from "../../preview/terminal-tab-labels.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";
import type { SessionEgressGrant, ListedEgressGrant, PersistentEgressGrant, TabEgressGrant } from "../../../../shared/egress-grant-scopes.js";

function egressRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "egress-1",
    category: "tool",
    kind: "egress-host",
    toolName: "bash",
    args: { host: "github.com", port: 443 },
    reason: "The sandboxed bash command wants to connect to github.com:443.",
    createdAt: 0,
    allowedChoices: ["allow-once", "deny-once"],
    egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", network: "public", scopes: ["once", "session", "project", "always"] },
    ...overrides,
  } as ApprovalRequest;
}

describe("EgressHostApprovalCard", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  it("shows the destination and answers Deny or an allow with the scope picked", () => {
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={egressRequest()} conversationLabel="Fix the build" onDecide={onDecide} />);
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("github.com:443");
    expect(screen.getByTestId("egress-approval-card").textContent).toContain("Conversation: Fix the build");
    expect(screen.getByTestId("egress-approval-card").textContent).toContain("Settings → Permissions → Network");
    expect([TEST_IDS.denyButton, TEST_IDS.allowSessionButton, TEST_IDS.approveButton].map((testId) =>
      screen.getByTestId(testId).textContent)).toEqual(["Deny", "Allow for session", "Allow once"]);
    expect(openDecisionMenu("allow-project").textContent).toBe("Always allow in this project");
    fireEvent.keyDown(screen.getByTestId("approval-choice-allow-project"), { key: "Escape" });
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    selectDecision("allow-project");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(onDecide.mock.calls).toEqual([
      ["deny-once"],
      ["allow-once", undefined, { egressScope: "project" }],
    ]);
  });

  it("offers only the scopes the host sent, brackets an IPv6 target, and omits the revoke hint for short grants", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "::1", port: 8080, rule: null, network: "local", scopes: ["once", "session"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("[::1]:8080");
    openDecisionMenu("allow-project");
    expect(screen.getByTestId("approval-choice-allow-project")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-allow-everywhere")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("egress-approval-card").textContent).not.toContain("Settings → Permissions → Network");
  });

  it("warns that a local or private destination is one, and shows it in canonical form", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "127.0.0.1", port: 11434, rule: null, network: "local", scopes: ["once", "session"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("127.0.0.1:11434");
    expect(screen.getByTestId("egress-approval-local-warning").textContent).toContain("private network");
    expect(openDecisionMenu("allow-project")).toHaveAttribute("data-disabled");
  });

  it("says when the upstream proxy resolves the name and Ave could not check it", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "intranet.corp.test", port: 443, rule: "Network(intranet.corp.test:443)", network: "unverified", scopes: ["once", "session"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-unverified-warning").textContent).toContain("proxy server");
    expect(screen.queryByTestId("egress-approval-local-warning")).toBeNull();
    expect(openDecisionMenu("allow-everywhere")).toHaveAttribute("data-disabled");
  });

  it("shows no local warning for a public destination", () => {
    render(<EgressHostApprovalCard request={egressRequest({ egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", network: "public", scopes: ["once"] } })} conversationLabel="x" onDecide={vi.fn()} />);
    expect(screen.queryByTestId("egress-approval-local-warning")).toBeNull();
  });

  it("can only deny a request that carries no destination", () => {
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={egressRequest({ egressHost: undefined })} conversationLabel="x" onDecide={onDecide} />);
    expect(screen.queryByTestId(TEST_IDS.approveButton)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("disables every answer while interaction is locked", () => {
    render(<EgressHostApprovalCard request={egressRequest()} conversationLabel="x" interactionLocked onDecide={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("EgressGrantsList", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  const projectGrant: PersistentEgressGrant = {
    scope: "project", origin: "shell", projectRoot: "/work/project", host: "pypi.org", port: 443, grantedAt: "2026-10-19T01:00:00.000Z",
  };
  const alwaysGrant: PersistentEgressGrant = { scope: "always", origin: "terminal", host: "github.com", port: 443, grantedAt: "2026-10-19T02:00:00.000Z" };

  it.each([
    ["en", ["Public network", "Local / private network", "Unverified destination"]],
    ["ko", ["공개 네트워크", "로컬 / 사설 네트워크", "확인되지 않은 목적지"]],
  ] as const)("distinguishes same-destination grants by class in %s", async (locale, labels) => {
    setLocale(locale);
    const base: SessionEgressGrant = { scope: "session", sessionId: "session-7", host: "data.example.test", port: 443, grantedAt: "2026-10-19T03:00:00.000Z" };
    const grants: SessionEgressGrant[] = [
      { ...base, network: "public" }, { ...base, network: "local" }, { ...base, network: "unverified" },
    ];
    render(<EgressGrantsList fetcher={async () => ({ ok: true, grants })} />);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(3));
    expect(screen.getAllByTestId("egress-grant-class").map(label => label.textContent)).toEqual(labels);
    expect(screen.getAllByTestId("egress-grant-row").every(row => row.textContent?.includes("data.example.test:443"))).toBe(true);
  });

  it.each(["en", "ko"] as const)("labels legacy classless grants as public in %s", async (locale) => {
    setLocale(locale);
    render(<EgressGrantsList fetcher={async () => ({ ok: true, grants: [alwaysGrant] })} />);
    expect((await screen.findByTestId("egress-grant-class")).textContent).toBe(locale === "en" ? "Public network" : "공개 네트워크");
  });

  it("lists persistent grants and revokes the one picked", async () => {
    let grants = [projectGrant, alwaysGrant];
    const fetcher = vi.fn(async () => ({ ok: true, grants }));
    const revoker = vi.fn(async (grant: ListedEgressGrant) => {
      grants = grants.filter((g) => g !== grant && !(g.scope === grant.scope && g.host === grant.host));
      return { ok: true };
    });
    render(<EgressGrantsList fetcher={fetcher} revoker={revoker} />);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(2));
    const text = screen.getByTestId("egress-grants").textContent ?? "";
    expect(text).toContain("pypi.org:443");
    // Each persistent grant names the only origin it covers.
    expect(text).toContain("Agent shell calls · Project /work/project");
    expect(text).toContain("github.com:443");
    expect(text).toContain("Workspace terminals · Everywhere");
    fireEvent.click(screen.getAllByTestId("egress-grant-revoke")[1]!);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(1));
    expect(revoker).toHaveBeenCalledWith(alwaysGrant);
  });

  it("lists a session grant and revokes it by its session", async () => {
    const sessionGrant: SessionEgressGrant = {
      scope: "session", sessionId: "session-7", host: "registry.npmjs.org", port: 443, grantedAt: "2026-10-19T03:00:00.000Z",
    };
    let grants: SessionEgressGrant[] = [sessionGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 1 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      const row = await screen.findByTestId("egress-grant-row");
      expect(row.textContent).toContain("registry.npmjs.org:443");
      expect(row.textContent).toContain("Session session-7");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "session", host: "registry.npmjs.org", port: 443, sessionId: "session-7" });
    } finally {
      (window as { ave?: unknown }).ave = previous;
    }
  });

  it("revokes a persistent grant by its origin too", async () => {
    let grants: PersistentEgressGrant[] = [alwaysGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 0 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      await screen.findByTestId("egress-grant-row");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "always", origin: "terminal", host: "github.com", port: 443 });
    } finally {
      (window as { ave?: unknown }).ave = previous;
    }
  });

  it("keeps same-destination grants separate and forwards the selected network class", async () => {
    const base: SessionEgressGrant = { scope: "session", sessionId: "session-7", host: "data.example.test", port: 443, grantedAt: "2026-10-19T03:00:00.000Z" };
    let grants: SessionEgressGrant[] = [{ ...base, network: "public" }, { ...base, network: "local" }, { ...base, network: "unverified" }];
    const egressGrantRevoke = vi.fn(async (target: { network?: string }) => {
      grants = grants.filter(grant => grant.network !== target.network);
      return { ok: true };
    });
    const previous = window.ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(3));
      fireEvent.click(screen.getAllByTestId("egress-grant-revoke")[1]!);
      await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(2));
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "session", sessionId: "session-7", host: base.host, port: base.port, network: "local" });
      expect(grants.map(grant => grant.network)).toEqual(["public", "unverified"]);
    } finally {
      (window as { ave?: unknown }).ave = previous;
    }
  });

  it("lists a terminal tab grant and revokes it by its tab", async () => {
    const tabGrant: TabEgressGrant = {
      scope: "tab", tabId: "terminal:0a1b2c3d-1", host: "github.com", port: 443, grantedAt: "2026-10-20T03:00:00.000Z",
    };
    let grants: TabEgressGrant[] = [tabGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 0 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      const row = await screen.findByTestId("egress-grant-row");
      expect(row.textContent).toContain("github.com:443");
      // A tab this window never showed is named as elsewhere, never by its raw id.
      expect(row.textContent).toContain("Terminal tab in another window · until its shell exits");
      expect(row.textContent).not.toContain("terminal:0a1b2c3d-1");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "tab", host: "github.com", port: 443, tabId: "terminal:0a1b2c3d-1" });
    } finally {
      (window as { ave?: unknown }).ave = previous;
    }
  });

  it("names a tab this window shows by its visible name", async () => {
    noteTerminalTabLabel("terminal:0a1b2c3d-4", "Terminal 2");
    const tabGrant: TabEgressGrant = {
      scope: "tab", tabId: "terminal:0a1b2c3d-4", host: "github.com", port: 443, grantedAt: "2026-10-20T03:00:00.000Z",
    };
    render(<EgressGrantsList fetcher={async () => ({ ok: true, grants: [tabGrant] })} />);
    const row = await screen.findByTestId("egress-grant-row");
    expect(row.textContent).toContain("Terminal tab Terminal 2 · until its shell exits");
  });

  it("says when nothing is granted", async () => {
    render(<EgressGrantsList fetcher={async () => ({ ok: true, grants: [] })} />);
    await screen.findByTestId("egress-grants-empty");
  });

  it("shows a store it cannot read as an error, not as an empty list", async () => {
    render(<EgressGrantsList fetcher={async () => ({ ok: false, error: "egress-grant-store-unreadable", message: "bad file" })} />);
    const error = await screen.findByTestId("egress-grants-error");
    expect(error.textContent).toContain("The saved network grants could not be read");
    expect(screen.queryByTestId("egress-grants-empty")).toBeNull();
  });
});
