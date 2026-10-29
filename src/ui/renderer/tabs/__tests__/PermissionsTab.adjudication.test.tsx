// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { renderPermissionsTab } from "./support/render-permissions-tab.js";

function reviewerSettings() {
  return {
    mode: "llm" as const,
    fallbackOnError: "deny" as const,
  };
}

function installApi() {
  const ave = {
    permission: {
      recentlyDeniedList: vi.fn(async () => ({ ok: true as const, entries: [], total: 0 })),
      onRecentlyDeniedChanged: vi.fn(() => () => undefined),
      egressGrantsList: vi.fn(async () => ({ ok: true as const, grants: [] })),
      egressGrantRevoke: vi.fn(async () => ({ ok: true as const })),
      getMode: vi.fn(async () => ({ mode: "auto" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      onConfigChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
      hookTrustList: vi.fn(async () => ({
        ok: true as const,
        active: [],
        disabled: [],
        totalDisabled: 0,
      })),
      dirDispatch: vi.fn(async () => ({
        ok: true as const,
        verb: "list" as const,
        defaults: [],
        userAdditions: [],
        effective: [],
      })),
      reviewerDispatch: vi.fn(async (rawArgs: string) => {
        if (rawArgs === "show") {
          return { ok: true as const, verb: "show" as const, settings: reviewerSettings() };
        }
        throw new Error(`Unexpected reviewer command: ${rawArgs}`);
      }),
      sandboxCapability: vi.fn(async () => ({
        platform: "darwin" as NodeJS.Platform,
        enabled: false,
        available: true,
        kind: "full" as const,
        reason: "",
        confines: { filesystem: true, process: true, network: true },
      })),
      onManifestViolation: vi.fn(() => () => undefined),
      auditShow: vi.fn(async () => ({
        ok: true as const,
        entries: [],
        total: 0,
        summary: { files: 0, bytes: 0 },
      })),
      auditVerify: vi.fn(async () => ({
        ok: true as const,
        intact: true,
        totalFiles: 0,
        totalEntries: 0,
        perDay: [],
      })),
    },
    policy: {
      get: vi.fn(async () => ({
        requireExplicitApproval: true,
        managed: false,
        editable: true,
        source: "defaults",
        adminPath: undefined,
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
    userApproval: {
      list: vi.fn(async () => []),
      listSession: vi.fn(async () => []),
      revokeByKey: vi.fn(async () => ({ ok: true })),
      record: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.ave = ave as never;
  const aveApi = installMockAveApi({
    settings: {
      features: {
        osToolSandbox: false,
      },
    },
  });
  return { ave, aveApi };
}

describe("PermissionsTab delegated action policy", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); delete (window as unknown as { ave?: unknown }).ave; });

  it("keeps legacy parent policy out of the active approval controls", async () => {
    const { aveApi, ave } = installApi();
    await renderPermissionsTab();
    expect(screen.queryByTestId("parent-adjudication-toggle")).toBeNull();
    expect(screen.queryByTestId("parent-adjudication-background-escalation-select")).toBeNull();
    expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(0);
    expect(aveApi.updateSettings).not.toHaveBeenCalled();
    expect(ave.permission.reviewerDispatch).toHaveBeenCalledWith("show");
  });
});
