// @vitest-environment jsdom
/**
 * The sandbox notice that tells the user a setting they turned on did not take.
 *
 * The runtime reason cannot carry this: a degraded gate publishes no capability,
 * so the renderer sees the same "no OS sandbox configured" it sees when the
 * sandbox was never enabled. These cases pin the distinction at the surface —
 * degraded says so, off and active stay quiet, and a host that never ran the
 * gate is not reported as either.
 */
import "../../../../../test/renderer/setup.js";
import { installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../../permissions/host-shell-execution-plan.js";
import { PermissionsTab } from "../PermissionsTab.js";
import { t } from "../../../../i18n/index.js";

function installApi(boot: unknown, sandboxOn = true, shell: unknown = undefined) {
  const ave = {
    permission: {
      egressGrantsList: vi.fn(async () => ({ ok: true as const, grants: [] })),
      egressGrantRevoke: vi.fn(async () => ({ ok: true as const })),
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
      recentlyDeniedList: vi.fn(async () => ({ ok: true as const, entries: [], total: 0 })),
      onRecentlyDeniedChanged: vi.fn(() => () => undefined),
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
      reviewerDispatch: vi.fn(async () => ({
        ok: true as const,
        verb: "show" as const,
        settings: {
          mode: "rule" as const,
          fallbackOnError: "deny" as const,
        },
        reviewerDegradedToRule: false,
      })),
      // win32 so the platform half is realistic; the notice must not depend on it.
      sandboxCapability: vi.fn(async () => ({
        platform: "win32" as NodeJS.Platform,
        enabled: sandboxOn,
        available: true,
        kind: "partial" as const,
        reason: "",
        runtime: {
          available: false,
          kind: "none" as const,
          reason: "no OS sandbox configured for the host process",
        },
        boot,
        shellExecutionPlan: getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
          platform: "win32", requestedSandbox: sandboxOn,
          activeCapability: { kind: "none", confidence: "verified", platform: "win32", reason: "fixture" },
        })),
        ...(shell === undefined ? {} : { shell }),
        confines: { filesystem: true, process: false, network: true },
      })),
      sandboxWindowsStatus: vi.fn(async () => ({
        applicable: false,
        userState: null,
        wfpState: null,
        ready: false,
        instructions: "",
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
        source: "defaults",
        adminPath: undefined,
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.ave = ave as never;
  const api = installMockAveApi({ settings: { features: { osToolSandbox: sandboxOn } } });
  return Object.assign(ave, { aveApi: api });
}

async function renderTab(): Promise<void> {
  await act(async () => {
    render(<PermissionsTab />);
  });
  await waitFor(() => expect(screen.getByTestId("os-sandbox-toggle")).toBeInTheDocument());
}

describe("PermissionsTab — boot sandbox outcome notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { ave?: unknown }).ave;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { ave?: unknown }).ave;
  });

  it.each([
    ["windows-sandbox-missing", "inputActionBar.sandboxCauseWindowsSandboxMissing"],
    ["windows-sandbox-integrity-failed", "permissionsTab.osSandboxWindowsHelperIntegrityError"],
  ])("shows the repair notice for boot cause %s", async (cause, key) => {
    installApi({ action: "degrade", reason: "degrade-windows-not-installed", onSignal: "default-settings", causes: [cause] });
    await renderTab();
    expect(screen.getByTestId("os-sandbox-boot-degraded-detail")).toHaveTextContent(t(key));
    expect(document.body.textContent).not.toContain(t("inputActionBar.sandboxCauseWindowsSetupIncomplete"));
  });

  it("says the sandbox did not start and directs dependency diagnostics to the log", async () => {
    installApi({
      action: "degrade",
      reason: "degrade-windows-not-installed",
      onSignal: "default-settings",
      causes: ["windows-setup-incomplete"],
    });
    await renderTab();

    expect(screen.getByTestId("os-sandbox-boot-degraded")).toBeInTheDocument();
    expect(screen.getByTestId("os-sandbox-boot-degraded-detail")).toHaveTextContent(
      "진단",
    );
    expect(document.body.textContent).not.toContain("cred=false");
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("샌드박스 꺼짐");
  });

  it("tells a Windows start failure apart from a missing install, without the raw cause", async () => {
    installApi({
      action: "degrade",
      reason: "degrade-windows-init-failed",
      onSignal: "default-settings",
      causes: ["init-failed"],
    });
    await renderTab();

    const detail = screen.getByTestId("os-sandbox-boot-degraded-detail");
    expect(detail).toHaveTextContent("시작 점검은 통과");
    expect(detail).not.toHaveTextContent("진단에 실패");
    expect(document.body.textContent).not.toContain("S-1-5-21");
  });

  it("reports an abort the same way — the user is equally unprotected either way", async () => {
    installApi({
      action: "abort",
      reason: "abort-explicit-cannot-activate",
      onSignal: "explicit-env",
      causes: ["missing-bwrap"],
    });
    await renderTab();

    expect(screen.getByTestId("os-sandbox-boot-degraded")).toBeInTheDocument();
  });

  it("stays quiet when the gate activated", async () => {
    installApi({
      action: "activate",
      reason: "deps-present",
      onSignal: "default-settings",
      causes: [],
    });
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("keeps the off indicator visible when disabled in settings", async () => {
    installApi(
      { action: "skip", reason: "gate-off", onSignal: "off", causes: [] },
      false,
    );
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("설정에서 비활성화됨");
  });

  it("stays quiet when the gate never ran, rather than guessing it was off", async () => {
    installApi(null);
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("renders without the field at all, for a host older than this snapshot", async () => {
    installApi(undefined);
    await renderTab();

    expect(screen.queryByTestId("os-sandbox-boot-degraded")).toBeNull();
  });

  it("keeps Settings usable and reports unknown when the initial capability query fails", async () => {
    const api = installApi(null, false);
    api.permission.sandboxCapability.mockRejectedValueOnce(new Error("unreachable host"));
    await renderTab();
    expect(screen.getByTestId("sandbox-status-query-failed")).toHaveTextContent("샌드박스 상태 확인 불가");
    expect(screen.queryByTestId("permissions-load-error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "상태 다시 확인" }));
    await waitFor(() => expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("설정에서 비활성화됨"));
    expect(screen.queryByTestId("sandbox-status-query-failed")).toBeNull();
  });

  it("reports a host status fault on the shell row only, and still loads every other section", async () => {
    const ave = installApi(
      { action: "activate", reason: "deps-present", onSignal: "default-settings", causes: [] },
      true,
      { state: "error", setting: true, envForced: false, causes: [] },
    );
    await renderTab();

    expect(screen.getByTestId("os-sandbox-shell-status-error")).toHaveTextContent("호스트 오류");
    // Turning the setting off clears the fault, so the toggle stays usable.
    expect(screen.getByTestId("os-sandbox-toggle")).not.toBeDisabled();
    // The rest of the snapshot and the sections loaded beside it still render.
    expect(screen.getByTestId("worker-confinement-toggle")).not.toBeDisabled();
    expect(screen.getByTestId("os-sandbox-runtime-reason")).toBeInTheDocument();
    expect(ave.permission.listScopedRules).toHaveBeenCalled();
    expect(ave.permission.dirDispatch).toHaveBeenCalledWith("list");
    expect(screen.queryByText("데이터를 불러오지 못했습니다.")).toBeNull();

    await act(async () => {
      screen.getByTestId("os-sandbox-toggle").click();
    });
    await waitFor(() =>
      expect(ave.aveApi.updateSettings).toHaveBeenCalledWith({ features: { osToolSandbox: false } }),
    );
  });
});
