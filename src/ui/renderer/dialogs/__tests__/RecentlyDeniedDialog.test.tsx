// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RecentlyDeniedDialog } from "../RecentlyDeniedDialog.js";

describe("denial history dialog", () => {
  it("loads history only when opened by the user", async () => {
    const recentlyDeniedList = vi.fn(async () => ({ ok: true, entries: [] }));
    Object.assign(window, { ave: { permission: { recentlyDeniedList, onRecentlyDeniedChanged: () => () => {} } } });
    const { rerender } = render(<RecentlyDeniedDialog open={false} onOpenChange={() => {}} />);
    expect(recentlyDeniedList).not.toHaveBeenCalled();
    rerender(<RecentlyDeniedDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("recently-denied-panel")).toBeTruthy());
    expect(recentlyDeniedList).toHaveBeenCalled();
  });
});
