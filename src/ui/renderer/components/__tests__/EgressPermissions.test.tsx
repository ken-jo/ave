// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import { EgressGrantsList } from "../permissions/EgressGrantsList.js";
import type { ApprovalRequest } from "../../types.js";
import type { PersistentEgressGrant } from "../../../../shared/egress-grant-scopes.js";

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
    egressHost: { host: "github.com", port: 443, scopes: ["once", "conversation", "workspace", "always"] },
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
        request={egressRequest({ egressHost: { host: "::1", port: 8080, scopes: ["once", "conversation"] } })}
        conversationLabel="x"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId("egress-approval-target").textContent).toBe("[::1]:8080");
    expect(screen.queryByTestId("egress-approval-allow-workspace")).toBeNull();
    expect(screen.queryByTestId("egress-approval-allow-always")).toBeNull();
    expect(screen.getByTestId("egress-approval-card").textContent).not.toContain("Settings → Permissions → Network");
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
    const revoker = vi.fn(async (grant: PersistentEgressGrant) => {
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
