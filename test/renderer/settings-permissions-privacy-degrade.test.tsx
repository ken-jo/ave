// The Windows peer's privacy-degraded boot, reached the way a user reaches it: open Settings and press the Permissions tab.
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { activeSettingsTab, clickSettingsTab } from "./helpers.js";
import { t } from "../../src/i18n/index.js";
import { assertSandboxWindowsExtensionPlan, type SandboxWindowsExtensionPlan } from "../../src/shared/sandbox-capability-info.js";

afterEach(() => vi.restoreAllMocks());

const homePrivacyError = {
  path: "D:/ave-home", category: "extra-principals" as const, approvedForSession: false,
  extraPrincipals: [{ sid: "S-1-5-11", account: "NT AUTHORITY\\Authenticated Users" }],
};
const extensionPlan: SandboxWindowsExtensionPlan = {
  requestedBackend: "mxc", selectedBackend: "none", fallbackVersion: null, uiPolicy: "ui-enabled", egressIdentity: "shared",
  proxyOwnerVerified: false, hostLoopback: "bidirectional", inboundProtection: "host-firewall", dnsProtection: "host-resolver",
  ancestorAccess: "query-enumerate-only", ancestorNameExposure: true, readiness: "unavailable", reason: "native-validation-required",
};
const snapshot = {
  platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
  runtime: { available: false, kind: "none", reason: "r" },
  confines: { filesystem: true, process: false, network: true },
  homePrivacyError,
  boot: { action: "degrade", reason: "degrade-ave-home-privacy-failed", onSignal: "default-settings", causes: ["ave-home-privacy-failed"] },
  shell: { state: "unavailable", setting: true, envForced: true, causes: ["ave-home-privacy-failed"] },
  windowsSubstrate: {
    mxc: { state: "available" }, windowsBuild: "10.0.26300.9711", srtWinReady: false,
    shells: "none", extensions: "none", shellEgressIdentity: "shared", extensionEgressIdentity: "shared", extensionPlan,
  },
};

async function openPermissions(panelCall: "resolve" | "reject" | "hang") {
  assertSandboxWindowsExtensionPlan(extensionPlan);
  const { container, emitViewActivate } = await renderApp({ hasApiKey: true });
  const ns = (window as unknown as { ave: { permission: Record<string, unknown>; policy?: unknown } }).ave;
  const dirList = { ok: true, verb: "list", defaults: [], userAdditions: [], effective: [] };
  Object.assign(ns.permission, {
    sandboxCapability: vi.fn(async () => snapshot),
    sandboxWindowsStatus: vi.fn(async () => ({ applicable: true, userState: "absent", wfpState: "absent", ready: false, instructions: "", homePrivacyError })),
    sandboxWindowsInstall: vi.fn(async () => ({ cancelled: true })),
    approveExtensionsWithoutIsolation: vi.fn(async () => ({ ok: true })),
    hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
    // One of the panel-load calls the OS sandbox section does not read; the peer's tab showed no section at all.
    dirDispatch: vi.fn(() => panelCall === "resolve" ? Promise.resolve(dirList)
      : panelCall === "reject" ? Promise.reject(new Error("directory policy unavailable")) : new Promise(() => undefined)),
    reviewerDispatch: vi.fn(async () => ({ ok: true, verb: "show", settings: { mode: "disabled", fallbackOnError: "deny" } })),
  });
  ns.policy ??= { get: vi.fn(async () => ({ requireExplicitApproval: true, managed: false, source: "defaults" })), set: vi.fn(async () => ({ ok: true })) };

  await act(async () => { emitViewActivate("settings", "llm"); });
  await waitFor(() => expect(activeSettingsTab(container)).toBe("llm"));
  await act(async () => { clickSettingsTab(container, "permissions"); });
  await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
  return container;
}

const reason = () => t("permissionsTab.homePrivacyExtraPrincipals", { principals: "S-1-5-11 (NT AUTHORITY\\Authenticated Users)" });

async function expectDisclosure(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.querySelector('[data-testid="os-sandbox-boot-degraded"]')).toBeTruthy());
  expect(container.querySelector('[data-testid="os-sandbox-boot-degraded-detail"]')?.textContent)
    .toBe(t("permissionsTab.osSandboxBootDegradedHomePrivacy", { path: "D:/ave-home", reason: reason() }));
  const substrate = container.querySelector<HTMLElement>('[data-testid="os-sandbox-windows-substrate"]');
  expect(substrate?.dataset.mxc).toBe("available");
  expect(substrate?.dataset.shells).toBe("none");
  expect(container.querySelector('[data-testid="os-sandbox-windows-mxc-unused"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="os-sandbox-windows-substrate-extensions"]')?.getAttribute("data-readiness")).toBe("unavailable");
  await waitFor(() => expect(container.querySelector('[data-testid="os-sandbox-windows-home-privacy-error"]')).toBeTruthy());
}

describe("Settings → Permissions with an AVE_HOME privacy degrade (native peer snapshot)", () => {
  it("mounts the OS sandbox section with the degraded reason, the substrate and the privacy panel", async () => {
    const errors = vi.spyOn(console, "error");
    const container = await openPermissions("resolve");
    await waitFor(() => expect(container.querySelector('[data-testid="os-sandbox-toggle"]')).toBeTruthy());
    await expectDisclosure(container);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("render error in boundary"))).toEqual([]);
  });

  it("keeps the disclosure when an unrelated panel load fails, without stating an unread toggle", async () => {
    const container = await openPermissions("reject");
    await waitFor(() => expect(container.querySelector('[data-testid="permissions-load-error"]')).toBeTruthy());
    await expectDisclosure(container);
    // The stored settings were never read, so the rows that would say on/off are not drawn.
    expect(container.querySelector('[data-testid="os-sandbox-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="worker-confinement-toggle"]')).toBeNull();
  });

  it("keeps the disclosure while an unrelated panel load is still pending", async () => {
    const container = await openPermissions("hang");
    expect(container.querySelector('[data-testid="permissions-loading"]')).toBeTruthy();
    await expectDisclosure(container);
    expect(container.querySelector('[data-testid="os-sandbox-toggle"]')).toBeNull();
  });
});
