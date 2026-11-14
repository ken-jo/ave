// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HookTrustReview } from "../permissions/HookTrustReview.js";
import type { HookTrustRow } from "../../types.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

function row(state: HookTrustRow["state"], overrides: Partial<HookTrustRow> = {}): HookTrustRow {
  return { fileName: `pre-${state}.sh`, hookType: "pre", sha256: "a".repeat(64), state,
    sourceId: "user", hookSource: "user", ...overrides };
}

let locale: ReturnType<typeof getLocale>;
beforeEach(() => { locale = getLocale(); setLocale("en"); });
afterEach(() => { cleanup(); setLocale(locale); });

describe("hook trust review", () => {
  it("shows new, changed, trusted, disabled and policy-trusted definitions with exact hashes", () => {
    render(<HookTrustReview rows={[
      row("new"), row("changed", { previousSha256: "b".repeat(64), hookSource: "system", sourceId: "system" }),
      row("trusted"), row("disabled"), row("managed", { hookSource: "managed", sourceId: "managed" }),
    ]} refresh={vi.fn()} review={vi.fn()} />);
    const rows = screen.getAllByTestId("hook-trust-row");
    expect(rows.map((item) => item.getAttribute("data-state"))).toEqual(["new", "changed", "trusted", "disabled", "managed"]);
    for (const item of rows) expect(within(item).getByTestId("hook-trust-hash").textContent).toContain("a".repeat(64));
    const [, changed, trusted, disabled, managed] = rows;
    if (!changed || !trusted || !disabled || !managed) throw new Error("Expected every trust state");
    expect(changed.textContent).toContain(t("permissionsTab.hookSourceSystem"));
    expect(changed.textContent).toContain("b".repeat(64));
    expect(within(trusted).queryByTestId("hook-trust-accept")).toBeNull();
    expect(within(disabled).queryByTestId("hook-trust-disable")).toBeNull();
    expect(within(managed).queryByRole("button")).toBeNull();
  });

  it("submits the exact reviewed source and hash and refreshes after trust and disable", async () => {
    const refresh = vi.fn(async () => undefined);
    const review = vi.fn(async () => ({ ok: true as const }));
    render(<HookTrustReview rows={[row("changed", { sourceId: "system", hookSource: "system" })]} refresh={refresh} review={review} />);
    fireEvent.click(screen.getByTestId("hook-trust-accept"));
    await waitFor(() => expect(review).toHaveBeenCalledWith({ sourceId: "system", fileName: "pre-changed.sh", expectedSha256: "a".repeat(64), action: "accept" }));
    await waitFor(() => expect(screen.getByTestId("hook-trust-disable").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByTestId("hook-trust-disable"));
    await waitFor(() => expect(review).toHaveBeenLastCalledWith({ sourceId: "system", fileName: "pre-changed.sh", expectedSha256: "a".repeat(64), action: "disable" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("localizes stale-review refusal and refreshes the changed definition", async () => {
    const refresh = vi.fn(async () => undefined);
    render(<HookTrustReview rows={[row("new")]} refresh={refresh}
      review={async () => ({ ok: false, error: "hook-review-stale" })} />);
    fireEvent.click(screen.getByTestId("hook-trust-accept"));
    expect((await screen.findByRole("alert")).textContent).toBe(t("permissionsTab.hookReviewStale"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("requires project trust before offering definition acceptance", async () => {
    const review = vi.fn(async () => ({ ok: true as const }));
    render(<HookTrustReview rows={[row("new", { sourceId: "project:/workspace/sample", hookSource: "project", projectTrusted: false })]}
      refresh={vi.fn(async () => undefined)} review={review} />);
    expect(screen.getByTestId("hook-trust-accept").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("hook-trust-project"));
    await waitFor(() => expect(review).toHaveBeenCalledWith({ sourceId: "project:/workspace/sample", fileName: "pre-new.sh", expectedSha256: "a".repeat(64), action: "trust-project" }));
  });

  it("distinguishes identical hook names from different project roots", () => {
    render(<HookTrustReview rows={[
      row("new", { fileName: "hooks.json", hookSource: "project", sourceId: "project:/workspace/alpha", projectTrusted: false }),
      row("new", { fileName: "hooks.json", hookSource: "project", sourceId: "project:/workspace/beta", projectTrusted: false }),
    ]} refresh={vi.fn(async () => undefined)} review={vi.fn()} />);
    expect(screen.getAllByTestId("hook-trust-project-identity").map((item) => item.textContent))
      .toEqual(["project:/workspace/alpha", "project:/workspace/beta"]);
  });
});
