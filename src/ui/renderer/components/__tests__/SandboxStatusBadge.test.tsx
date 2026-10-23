// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCapabilityInfo } from "../../../../shared/sandbox-capability-info.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../../permissions/host-shell-execution-plan.js";
import { setLocale } from "../../../../i18n/runtime.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { SandboxStatusBadge } from "../SandboxStatusBadge.js";

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
    platform,
    enabled: requestedSandbox,
    available: platform === "darwin" || platform === "linux" || platform === "win32",
    kind: platform === "win32" ? "partial" : "full",
    reason: "",
    confines,
    shellExecutionPlan: getHostShellExecutionPlanAuditProjection(plan),
    runtime: { available: active, kind: active ? (platform === "win32" ? "partial" : "full") : "none", reason: "" },
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
