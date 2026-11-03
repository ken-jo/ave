// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HomeContentReview } from "../permissions/HomeContentReview.js";
import { t } from "../../../../i18n/index.js";
import type { AveHomeTrustReview } from "../../../../shared/ave-home-trust.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as unknown as { ave?: unknown }).ave; });

function review(overrides: Partial<AveHomeTrustReview> = {}): AveHomeTrustReview {
  return {
    snapshotId: "snap-1",
    state: "bootstrapped:false",
    rows: [
      { key: "mcp/servers.json", path: "/home/u/.ave/mcp/servers.json", kind: "file", hash: "a".repeat(64), reason: "new", approvable: true, summary: "files: mcp-files" },
      { key: "skills/linked", path: "/home/u/.ave/skills/linked", kind: "entry", reason: "link", approvable: false },
    ],
    approveAllOffered: true,
    pendingAtBoot: true,
    ...overrides,
  };
}

function install(first: AveHomeTrustReview | null, after: AveHomeTrustReview | null = first) {
  const homeTrustReview = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(after);
  const homeTrustApprove = vi.fn(async () => ({ ok: true, approved: 1 }));
  const homeTrustRemove = vi.fn(async () => ({ ok: true }));
  (window as unknown as { ave: unknown }).ave = { permission: { homeTrustReview, homeTrustApprove, homeTrustRemove } };
  return { homeTrustReview, homeTrustApprove, homeTrustRemove };
}

describe("HomeContentReview", () => {
  it("renders nothing when no content is pending", async () => {
    const api = install(null);
    const { container } = render(<HomeContentReview />);
    await waitFor(() => expect(api.homeTrustReview).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="home-trust-review"]')).toBeNull();
  });

  it("shows each row with its reason and masked summary, and offers Approve only where allowed", async () => {
    install(review());
    render(<HomeContentReview />);
    await screen.findByTestId("home-trust-review");
    const rows = screen.getAllByTestId("home-trust-row");
    expect(rows.map((row) => row.dataset.key)).toEqual(["mcp/servers.json", "skills/linked"]);
    expect(rows[0]!.textContent).toContain(t("permissionsTab.homeTrustReasonNew"));
    expect(rows[0]!.textContent).toContain("files: mcp-files");
    expect(rows[1]!.textContent).toContain(t("permissionsTab.homeTrustReasonLink"));
    expect(rows[0]!.querySelector('[data-testid="home-trust-approve"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="home-trust-approve"]')).toBeNull();
  });

  it("approves all with the served snapshot and then asks for a restart", async () => {
    const api = install(review(), review({ rows: [], approveAllOffered: false }));
    render(<HomeContentReview />);
    const approveAll = await screen.findByTestId("home-trust-approve-all");
    await act(async () => { fireEvent.click(approveAll); });
    expect(api.homeTrustApprove).toHaveBeenCalledWith("snap-1");
    await screen.findByTestId("home-trust-restart-hint");
  });

  it("hides Approve all when the host does not offer it", async () => {
    install(review({ approveAllOffered: false }));
    render(<HomeContentReview />);
    await screen.findByTestId("home-trust-review");
    expect(screen.queryByTestId("home-trust-approve-all")).toBeNull();
  });

  it("removes only after the confirmation", async () => {
    const api = install(review());
    render(<HomeContentReview />);
    const removes = await screen.findAllByTestId("home-trust-remove");
    fireEvent.click(removes[1]!);
    expect(api.homeTrustRemove).not.toHaveBeenCalled();
    const confirm = await screen.findByTestId("home-trust-remove-confirm");
    await act(async () => { fireEvent.click(confirm); });
    expect(api.homeTrustRemove).toHaveBeenCalledWith("snap-1", "skills/linked");
  });

  it("says why nothing can be reviewed while config/ requires recovery", async () => {
    install(review({ rows: [], approveAllOffered: false, unavailable: "recovery", state: undefined }));
    render(<HomeContentReview />);
    expect((await screen.findByTestId("home-trust-unavailable")).textContent).toBe(t("permissionsTab.homeTrustUnavailableRecovery"));
  });

  it("shows the host's refusal message", async () => {
    const api = install(review());
    api.homeTrustApprove.mockResolvedValueOnce({ ok: false, error: "stale", message: "The review changed. Reopen it and try again." } as never);
    render(<HomeContentReview />);
    const approves = await screen.findAllByTestId("home-trust-approve");
    await act(async () => { fireEvent.click(approves[0]!); });
    expect((await screen.findByTestId("home-trust-error")).textContent).toBe("The review changed. Reopen it and try again.");
  });
});
