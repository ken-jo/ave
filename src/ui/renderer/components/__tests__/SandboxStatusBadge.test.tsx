// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCapabilityInfo, SandboxWindowsExtensionPlan } from "../../../../shared/sandbox-capability-info.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../../permissions/host-shell-execution-plan.js";
import { setLocale, t } from "../../../../i18n/runtime.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { SandboxStatusBadge } from "../SandboxStatusBadge.js";
import { useSandboxCapability } from "../../hooks/use-sandbox-capability.js";

function capability({
  platform = "darwin",
  requestedSandbox = true,
  active = false,
}: {
  platform?: NodeJS.Platform;
  requestedSandbox?: boolean;
  active?: boolean;
} = {}): SandboxCapabilityInfo {
  const confines = { filesystem: active, process: active && platform !== "win32", network: active };
  const plan = buildHostShellExecutionPlan({
    platform,
    requestedSandbox,
    activeCapability: { kind: active ? "asrt" : "none", platform, confidence: "verified", reason: "fixture", confines },
  });
  return {
    workerRestartPending: false,
    platform,
    enabled: requestedSandbox,
    available: platform === "darwin" || platform === "linux" || platform === "win32",
    kind: platform === "win32" ? "partial" : "full",
    reason: "",
    confines,
    shellExecutionPlan: getHostShellExecutionPlanAuditProjection(plan),
    runtime: { available: active, kind: active ? (platform === "win32" ? "partial" : "full") : "none", reason: "" },
    shell: plan.mode === "asrt"
      ? { state: "on", setting: requestedSandbox, envForced: false, causes: [] }
      : requestedSandbox
        ? { state: "unavailable", setting: true, envForced: false, causes: ["shell-not-contained"] }
        : { state: "off", setting: false, envForced: false, causes: [] },
  };
}

describe("SandboxStatusBadge", () => {
  beforeEach(() => setLocale("ko"));
  it.each(["en", "ko"] as const)("shows an unavailable reason in %s without a dismiss control", (locale) => {
    const { container } = render(
      <I18nProvider locale={locale} setLocale={() => undefined}>
        <SandboxStatusBadge capability={capability()} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent(locale === "en" ? "Sandbox off · isolation could not start" : "샌드박스 꺼짐 · 격리를 시작하지 못함");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows settings-off even though the platform can support isolation", () => {
    render(<SandboxStatusBadge capability={capability({ requestedSandbox: false })} />);
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("설정에서 비활성화됨");
  });

  it("shows unsupported platform status", () => {
    render(<SandboxStatusBadge capability={capability({ platform: "freebsd", requestedSandbox: false })} />);
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("지원하지 않는 플랫폼");
  });

  it("does not mistake a partial runtime for shell isolation", () => {
    render(<SandboxStatusBadge capability={capability({ platform: "win32", active: true })} />);
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("셸 격리 사용 불가");
  });

  it.each(["darwin", "linux"] as const)("hides only when the host shell plan is sandboxed on %s", (platform) => {
    render(<SandboxStatusBadge capability={capability({ platform, active: true })} />);
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
  });

  it("lets the boot-sealed active plan override a pending settings-off change", () => {
    const active = { ...capability({ active: true }), enabled: false };
    render(<SandboxStatusBadge capability={active} />);
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
  });

  it("does not infer shell state from a legacy runtime snapshot without a plan", () => {
    const legacy = { ...capability({ active: true }), enabled: false, shellExecutionPlan: undefined };
    render(<SandboxStatusBadge capability={legacy} />);
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
  });

  it("uses the host fallback reason even if platform potential is unavailable", () => {
    const disabled = { ...capability({ requestedSandbox: false }), available: false };
    render(<SandboxStatusBadge capability={disabled} />);
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("설정에서 비활성화됨");
  });

  it.each(["en", "ko"] as const)("shows failed status queries as unknown in %s and offers recovery", (locale) => {
    const onRetry = vi.fn();
    render(<I18nProvider locale={locale} setLocale={() => undefined}>
      <SandboxStatusBadge capability={capability({ active: true })} statusQueryFailed onRetry={onRetry} />
    </I18nProvider>);
    expect(screen.getByTestId("sandbox-status-query-failed")).toHaveTextContent(locale === "en" ? "Sandbox status unknown" : "샌드박스 상태 확인 불가");
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("SandboxStatusBadge — extension backend", () => {
  beforeEach(() => setLocale("en"));
  function withExtensionPlan(readiness: SandboxWindowsExtensionPlan["readiness"], requested = true): SandboxCapabilityInfo {
    const selectedBackend = readiness === "ready" ? "mxc" : readiness === "fallback" ? "srt-win" : "none";
    const extensionPlan: SandboxWindowsExtensionPlan = {
      requestedBackend: requested ? "mxc" : "none", selectedBackend, readiness,
      reason: readiness === "off" ? "not-requested" : readiness === "ready" ? "ready" : readiness === "checking" ? "checking"
        : readiness === "rejected" ? "readiness-deadline" : "native-validation-required",
      fallbackVersion: selectedBackend === "srt-win" ? "0.0.80" : null, uiPolicy: "ui-enabled",
      egressIdentity: selectedBackend === "mxc" ? "kernel-channel" : "shared", proxyOwnerVerified: false,
      hostLoopback: "bidirectional", inboundProtection: "host-firewall", dnsProtection: "host-resolver",
      ancestorAccess: "query-enumerate-only", ancestorNameExposure: true,
    };
    // Healthy contained shells: the shell badge stays hidden, so only the extension state can show.
    return {
      ...capability({ active: true }),
      windowsSubstrate: {
      mxc: { state: "available" }, windowsBuild: "10.0.26300", srtWinReady: selectedBackend === "srt-win", shells: "mxc", shellLocalNetworkAccess: true,
        extensions: selectedBackend, extensionPlan, shellEgressIdentity: "kernel-channel", extensionEgressIdentity: extensionPlan.egressIdentity,
      },
    };
  }

  it.each([
    ["checking", "sandboxStatus.extensionsChecking"],
    ["rejected", "sandboxStatus.extensionsRejected"],
    ["fallback", "sandboxStatus.extensionsFallback"],
    ["unavailable", "sandboxStatus.extensionsUnavailable"],
  ] as const)("warns about a requested %s extension plan while shells are healthy", (readiness, key) => {
    render(<SandboxStatusBadge capability={withExtensionPlan(readiness)} />);
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
    const badge = screen.getByTestId("sandbox-extension-status");
    expect(badge).toHaveAttribute("data-readiness", readiness);
    expect(t(key)).not.toBe(key);
    expect(badge).toHaveTextContent(t(key));
  });

  it("shows nothing for a ready container selection or unrequested extension confinement", () => {
    const { rerender, container } = render(<SandboxStatusBadge capability={withExtensionPlan("ready")} />);
    expect(container.firstChild).toBeNull();
    rerender(<SandboxStatusBadge capability={withExtensionPlan("off", false)} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows nothing without a Windows substrate", () => {
    const { container } = render(<SandboxStatusBadge capability={{ ...capability({ active: true }), windowsSubstrate: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it.each(["en", "ko"] as const)("renders every extension badge from a real %s key", (locale) => {
    setLocale(locale);
    for (const readiness of ["checking", "rejected", "fallback", "unavailable"] as const) {
      const { unmount } = render(<SandboxStatusBadge capability={withExtensionPlan(readiness)} />);
      expect(screen.getByTestId("sandbox-extension-status").textContent).not.toContain("sandboxStatus.");
      unmount();
    }
  });
});

describe("SandboxStatusBadge — Windows MXC check settling after boot", () => {
  beforeEach(() => setLocale("ko"));
  const substrate = (mxc: "checking" | "available") => ({
      mxc: { state: mxc }, windowsBuild: "10.0.26300", srtWinReady: false, shellLocalNetworkAccess: true,
    shells: mxc === "available" ? "mxc" : "approved-host", extensions: "none",
    shellEgressIdentity: mxc === "available" ? "kernel-channel" : "shared", extensionEgressIdentity: "shared",
  }) as NonNullable<SandboxCapabilityInfo["windowsSubstrate"]>;
  // What main serves while the PowerShell start probe runs: the interim (approved-host) plan.
  const checking: SandboxCapabilityInfo = { ...capability({ platform: "win32", active: true }), windowsSubstrate: substrate("checking") };
  // What main serves once the probe settled: shells run in MXC containers.
  const settled: SandboxCapabilityInfo = {
    ...checking,
    windowsSubstrate: substrate("available"),
    shellExecutionPlan: getHostShellExecutionPlanAuditProjection(buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: { kind: "asrt", platform: "win32", confidence: "verified", reason: "MXC fixture", confines: { filesystem: true, process: true, network: true } },
      shellSubstrate: "mxc",
    })),
  };

  function LiveBadge({ permission }: { permission: Parameters<typeof useSandboxCapability>[0] }) {
    const { capability: live, statusQueryFailed } = useSandboxCapability(permission);
    return <SandboxStatusBadge capability={live} statusQueryFailed={statusQueryFailed} />;
  }

  it.each(["en", "ko"] as const)("does not claim a deferred probe is running with consent off in %s", locale => {
    setLocale(locale);
    render(<SandboxStatusBadge capability={{ ...checking,
      windowsSubstrate: { ...substrate("checking"), shellLocalNetworkAccess: false } }} />);
    expect(screen.queryByTestId("sandbox-checking-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("sandbox-off-status")).toBeInTheDocument();
  });

  it("shows the check as in progress rather than as the sandbox being off", () => {
    expect(checking.shellExecutionPlan?.fallbackReason).toBe("windows-partial-shell-acl-unsafe");
    render(<SandboxStatusBadge capability={checking} />);
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
    expect(screen.getByTestId("sandbox-checking-status").textContent)
      .toBe("샌드박스 확인 중 · 끝날 때까지 셸 명령은 샌드박스 없이 호스트에서 실행되며 현재 모드에 따라 승인됨");
  });

  it("still reports a settled unavailable result as off", () => {
    const unavailable: SandboxCapabilityInfo = {
      ...checking,
      windowsSubstrate: { ...substrate("checking"), mxc: { state: "unavailable", reason: "unverified-session" } },
    };
    render(<SandboxStatusBadge capability={unavailable} />);
    expect(screen.queryByTestId("sandbox-checking-status")).toBeNull();
    expect(screen.getByTestId("sandbox-off-status")).toHaveTextContent("셸 격리 사용 불가");
  });

  it("clears the chip when main reports the settle, without a reload", async () => {
    let notify: (() => void) | undefined;
    const permission = {
      sandboxCapability: vi.fn().mockResolvedValueOnce(checking).mockResolvedValue(settled),
      onSandboxCapabilityChanged: vi.fn((cb: () => void) => { notify = cb; return () => { notify = undefined; }; }),
    };
    render(<LiveBadge permission={permission} />);
    await waitFor(() => expect(screen.getByTestId("sandbox-checking-status")).toBeInTheDocument());

    await act(async () => { notify?.(); });

    await waitFor(() => expect(screen.queryByTestId("sandbox-checking-status")).toBeNull());
    expect(screen.queryByTestId("sandbox-off-status")).toBeNull();
    expect(permission.sandboxCapability).toHaveBeenCalledTimes(2);
  });
});
