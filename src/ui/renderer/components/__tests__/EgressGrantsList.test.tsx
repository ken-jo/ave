// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressGrantsList } from "../permissions/EgressGrantsList.js";
import type { SessionEgressGrant, ListedEgressGrant, PersistentEgressGrant, TabEgressGrant } from "../../../../shared/egress-grant-scopes.js";

describe("EgressGrantsList", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  const projectGrant: PersistentEgressGrant = {
    scope: "project", origin: "shell", projectRoot: "/work/project", host: "packages.example.test", port: 443, grantedAt: "2026-10-19T01:00:00.000Z",
  };
  const alwaysGrant: PersistentEgressGrant = { scope: "always", origin: "terminal", host: "code.example.test", port: 443, grantedAt: "2026-10-19T02:00:00.000Z" };

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
    expect(text).toContain("packages.example.test:443");
    // Each persistent grant names the only origin it covers.
    expect(text).toContain("Agent shell calls · Project /work/project");
    expect(text).toContain("code.example.test:443");
    expect(text).toContain("Workspace terminals · Everywhere");
    fireEvent.click(screen.getAllByTestId("egress-grant-revoke")[1]!);
    await waitFor(() => expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(1));
    expect(revoker).toHaveBeenCalledWith(alwaysGrant);
  });

  it("lists a session grant and revokes it by its session", async () => {
    const sessionGrant: SessionEgressGrant = {
      scope: "session", sessionId: "session-7", host: "registry.example.test", port: 443, grantedAt: "2026-10-19T03:00:00.000Z",
    };
    let grants: SessionEgressGrant[] = [sessionGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 1 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      const row = await screen.findByTestId("egress-grant-row");
      expect(row.textContent).toContain("registry.example.test:443");
      expect(row.textContent).toContain("Session session-7");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "session", host: "registry.example.test", port: 443, sessionId: "session-7" });
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
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "always", origin: "terminal", host: "code.example.test", port: 443 });
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

  it("lists an isolated conversation shell grant and revokes it by its shell identity", async () => {
    const tabGrant: TabEgressGrant = {
      scope: "tab", tabId: "terminal:0a1b2c3d-1", host: "code.example.test", port: 443, grantedAt: "2026-10-20T03:00:00.000Z",
    };
    let grants: TabEgressGrant[] = [tabGrant];
    const egressGrantRevoke = vi.fn(async () => { grants = []; return { ok: true, removed: true, closed: 0 }; });
    const previous = (window as { ave?: unknown }).ave;
    (window as { ave?: unknown }).ave = { permission: { egressGrantsList: async () => ({ ok: true, grants }), egressGrantRevoke } };
    try {
      render(<EgressGrantsList />);
      const row = await screen.findByTestId("egress-grant-row");
      expect(row.textContent).toContain("code.example.test:443");
      // A conversation's isolated shell is named by what it is, never by its opaque id.
      expect(row.textContent).toContain("Isolated conversation shell · until it exits");
      expect(row.textContent).not.toContain("terminal:0a1b2c3d-1");
      fireEvent.click(screen.getByTestId("egress-grant-revoke"));
      await screen.findByTestId("egress-grants-empty");
      expect(egressGrantRevoke).toHaveBeenCalledWith({ scope: "tab", host: "code.example.test", port: 443, tabId: "terminal:0a1b2c3d-1" });
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

  it("keeps a refused revoke visible and leaves the grant listed", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, grants: [alwaysGrant] }));
    render(<EgressGrantsList fetcher={fetcher} revoker={async () => ({ ok: false, error: "egress-grant-write-failed" })} />);
    await screen.findByTestId("egress-grant-row");
    fireEvent.click(screen.getByTestId("egress-grant-revoke"));
    await screen.findByTestId("egress-grants-error");
    expect(screen.getAllByTestId("egress-grant-row")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes grants after a transient list failure", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("private diagnostic")).mockResolvedValue({ ok: true, grants: [alwaysGrant] });
    render(<EgressGrantsList fetcher={fetcher} />);
    await screen.findByTestId("egress-grants-error");
    expect(document.body.textContent).not.toContain("private diagnostic");
    fireEvent.click(screen.getByTestId("egress-grants-refresh"));
    await screen.findByTestId("egress-grant-row");
    expect(screen.queryByTestId("egress-grants-error")).toBeNull();
  });
});
