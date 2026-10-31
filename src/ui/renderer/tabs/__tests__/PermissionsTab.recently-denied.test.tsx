// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PermissionsTab } from "../PermissionsTab.js";

function installAveApi() {
  const permission = {
    getMode: vi.fn(async () => ({ mode: "default" })),
    setMode: vi.fn(),
    listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
    dirDispatch: vi.fn(async () => ({
      ok: true,
      verb: "list",
      defaults: [],
      userAdditions: [],
      effective: [],
    })),
    recentlyDeniedList: vi.fn(async () => ({
      ok: true,
      total: 1,
      entries: [
        {
          id: "denied-1",
          ts: "2026-05-10T09:00:00.000Z",
          toolName: "write_file",
          source: "builtin",
          category: "write",
          inputSummary: '{"path":"<redacted>"}',
          reason: "Nobody can approve this request; do not retry.",
          rerunAvailable: false,
        },
      ],
    })),
    recentlyDeniedRerun: vi.fn(async () => ({ ok: true })),
    onRecentlyDeniedChanged: vi.fn(() => () => {}),
    reviewerDispatch: vi.fn(async () => ({
      ok: true,
      verb: "show",
      settings: {
        mode: "disabled",
        fallbackOnError: "deny",
      },
    })),
    sandboxCapability: vi.fn(async () => ({
      platform: "linux" as NodeJS.Platform,
      enabled: false,
      available: true,
      kind: "full" as const,
      reason: "",
      confines: { filesystem: true, process: true, network: true },
    })),
  };
  (window as unknown as { ave: unknown }).ave = {
    permission,
    policy: {
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        source: "user",
      })),
      set: vi.fn(),
    },
  };
  installMockAveApi({ settings: { features: { osToolSandbox: false } } });
  return permission;
}

beforeEach(() => {
  delete (window as unknown as { ave?: unknown }).ave;
});

describe("PermissionsTab recently denied history", () => {
  it("shows denied actions without granting execution", async () => {
    const permission = installAveApi();
    render(<PermissionsTab />);
    await waitFor(() => expect(screen.getByTestId("recently-denied-panel")).toHaveTextContent("write_file"));
    expect(screen.getByRole("button", { name: "다시 실행" })).toBeDisabled();
    expect(permission.recentlyDeniedRerun).not.toHaveBeenCalled();
  });
});
