// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import { EgressGrantsList } from "../permissions/EgressGrantsList.js";
import type { ApprovalRequest } from "../../types.js";
import type { ConversationEgressGrant, ListedEgressGrant, PersistentEgressGrant, TabEgressGrant } from "../../../../shared/egress-grant-scopes.js";

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
    egressHost: { host: "github.com", port: 443, network: "public", scopes: ["once", "conversation", "workspace", "always"] },
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
    expect(["once", "conversation", "workspace", "always"].map((scope) =>
      screen.getByTestId(`egress-approval-allow-${scope}`).textContent)).toEqual([
      "Allow once", "This conversation", "This workspace", "Always",
    ]);
    fireEvent.click(screen.getByTestId("egress-approval-deny"));
    fireEvent.click(screen.getByTestId("egress-approval-allow-workspace"));
    expect(onDecide.mock.calls).toEqual([
      ["deny-once"],
      ["allow-once", undefined, { egressScope: "workspace" }],
    ]);
  });

  it("offers only the scopes the host sent, brackets an IPv6 target, and omits the revoke hint for short grants", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "::1", port: 8080, network: "local", scopes: ["once", "conversation"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("[::1]:8080");
    expect(screen.queryByTestId("egress-approval-allow-workspace")).toBeNull();
    expect(screen.queryByTestId("egress-approval-allow-always")).toBeNull();
    expect(screen.getByTestId("egress-approval-card").textContent).not.toContain("Settings → Permissions → Network");
  });

  it("warns that a local or private destination is one, and shows it in canonical form", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "127.0.0.1", port: 11434, network: "local", scopes: ["once", "conversation"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("127.0.0.1:11434");
    expect(screen.getByTestId("egress-approval-local-warning").textContent).toContain("private network");
    expect(screen.queryByTestId("egress-approval-allow-workspace")).toBeNull();
  });

  it("says when the upstream proxy resolves the name and Ave could not check it", () => {
    render(
      <EgressHostApprovalCard
        request={egressRequest({ egressHost: { host: "intranet.corp.test", port: 443, network: "unverified", scopes: ["once", "conversation"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-unverified-warning").textContent).toContain("proxy server");
    expect(screen.queryByTestId("egress-approval-local-warning")).toBeNull();
    expect(screen.queryByTestId("egress-approval-allow-always")).toBeNull();
  });

  it("shows no local warning for a public destination", () => {
    render(<EgressHostApprovalCard request={egressRequest({ egressHost: { host: "github.com", port: 443, network: "public", scopes: ["once"] } })} conversationLabel="x" onDecide={vi.fn()} />);
    expect(screen.queryByTestId("egress-approval-local-warning")).toBeNull();
  });

  it("can only deny a request that carries no destination", () => {
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={egressRequest({ egressHost: undefined })} conversationLabel="x" onDecide={onDecide} />);
    expect(screen.queryByTestId("egress-approval-allow-once")).toBeNull();
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

  const workspaceGrant: PersistentEgressGrant = {
    scope: "workspace", workspaceRoot: "/work/project", host: "pypi.org", port: 443, grantedAt: "2026-10-19T01:00:00.000Z",
  };
  const alwaysGrant: PersistentEgressGrant = { scope: "always", host: "github.com", port: 443, grantedAt: "2026-10-19T02:00:00.000Z" };

  it("lists persistent grants and revokes the one picked", async () => {
    let grants = [workspaceGrant, alwaysGrant];
    const fetcher = vi.fn(async () => ({ ok: true, grants }));
    const revoker = vi.fn(async (grant: ListedEgressGrant) => {
      grants = grants.filter((g) => g !== grant && !(g.scope === grant.scope && g.host === grant.host));
      return { ok: true };
    });
    render(<EgressGrantsList fetcher={fetcher} revoker={revoker} />);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(2));
    const text = screen.getByTestId("egress-grants").textContent ?? "";
    expect(text).toContain("pypi.org:443");
    expect(text).toContain("Workspace /work/project");
    expect(text).toContain("github.com:443");
    expect(text).toContain("All workspaces");
    fireEvent.click(screen.getAllByTestId("egress-grant-revoke")[1]!);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(1));
    expect(revoker).toHaveBeenCalledWith(alwaysGrant);
  });

  it("lists a conversation grant and revokes it by its conversation", async () => {
    const conversationGrant: ConversationEgressGrant = {
      scope: "conversation", sessionId: "session-7", host: "registry.npmjs.org", port: 443, grantedAt: "2026-10-19T03:00:00.000Z",
    };
    let grants: ConversationEgressGrant[] = [conversationGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 1 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      const row = await screen.findByTestId("egress-grant-row");
      expect(row.textContent).toContain("registry.npmjs.org:443");
      expect(row.textContent).toContain("Conversation session-7");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "conversation", host: "registry.npmjs.org", port: 443, sessionId: "session-7" });
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
      expect(row.textContent).toContain("Terminal tab terminal:0a1b2c3d-1 · until the tab closes");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "tab", host: "github.com", port: 443, tabId: "terminal:0a1b2c3d-1" });
    } finally {
      (window as { ave?: unknown }).ave = previous;
    }
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
