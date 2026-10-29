// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecentlyDeniedPanel } from "../permissions/RecentlyDeniedPanel.js";

function installApi(rerunAvailable: boolean) {
  const permission = {
    recentlyDeniedList: vi.fn(async () => ({ ok: true, entries: [{ id: "entry", ts: "2026-10-30T00:00:00Z", toolName: "write_file", inputSummary: "redacted summary", reason: "Denied", rerunAvailable }] })),
    recentlyDeniedRerun: vi.fn(async () => ({ ok: true })),
    onRecentlyDeniedChanged: vi.fn(() => () => {}),
  };
  Object.assign(window, { ave: { permission } });
  return permission;
}

describe("denial history panel", () => {
  it("offers a fresh execution for retained calls without approval controls", async () => {
    const permission = installApi(true);
    render(<RecentlyDeniedPanel showEmpty />);
    await waitFor(() => expect(screen.getByText("write_file")).toBeTruthy());
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(permission.recentlyDeniedRerun).toHaveBeenCalledWith("entry"));
    expect(screen.queryByText("허용")).toBeNull();
  });
  it("disables rerun when no live invocation remains", async () => {
    const permission = installApi(false);
    render(<RecentlyDeniedPanel showEmpty />);
    await waitFor(() => expect(screen.getByText("write_file")).toBeTruthy());
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button"));
    expect(permission.recentlyDeniedRerun).not.toHaveBeenCalled();
  });
});
