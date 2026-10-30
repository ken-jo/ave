// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { installMockAveApi, mockJudgeGet } from "../../../../../test/renderer/mock-ave-api.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// The real preload surface is used by the gesture test below; its ipcRenderer is routed to a fake main per test.
const { ipcInvoke, mainHandlers } = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mainHandlers.set(channel, handler) },
  ipcRenderer: { invoke: ipcInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

vi.mock("../../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { PermissionsTab } from "../PermissionsTab.js";
import { makeHookTrustRow as hook } from "./test-helpers.js";
import { renderPermissionsTab } from "./support/render-permissions-tab.js";
import type { HookTrustRow, PermissionReviewerDispatchResult, ScopedPermissionRuleError } from "../../types.js";
import { isPolicyUserEditable, type AdminPolicyDiagnostic, type PolicySource } from "../../../../shared/policy-editability.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { TEST_IDS, execModeTestId } from "../../../../shared/test-ids.js";
import { LONG_TOAST_TTL_MS } from "../../constants.js";
import { buildInternalApiSurface } from "../../../../preload/internal-api-surface.js";
import { PERMISSIONS } from "../../../../shared/ipc-channels.js";
import { hostFrameEvent } from "../../../../__tests__/test-helpers.js";
import { setProcessPlatform } from "../../../../__tests__/support/process-platform.js";

/** Mirrors the `PERMISSIONS.policyGet` handler: the host attaches `editable` from the real predicate.
 * Built here the same way so a renderer that goes back to reading `managed` directly fails these tests. */
function policyGetPayload(loaded: {
  requireExplicitApproval: boolean;
  managed: boolean;
  source: PolicySource;
  adminPath?: string;
} & AdminPolicyDiagnostic) {
  return { version: 1 as const, updatedAt: "2026-01-01T00:00:00.000Z", ...loaded, editable: isPolicyUserEditable(loaded) };
}

function reviewerResult(
  verb: "show" | "mode" | "fallback",
  mode: "disabled" | "llm",
  fallbackOnError: "deny" | "rule",
) {
  return {
    ok: true as const, verb,
    settings: { mode, fallbackOnError },
  };
}

function installApi(
  disabledBatches: HookTrustRow[][],
  envForcedSettings: readonly string[] = [],
) {
  const hookTrustList = vi.fn(async () => {
    const disabled = disabledBatches.shift() ?? [];
    return { ok: true as const, active: [], disabled, totalDisabled: disabled.length };
  });
  const ave = {
    relaunchApp: vi.fn<() => Promise<import("../../../../shared/app-relaunch.js").AppRelaunchResult>>(async () => ({ ok: true })),
    permission: {
      recentlyDeniedList: vi.fn(async () => ({ ok: true as const, entries: [], total: 0 })),
      onRecentlyDeniedChanged: vi.fn(() => () => undefined),
      egressGrantsList: vi.fn(async () => ({ ok: true as const, grants: [] })),
      egressGrantRevoke: vi.fn(async () => ({ ok: true as const })),
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      onConfigChanged: vi.fn(() => () => undefined),
      judgeGet: mockJudgeGet(),
      listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
      addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
      removeRule: vi.fn(async () => ({ ok: true })),
      recentlyDeniedRerun: vi.fn(async () => ({ ok: true })),
      auditShow: vi.fn(async () => ({ ok: true as const, entries: [], total: 0, summary: { files: 0, bytes: 0 } })),
      auditVerify: vi.fn(async () => ({ ok: true as const, intact: true, totalFiles: 0, totalEntries: 0, perDay: [] })),
      hookTrustList,
      dirDispatch: vi.fn(async () => ({
        ok: true as const,
        verb: "list" as const,
        defaults: [],
        userAdditions: [],
        effective: [],
      })),
      reviewerDispatch: vi.fn<(rawArgs: string) => Promise<PermissionReviewerDispatchResult>>(async (rawArgs: string) => {
        if (rawArgs === "show") {
          return reviewerResult("show", "disabled", "deny");
        }
        if (rawArgs === "mode llm") {
          return reviewerResult("mode", "llm", "deny");
        }
        if (rawArgs === "mode disabled") {
          return reviewerResult("mode", "disabled", "deny");
        }
        if (rawArgs === "fallback rule") {
          return reviewerResult("fallback", "llm", "rule");
        }
        throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
      }),
      sandboxCapability: vi.fn(async () => ({
        platform: "linux" as NodeJS.Platform,
        enabled: false,
        available: true,
        kind: "full" as const,
        reason: "ASRT (bwrap) confines filesystem, process, and network egress when enabled",
        potentialReason: "ASRT (bwrap) confines filesystem, process, and network egress when enabled",
        runtime: {
          available: false,
          kind: "none" as const,
          reason: "no OS sandbox configured for the host process",
        },
        workerRuntime: {
          available: false,
          kind: "none" as "none" | "full" | "partial",
          reason: "no OS sandbox configured for the host process",
        },
        confines: { filesystem: true, process: true, network: true },
      })),
    },
    policy: {
      get: vi.fn(async () => policyGetPayload({
        requireExplicitApproval: true,
        managed: false,
        source: "defaults",
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
    userApproval: {
      list: vi.fn(async () => []),
      listSession: vi.fn(async () => []),
      record: vi.fn(async () => ({ ok: true })),
      revokeByKey: vi.fn(async () => ({ ok: true })),
    },
  };
  (globalThis as unknown as { window: typeof window }).window.ave = ave as never;
  const api = installMockAveApi({
    settings: { features: { osToolSandbox: false } },
    envForcedSettings,
  });
  api.relaunchApp = ave.relaunchApp;
  return ave;
}

beforeEach(() => {
  delete (window as unknown as { ave?: unknown }).ave;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ave?: unknown }).ave;
});

describe("PermissionsTab hook quarantine notice", () => {
  it("cancels a pending banner on unmount without a later state update or error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expiry = vi.fn();
    const schedule = globalThis.setTimeout;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === LONG_TOAST_TTL_MS) return schedule(() => { expiry(); callback(); }, delay);
      return schedule(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const api = installApi([[]]);
      api.permission.setMode.mockResolvedValueOnce({ ok: false, mode: "default" });
      const view = await act(async () => render(<PermissionsTab />));
      await act(async () => { fireEvent.click(screen.getByTestId(execModeTestId("auto"))); });
      expect(screen.getByText(t("permissionsTab.errorModeChangeFailed")).closest('[role="alert"]')).toBeTruthy();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(LONG_TOAST_TTL_MS + 1); });

      expect(expiry).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      cleanup();
      timeout.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("saves a permanent deny for the exact pending tool and canonical input", async () => {
    const api = installApi([[]]);
    const onExactDenySaved = vi.fn();
    const onDiscardExactDeny = vi.fn();

    await act(async () => {
      render(
        <PermissionsTab
          exactDenyDraft={{
            requestId: "approval-exact-1",
            toolName: "plugin:meeting_list_preps",
            args: { z: 2, a: 1 },
            source: "plugin",
            trustOrigin: "plugin-emitted",
            approvalCacheKey: "meeting:list-preps",
            verdictAtApproval: "medium",
          }}
          onExactDenySaved={onExactDenySaved}
          onDiscardExactDeny={onDiscardExactDeny}
        />,
      );
    });

    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("plugin:meeting_list_preps");
    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("이후의 일치하는 요청을 거부");
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-exact-deny"));
    });

    expect(api.userApproval.record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "approval-exact-1",
      toolName: "plugin:meeting_list_preps",
      args: '{"a":1,"z":2}',
      source: "plugin",
      decision: "deny",
      scope: "persistent",
      trustOrigin: "plugin-emitted",
      approvalCacheKey: "meeting:list-preps",
    }));
    expect(onExactDenySaved).toHaveBeenCalledWith("approval-exact-1");
    expect(onDiscardExactDeny).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.settingsPageTitle)).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("plugin:meeting_list_preps");
  });

  it("keeps an exact-deny draft focused and cancellable when unrelated Settings loading fails", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockRejectedValueOnce(new Error("settings unavailable"));
    const onDiscardExactDeny = vi.fn();

    render(
      <PermissionsTab
        exactDenyDraft={{
          requestId: "approval-exact-load-failure",
          toolName: "bash",
          args: { command: "Remove-Item C:\\tmp\\artifact" },
          source: "builtin",
          verdictAtApproval: "high",
        }}
        onDiscardExactDeny={onDiscardExactDeny}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("permissions-load-error"))
      .toHaveTextContent(t("permissionsTab.errorLoadFailed")));
    // The thrown text is logged, not shown.
    expect(screen.getByTestId("permissions-load-error").textContent).not.toContain("settings unavailable");
    expect(screen.getByTestId("exact-deny-draft")).toHaveTextContent("bash");
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.cancelButton") }));
    expect(onDiscardExactDeny).toHaveBeenCalledTimes(1);
  });

  it("refocuses the editor when the same pending request re-enters from the dock", async () => {
    installApi([[]]);
    const draft = {
      requestId: "approval-exact-reenter",
      toolName: "read_file",
      args: { path: "C:\\workspace\\notes.md" },
      source: "builtin" as const,
      verdictAtApproval: "low" as const,
    };
    const { rerender } = render(<PermissionsTab exactDenyDraft={draft} />);
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());

    screen.getByTestId(TEST_IDS.settingsPageTitle).focus();
    expect(screen.getByTestId(TEST_IDS.settingsPageTitle)).toHaveFocus();
    rerender(<PermissionsTab exactDenyDraft={{ ...draft }} />);

    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());
  });

  it("returns focus to the live dock Settings link after exact-deny cancellation", async () => {
    installApi([[]]);

    function FocusHarness() {
      const [draft, setDraft] = useState<{
        requestId: string;
        toolName: string;
        args: unknown;
        source: "builtin";
        verdictAtApproval: "low";
      } | null>({
        requestId: "approval-exact-cancel-focus",
        toolName: "read_file",
        args: { path: "C:\\workspace\\notes.md" },
        source: "builtin" as const,
        verdictAtApproval: "low" as const,
      });
      return (
        <>
          <button type="button" data-testid={TEST_IDS.openPermanentDenySettings}>
            Return to exact deny
          </button>
          <PermissionsTab
            exactDenyDraft={draft}
            onDiscardExactDeny={() => setDraft(null)}
          />
        </>
      );
    }

    render(<FocusHarness />);
    await waitFor(() => expect(screen.getByTestId("exact-deny-focus-target")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.cancelButton") }));

    await waitFor(() => expect(screen.getByTestId(TEST_IDS.openPermanentDenySettings)).toHaveFocus());
    expect(screen.queryByTestId("exact-deny-draft")).toBeNull();
  });

  it("opens the audit log inside its own settings section, in the pane", async () => {
    installApi([[]]);

    await renderPermissionsTab();

    const section = document.querySelector<HTMLElement>('[data-settings-section="permissions-audit-log"]')!;
    expect(section.querySelector('[data-testid="audit-panel"]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.auditLogOpenButton") }));
    });

    // The log is a region of THIS section: it takes the pane's width and pushes what follows down. It is not
    // a panel fixed to the window edge, which covered the tiles beside the Settings pane and the title bar.
    const panel = await waitFor(() => {
      const el = section.querySelector<HTMLElement>('[data-testid="audit-panel"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(panel.className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(screen.queryByRole("button", { name: t("permissionsTab.auditLogOpenButton") })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("audit-panel-close"));
    });
    expect(section.querySelector('[data-testid="audit-panel"]')).toBeNull();
    expect(screen.getByRole("button", { name: t("permissionsTab.auditLogOpenButton") })).toBeTruthy();
  });

  it("shows the four user-facing permission policy choices and their read behavior", async () => {
    installApi([[]]);

    await renderPermissionsTab();

    expect(screen.getByTestId(execModeTestId("default"))).toHaveTextContent("쓰기 허용");
    expect(screen.getByTestId(execModeTestId("default"))).toHaveTextContent("복구 가능한 프로젝트 파일 변경");
    expect(screen.getByTestId(execModeTestId("strict"))).toHaveTextContent("기본");
    expect(screen.getByTestId(execModeTestId("strict"))).toHaveTextContent("일반 읽기와 읽기 전용으로 입증된 샌드박스 명령을 허용");
    expect(screen.getByTestId(execModeTestId("auto"))).toHaveTextContent("auto");
    expect(screen.getByTestId(execModeTestId("auto"))).toHaveTextContent("나머지는 리뷰어가 검증");
    expect(screen.getByTestId(execModeTestId("allow"))).toHaveTextContent("허용");
  });

  it("keeps the rendered mode unchanged when durable mode confirmation fails", async () => {
    const api = installApi([[]]);
    api.permission.setMode.mockResolvedValueOnce({
      ok: false,
      error: "approval-denied",
      message: "사용자가 모드 변경을 거부했습니다.",
    });

    await renderPermissionsTab();

    expect(screen.getByTestId(execModeTestId("default"))).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith("mode llm");
    // main's free-text message is logged; the screen shows localized copy and the code.
    expect(screen.getByText("실행 모드 변경에 실패했습니다. (approval-denied)")).toBeTruthy();
    expect(screen.queryByText("사용자가 모드 변경을 거부했습니다.")).toBeNull();
    const defaultButton = screen.getByTestId(execModeTestId("default"));
    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(defaultButton.className).toContain("border-primary");
    expect(autoButton.className).not.toContain("border-primary");
  });

  it("marks the returned mode active after durable mode confirmation succeeds", async () => {
    const api = installApi([[]]);

    await renderPermissionsTab();

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show", "mode llm"]);
    expect(api.permission.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      api.permission.reviewerDispatch.mock.invocationCallOrder.at(-1)!,
    );
    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(autoButton.className).toContain("border-primary");
  });

  it("maps full allow policy to allow mode and disables background reviewer", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return reviewerResult("show", "llm", "deny");
      }
      if (rawArgs === "mode disabled") {
        return reviewerResult("mode", "disabled", "deny");
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("allow")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode disabled");
    expect(api.permission.setMode).toHaveBeenCalledWith("allow");
    expect(api.permission.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      api.permission.reviewerDispatch.mock.invocationCallOrder.at(-1)!,
    );
    expect(screen.getByTestId(execModeTestId("allow")).className).toContain("border-primary");
  });

  it("hydrates the active mode from durable settings on mount", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });

    await renderPermissionsTab();

    const autoButton = screen.getByTestId(execModeTestId("auto"));
    expect(autoButton.className).toContain("border-primary");
  });

  it("does not render the notice when no hooks are quarantined", async () => {
    installApi([[]]);
    let container: HTMLElement;
    await act(async () => {
      const rendered = render(<PermissionsTab />);
      container = rendered.container;
    });

    expect(container!.querySelector('[data-testid="hook-quarantine-notice"]')).toBeNull();
  });

  it("renders a non-modal notice with the hooks list slash path", async () => {
    installApi([[hook("pre-scan.sh")]]);
    await renderPermissionsTab();

    expect(screen.getByTestId("hook-quarantine-notice")).toBeTruthy();
    expect(screen.getByText("검토 대기 1")).toBeTruthy();
    expect(screen.getByText("/permission hooks list")).toBeTruthy();
    expect(screen.getByText("pre-scan.sh")).toBeTruthy();
  });

  it("clears the notice after the quarantined list becomes empty", async () => {
    const api = installApi([[hook("pre-scan.sh")], []]);
    await renderPermissionsTab();
    expect(screen.getByTestId("hook-quarantine-notice")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByText("새로고침")[0]);
    });

    expect(api.permission.hookTrustList).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("hook-quarantine-notice")).toBeNull();
  });

  it("does not render the reviewer settings section", async () => {
    const api = installApi([[]]);

    await renderPermissionsTab();

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("show");
    expect(screen.getAllByText("명시 액션 필수").length).toBeGreaterThan(0);

    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.queryByTestId("reviewer-cli-mapping-panel")).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.reviewerPromptPanel)).toBeNull();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-llm-degraded-banner")).toBeNull();
  });

  it("keeps hidden reviewer auto-wiring and shows only the prompt collapse inside auto", async () => {
    const api = installApi([[]]);

    await renderPermissionsTab();

    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show", "mode llm"]);
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.queryByText("검증 프롬프트")).toBeNull();
    expect(screen.getByTestId("reviewer-system-prompt")).toHaveTextContent("UNTRUSTED_INPUT");
    expect(screen.queryByTestId("reviewer-mode-llm")).toBeNull();
    expect(screen.queryByTestId("reviewer-mode-disabled")).toBeNull();
  });

  it("refreshes an already-open Settings tab when another window changes permission mode", async () => {
    const api = installApi([[]]);
    api.permission.getMode
      .mockResolvedValueOnce({ mode: "default" })
      .mockResolvedValue({ mode: "auto" });

    await renderPermissionsTab();

    expect(screen.queryByTestId(TEST_IDS.reviewerPromptPanel)).toBeNull();
    const onModeChanged = api.permission.onModeChanged.mock.calls[0]?.[0] as ((mode: string) => void) | undefined;
    expect(onModeChanged).toBeTruthy();

    await act(async () => {
      onModeChanged?.("auto");
    });

    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
  });

  it("does not expose the reviewer fallback policy in Settings", async () => {
    const api = installApi([[]]);

    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(screen.queryByTestId("reviewer-fallback-select")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^fallback\b/),
    );
  });

  it("offers the reviewer model through the chat model chooser, not legacy provider/model controls", async () => {
    const api = installApi([[]]);
    (api.permission as Record<string, unknown>).judgeGet = mockJudgeGet({
      chatModel: "openai/chat-model",
      modelOptions: [{ vendor: "claude", model: "claude-reviewer" }],
    });

    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    const picker = await screen.findByTestId("permission-reviewer-model");
    // Unset is a stored choice that names what it follows: the chat model.
    expect(picker).toHaveTextContent(t("permissionJudge.followChatModelNamed", { model: "openai/chat-model" }));
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(api.permission.reviewerDispatch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(provider|model)\b/),
    );
  });

  it("saves a picked reviewer model, and unset again, through the judge settings", async () => {
    const api = installApi([[]]);
    const judgeGet = mockJudgeGet({
      chatModel: "openai/chat-model",
      modelOptions: [{ vendor: "claude", model: "claude-reviewer" }],
    });
    const judgeSet = vi.fn(async (settings: { model: unknown }) => ({
      ...(await judgeGet()), settings: { ...(await judgeGet()).settings, model: settings.model },
    }));
    Object.assign(api.permission, { judgeGet, judgeSet });

    await renderPermissionsTab();
    const picker = await screen.findByTestId("permission-reviewer-model");
    const pick = async (label: RegExp) => {
      fireEvent.keyDown(picker, { key: "ArrowDown" });
      const option = await waitFor(() => {
        const found = [...document.querySelectorAll<HTMLElement>("[role='option']")]
          .find((row) => label.test(row.textContent ?? ""));
        if (!found) throw new Error("chooser not open yet");
        return found;
      });
      option.focus();
      fireEvent.keyDown(option, { key: "Enter" });
    };
    const save = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: t("permissionJudge.save") }));
      });
    };

    await pick(/claude-reviewer/);
    await save();
    expect(judgeSet).toHaveBeenLastCalledWith(expect.objectContaining({
      model: { vendor: "claude", model: "claude-reviewer" },
    }));

    await pick(new RegExp(t("permissionJudge.followChatModel")));
    await save();
    expect(judgeSet).toHaveBeenLastCalledWith(expect.objectContaining({ model: null }));
  });

  it("says so when the selected reviewer model is unavailable", async () => {
    const api = installApi([[]]);
    (api.permission as Record<string, unknown>).judgeGet = mockJudgeGet({
      model: { vendor: "claude", model: "retired-reviewer" },
      reviewerModelUnavailable: true,
    });

    await renderPermissionsTab();

    expect(await screen.findByTestId("permission-reviewer-model-unavailable"))
      .toHaveTextContent(t("permissionJudge.reviewerModelUnavailable"));
    expect(screen.getByTestId("permission-reviewer-model")).toHaveTextContent("retired-reviewer");
  });

  it.each(["en", "ko"] as const)("shows the reviewer model choices without a threshold control in auto (%s)", async (locale) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const api = installApi([[]]);
      api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
      api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
        if (rawArgs === "show") {
          return reviewerResult("show", "llm", "deny");
        }
        throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
      });

      await renderPermissionsTab();
      expect(screen.queryByTestId("interactive-auto-approve-select")).toBeNull();
      const behavior = screen.getByTestId("auto-review-behavior");
      const expected = locale === "en"
        ? ["low and medium risk", "accept it", "cite your instructions once for another review", "or ask you", "Review errors or interruptions ask you", "one-time approval without review"]
        : ["저·중위험은 허용", "거부를 받아들이거나", "사용자의 지시를 근거로 한 번 더 검토를 요청하거나", "사용자에게 확인을 요청", "오류나 검증 중단은 사용자에게 확인", "리뷰어를 거치지 않고 이번 한 번 승인"];
      for (const outcome of expected) expect(behavior).toHaveTextContent(outcome);
      expect(api.permission.reviewerDispatch).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
      expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
      expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    } finally {
      setLocale(previousLocale);
    }
  });

  it("surfaces the reviewer rewire failure when entering the auto-verification mode", async () => {
    const api = installApi([[]]);
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return reviewerResult("show", "disabled", "deny");
      }
      if (rawArgs === "mode llm") {
        return { ok: false as const, error: "reviewer-rewire-failed: missing provider" };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });

    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    // The exec mode switch succeeds, but the auto-wired `mode llm` reviewer dispatch fails → surface the rewire-failure banner.
    expect(api.permission.setMode).toHaveBeenCalledWith("auto");
    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
    expect(screen.getByText(/이전 설정으로 복원했습니다/)).toBeTruthy();
    // The rewire detail is a raw exception message from main: logged, not shown.
    expect(document.body.textContent).not.toContain("missing provider");
  });

  it("adds and removes additional directories through the slash-backed IPC", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: [],
          effective: [],
        };
      }
      if (rawArgs === "allow /tmp/ave-extra") {
        return {
          ok: true as const,
          verb: "allow" as const,
          persisted: ["/tmp/ave-extra"],
          sessionOnly: false,
          warnings: [],
        };
      }
      return {
        ok: true as const,
        verb: "deny" as const,
        persisted: [],
      };
    });

    await renderPermissionsTab();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("경로 (예: ~/Documents/project)"), {
        target: { value: "/tmp/ave-extra" },
      });
      fireEvent.click(screen.getAllByText("추가").at(-1)!);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("allow /tmp/ave-extra");
    expect(screen.getByText("/tmp/ave-extra")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByText("✕").at(-1)!);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("deny /tmp/ave-extra");
  });

  it("keeps the settings pane scroll position after removing an additional directory", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: ["/tmp/a", "/tmp/b", "/tmp/c"],
          effective: ["/tmp/a", "/tmp/b", "/tmp/c"],
        };
      }
      if (rawArgs === "deny /tmp/b") {
        return {
          ok: true as const,
          verb: "deny" as const,
          persisted: ["/tmp/a", "/tmp/c"],
        };
      }
      throw new Error(`unexpected dirDispatch: ${rawArgs}`);
    });
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    await act(async () => {
      render(
        <div className="ave-settings-scroll">
          <PermissionsTab />
        </div>,
      );
    });

    const scroller = document.querySelector<HTMLElement>(".ave-settings-scroll")!;
    scroller.scrollTop = 720;
    const row = screen.getByText("/tmp/b").closest("tr")!;
    const removeButton = row.querySelector("button")!;

    await act(async () => {
      fireEvent.click(removeButton);
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("deny /tmp/b");
    expect(screen.queryByText("/tmp/b")).toBeNull();
    expect(scroller.scrollTop).toBe(720);

    requestAnimationFrameSpy.mockRestore();
  });

  it("requires an explicit warning acknowledgement before saving risky directories", async () => {
    const api = installApi([[]]);
    api.permission.dirDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return {
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: [],
          effective: [],
        };
      }
      if (rawArgs === "allow /tmp/project/.git") {
        return {
          ok: false as const,
          error: "directory has adjacency warnings; explicit acknowledgement required",
          warnings: ["path contains .git"],
          requiresAcknowledgement: true,
        };
      }
      if (rawArgs === "allow --ack-warnings /tmp/project/.git") {
        return {
          ok: true as const,
          verb: "allow" as const,
          persisted: ["/tmp/project/.git"],
          sessionOnly: false,
          warnings: ["path contains .git"],
        };
      }
      throw new Error(`unexpected dirDispatch: ${rawArgs}`);
    });

    await renderPermissionsTab();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("경로 (예: ~/Documents/project)"), {
        target: { value: "/tmp/project/.git" },
      });
      fireEvent.click(screen.getAllByText("추가").at(-1)!);
    });

    expect(screen.getByTestId("directory-warning-confirmation")).toBeTruthy();
    expect(screen.queryByText("/tmp/project/.git")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("경고 확인 후 추가"));
    });

    expect(api.permission.dirDispatch).toHaveBeenCalledWith("allow --ack-warnings /tmp/project/.git");
    expect(screen.getByText("/tmp/project/.git")).toBeTruthy();
  });

  it("renders fixed review behavior and the prompt panel for auto", async () => {
    const api = installApi([[]]);
    api.permission.getMode.mockResolvedValueOnce({ mode: "auto" });
    await renderPermissionsTab();
    expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeTruthy();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
  });

  // The reviewer config only exists under auto, so other modes show none of its panels or banners.
  function hiddenReviewerCase(mode: "strict" | "allow") {
    return async () => {
      const api = installApi([[]]);
      api.permission.getMode.mockResolvedValueOnce({ mode });
      await renderPermissionsTab();
      expect(screen.queryByTestId("reviewer-framework-panel")).toBeNull();
      expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
    };
  }

  it("hides the reviewer section (and its banners) entirely under strict mode", hiddenReviewerCase("strict"));
  it("hides the reviewer section entirely under allow mode", hiddenReviewerCase("allow"));

  it("does NOT render the auto-mode auto-approve-off banner under non-auto modes", async () => {
    installApi([[]]);
    // Default = mode "default" → reviewer section (and its banner) hidden.
    await renderPermissionsTab();
    expect(screen.queryByTestId("permissions-legacy-auto-mode-banner")).toBeNull();
  });
});

describe("PermissionsTab — explicit-approval policy editability", () => {
  const CHECKBOX_LABEL = t("permissionsTab.approvalDialogCheckboxAriaLabel");

  it("shows the invalid administrative policy cause with edits locked", async () => {
    const api = installApi([[]]);
    const reason = "untrusted policy file at D:\\machine\\Ave\\policy.json (owner S-1-5-21-1001)";
    api.policy.get.mockResolvedValueOnce(policyGetPayload({ requireExplicitApproval: true, managed: true, source: "admin", adminStatus: "invalid", adminReason: reason }));
    await renderPermissionsTab();
    expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
    expect(screen.getByText(t("permissionsTab.invalidAdminPolicy", { reason }))).toBeVisible();
  });

  it("enables the checkbox when no admin policy is deployed", async () => {
    installApi([[]]);
    await renderPermissionsTab();
    expect(screen.getByLabelText(CHECKBOX_LABEL)).not.toBeDisabled();
    expect(screen.queryByTitle("IT 관리자 설정")).toBeNull();
  });

  // The case the `managed` flag alone gets wrong: an admin-dir policy that pins requireExplicitApproval without
  // claiming `managed`. loadPolicy returns managed:false + source:"admin", savePolicy still refuses every write.
  it("locks the checkbox for an admin-dir policy that does not set managed:true", async () => {
    const api = installApi([[]]);
    api.policy.get.mockResolvedValueOnce(policyGetPayload({
      requireExplicitApproval: true,
      managed: false,
      source: "admin",
      adminPath: "/etc/ave/policy.json",
    }));
    await renderPermissionsTab();
    expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
    expect(screen.getByTitle("IT 관리자 설정")).toBeTruthy();
    expect(screen.getByText(/\/etc\/ave\/policy.json/)).toBeTruthy();
  });

  function lockedPolicyCase(policy: Parameters<typeof policyGetPayload>[0]) {
    return async () => {
      const api = installApi([[]]);
      api.policy.get.mockResolvedValueOnce(policyGetPayload(policy));
      await renderPermissionsTab();
      expect(screen.getByLabelText(CHECKBOX_LABEL)).toBeDisabled();
    };
  }

  it("locks the checkbox for a merged admin+user policy with managed:false", lockedPolicyCase({ requireExplicitApproval: false, managed: false, source: "merged", adminPath: "/etc/ave/policy.json" }));
  it("locks the checkbox for a user policy with managed:true", lockedPolicyCase({ requireExplicitApproval: true, managed: true, source: "user" }));
});

describe("PermissionsTab — OS sandbox toggle and capability rendering", () => {
  function settingsApi() {
    return window.aveApi as unknown as {
      getSettings: ReturnType<typeof vi.fn>;
      updateSettings: ReturnType<typeof vi.fn>;
    };
  }

  async function togglePending(scope: "shell" | "worker", state: "pending-on" | "pending-off" = "pending-on") {
    const api = installApi([[]]);
    const base = await api.permission.sandboxCapability();
    const initiallyEnabled = state === "pending-off";
    api.permission.sandboxCapability.mockResolvedValue({
      ...base, workerRestartPending: false,
      shell: { state: initiallyEnabled ? "on" : "off", setting: initiallyEnabled, envForced: false, causes: [] },
    } as never);
    settingsApi().getSettings.mockResolvedValue({ features: { osToolSandbox: initiallyEnabled, pluginWorkerConfinement: initiallyEnabled } });
    settingsApi().updateSettings.mockResolvedValue({ ok: true });
    await renderPermissionsTab();
    api.permission.sandboxCapability.mockResolvedValue({
      ...base, workerRestartPending: scope === "worker",
      shell: { state: scope === "shell" ? state : "off", setting: !initiallyEnabled, envForced: false, causes: [] },
    } as never);
    await act(async () => { fireEvent.click(screen.getByTestId(scope === "shell" ? "os-sandbox-toggle" : "worker-confinement-toggle")); });
    await screen.findByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") });
    return api;
  }

  it("prompts for a shell change and Later preserves the pending restart action", async () => {
    const api = await togglePending("shell");
    const later = screen.getByRole("button", { name: t("permissionsTab.sandboxRestartLater") });
    expect(later).toHaveFocus();
    fireEvent.click(later);
    expect(screen.queryByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toBeNull();
    expect(api.relaunchApp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartNow") }));
    expect(screen.getByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toBeTruthy();
    expect(api.relaunchApp).not.toHaveBeenCalled();
  });

  it("confirms a pending shell disable before invoking relaunch", async () => {
    const api = await togglePending("shell", "pending-off");
    expect(api.relaunchApp).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartNow") })); });
    expect(api.relaunchApp).toHaveBeenCalledExactlyOnceWith();
  });

  it("prompts for pending worker confinement and restarts only on confirmation", async () => {
    const api = await togglePending("worker");
    expect(api.relaunchApp).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartNow") })); });
    expect(api.relaunchApp).toHaveBeenCalledExactlyOnceWith();
    expect(settingsApi().updateSettings).toHaveBeenCalledWith({ features: { pluginWorkerConfinement: true } });
  });

  it("allows a pending worker disable to be deferred", async () => {
    const api = await togglePending("worker", "pending-off");
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartLater") }));
    expect(screen.queryByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toBeNull();
    expect(api.relaunchApp).not.toHaveBeenCalled();
    expect(settingsApi().updateSettings).toHaveBeenCalledWith({ features: { pluginWorkerConfinement: false } });
  });

  it("clears the restart action without prompting when the shell returns to its boot value", async () => {
    const api = await togglePending("shell");
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartLater") }));
    api.permission.sandboxCapability.mockResolvedValue({
      ...await api.permission.sandboxCapability(), workerRestartPending: false,
      shell: { state: "off", setting: false, envForced: false, causes: [] },
    } as never);
    await act(async () => { fireEvent.click(screen.getByTestId("os-sandbox-toggle")); });
    expect(screen.queryByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("permissionsTab.sandboxRestartNow") })).toBeNull();
    expect(api.relaunchApp).not.toHaveBeenCalled();
  });

  it("does not prompt when worker confinement returns to its boot value", async () => {
    const api = await togglePending("worker");
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartLater") }));
    api.permission.sandboxCapability.mockResolvedValue({ ...await api.permission.sandboxCapability(), workerRestartPending: false } as never);
    await act(async () => { fireEvent.click(screen.getByTestId("worker-confinement-toggle")); });
    expect(screen.queryByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("permissionsTab.sandboxRestartNow") })).toBeNull();
    expect(api.relaunchApp).not.toHaveBeenCalled();
  });

  it("shows an in-progress relaunch in the confirmation dialog", async () => {
    const api = await togglePending("shell");
    api.relaunchApp.mockResolvedValue({ ok: false, error: "relaunch-in-progress" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartNow") })); });
    expect(screen.getByRole("alert")).toHaveTextContent(t("permissionsTab.sandboxRestartBusy"));
  });

  it("keeps a refused restart open with the localized reason", async () => {
    const api = await togglePending("shell");
    api.relaunchApp.mockResolvedValue({ ok: false, error: "update-install-in-progress" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.sandboxRestartNow") })); });
    expect(screen.getByRole("dialog", { name: t("permissionsTab.sandboxRestartTitle") })).toHaveTextContent(t("permissionsTab.sandboxRestartUpdateBusy"));
  });

  it("rolls back optimistic enable when settings IPC returns an error", async () => {
    const api = installApi([[]]);
    settingsApi().updateSettings.mockResolvedValueOnce({
      ok: false as const,
      error: "persist-failed",
      message: "저장 실패",
    });

    await renderPermissionsTab();

    const toggle = screen.getByTestId("os-sandbox-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(settingsApi().updateSettings).toHaveBeenCalledWith({
      features: { osToolSandbox: true },
    });
    expect(api.permission.sandboxCapability).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // A known code shows its localized copy; main's message is logged, not shown.
    expect(screen.getByText(t("formatIpcError.writeFailed"))).toBeTruthy();
    expect(screen.queryByText("저장 실패")).toBeNull();
  });

  it("writes only the shell setting from the shell toggle and only the worker setting from the worker toggle", async () => {
    installApi([[]]);
    settingsApi().updateSettings.mockResolvedValue({ ok: true });

    await renderPermissionsTab();

    const shellToggle = screen.getByTestId("os-sandbox-toggle");
    const workerToggle = screen.getByTestId("worker-confinement-toggle");
    expect(screen.getByLabelText(t("permissionsTab.osSandboxCheckboxAriaLabel"))).toBe(shellToggle);
    expect(screen.getByLabelText(t("permissionsTab.workerConfinementCheckboxAriaLabel"))).toBe(workerToggle);
    expect(workerToggle).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      fireEvent.click(workerToggle);
    });
    expect(settingsApi().updateSettings).toHaveBeenLastCalledWith({
      features: { pluginWorkerConfinement: true },
    });
    expect(workerToggle).toHaveAttribute("aria-checked", "true");
    expect(shellToggle).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      fireEvent.click(shellToggle);
    });
    expect(settingsApi().updateSettings).toHaveBeenLastCalledWith({
      features: { osToolSandbox: true },
    });
    expect(settingsApi().updateSettings).toHaveBeenCalledTimes(2);
    expect(workerToggle).toHaveAttribute("aria-checked", "true");
  });

  it("loads the worker toggle from its own setting", async () => {
    installApi([[]]);
    settingsApi().getSettings.mockResolvedValueOnce({
      features: { osToolSandbox: false, pluginWorkerConfinement: true },
    });

    await renderPermissionsTab();

    expect(screen.getByTestId("os-sandbox-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("worker-confinement-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("shows each scope's runtime on its own line, so a worker-only boot does not read as a sandboxed shell", async () => {
    const api = installApi([[]]);
    api.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "darwin" as NodeJS.Platform,
      enabled: false,
      available: true,
      kind: "full" as const,
      reason: "summary",
      potentialReason: "platform can confine",
      runtime: { available: false, kind: "none" as const, reason: "shell sandbox not requested at boot" },
      workerRuntime: { available: true, kind: "full" as const, reason: "ASRT (Seatbelt) active" },
      confines: { filesystem: true, process: true, network: true },
    });

    await renderPermissionsTab();

    expect(screen.getByTestId("os-sandbox-runtime-reason")).toHaveTextContent(t("permissionsTab.osSandboxKindNone"));
    expect(screen.getByTestId("worker-confinement-runtime-reason")).toHaveTextContent(t("permissionsTab.osSandboxKindFull"));
  });

  it("says the environment is deciding worker confinement when its variable is set", async () => {
    installApi([[]], ["features.pluginWorkerConfinement"]);

    await renderPermissionsTab();

    await waitFor(() => {
      expect(screen.getByTestId("worker-confinement-forced")).toHaveTextContent("AVE_PLUGIN_WORKER_CONFINEMENT");
    });
    expect(screen.queryByTestId("os-sandbox-forced")).toBeNull();
  });

  it("renders platform and runtime status without a restart action when unchanged", async () => {
    const api = installApi([[]]);
    api.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "linux" as NodeJS.Platform,
      enabled: true,
      available: true,
      kind: "full" as const,
      reason: "legacy summary",
      potentialReason: "platform can confine filesystem, process, and network",
      runtime: {
        available: true,
        kind: "full" as const,
        reason: "ASRT runtime registered at startup",
      },
      confines: { filesystem: true, process: true, network: true },
    });
    settingsApi().getSettings.mockResolvedValueOnce({ features: { osToolSandbox: true } });

    await renderPermissionsTab();

    expect(screen.getByTestId("os-sandbox-potential-reason")).toHaveTextContent(
      t("permissionsTab.osSandboxKindFull"),
    );
    expect(screen.getByTestId("os-sandbox-runtime-reason")).toHaveTextContent(
      t("permissionsTab.osSandboxKindFull"),
    );
    expect(screen.queryByRole("button", { name: t("permissionsTab.sandboxRestartNow") })).toBeNull();
  });

  it("says the environment is deciding the sandbox when the variable is set", async () => {
    // `AVE_SANDBOX_ENABLED=1` is OR-ed with the setting at boot, so without this line the toggle reads "off"
    // while the sandbox is on, and turning it off again does nothing; a control that lies about the running app.
    installApi([[]], ["features.osToolSandbox"]);

    await renderPermissionsTab();

    await waitFor(() => {
      expect(screen.getByTestId("os-sandbox-forced")).toHaveTextContent("AVE_SANDBOX_ENABLED");
    });
    // The control stays usable: the stored value still decides the next run launched without the variable.
    expect(screen.getByTestId("os-sandbox-toggle")).not.toBeDisabled();
  });

  it("stays silent about the environment when no variable is forcing it", async () => {
    installApi([[]]);

    await renderPermissionsTab();

    expect(screen.queryByTestId("os-sandbox-forced")).toBeNull();
  });

  it("renders the unavailable branch and disables the toggle for unsupported platforms", async () => {
    const api = installApi([[]]);
    api.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "freebsd" as NodeJS.Platform,
      enabled: false,
      available: false,
      kind: "none" as const,
      reason: "OS sandbox is fail-closed on this platform; tools run unconfined",
      potentialReason: "OS sandbox is fail-closed on this platform; tools run unconfined",
      runtime: {
        available: false,
        kind: "none" as const,
        reason: "no OS sandbox configured for the host process",
      },
      confines: { filesystem: false, process: false, network: false },
    });

    await renderPermissionsTab();

    expect(screen.getByTestId("os-sandbox-unavailable")).toHaveTextContent("freebsd");
    expect(screen.getByTestId("os-sandbox-toggle")).toBeDisabled();
    expect(screen.queryByTestId("os-sandbox-potential-reason")).toBeNull();
    expect(screen.queryByTestId("os-sandbox-runtime-reason")).toBeNull();
  });
});

describe("PermissionsTab — handleWindowsInstall error-shape robustness", () => {
  /** When sandboxWindowsInstall returns an error shape (ok: false), the handler must keep the user's opt-in setting enabled and keep the
   * consent panel visible so the install can be retried. The UI surfaces the error separately from the persisted desire to enable ASRT. */
  function installApiWithWindows(overrides: {
    sandboxWindowsInstall?: ReturnType<typeof vi.fn>;
    sandboxWindowsStatus?: ReturnType<typeof vi.fn>;
    togglesOff?: boolean;
  } = {}) {
    const windowsStatus = {
      applicable: true,
      userState: "absent" as const,
      wfpState: "absent" as const,
      ready: false,
      instructions: "Run srt-win install…",
    };
    const ave = {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
        onModeChanged: vi.fn(() => () => undefined),
        listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
        addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
        removeRule: vi.fn(async () => ({ ok: true })),
        recentlyDeniedList: vi.fn(async () => ({ ok: true, entries: [], total: 0 })),
        recentlyDeniedRerun: vi.fn(async () => ({ ok: true })),
        onRecentlyDeniedChanged: vi.fn(() => () => undefined),
        hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
        dirDispatch: vi.fn(async () => ({
          ok: true as const,
          verb: "list" as const,
          defaults: [],
          userAdditions: [],
          effective: [],
        })),
        reviewerDispatch: vi.fn(async () => (reviewerResult("show", "disabled", "deny"))),
        sandboxCapability: vi.fn(async () => ({
          platform: "win32" as NodeJS.Platform,
          enabled: true,
          available: true,
          kind: "partial" as const,
          reason: "ASRT (srt-win) confines filesystem access and network egress against the host; every confined process, plugins included, runs as one shared sandbox account, so plugins are not isolated from each other; process isolation is unavailable on Windows; needs a one-time admin install",
          potentialReason: "ASRT (srt-win) confines filesystem access and network egress against the host; every confined process, plugins included, runs as one shared sandbox account, so plugins are not isolated from each other; process isolation is unavailable on Windows; needs a one-time admin install",
          runtime: {
            available: false,
            kind: "none" as const,
            reason: "no OS sandbox configured for the host process",
          },
          confines: { filesystem: true, process: false, network: true },
        })),
        sandboxWindowsStatus: overrides.sandboxWindowsStatus ?? vi.fn(async () => windowsStatus),
        sandboxWindowsInstall: overrides.sandboxWindowsInstall ?? vi.fn(async () => ({ cancelled: true })),
      },
      policy: {
        get: vi.fn(async () => ({
          requireExplicitApproval: true,
          managed: false,
          source: "defaults",
        })),
        set: vi.fn(async () => ({ ok: true })),
      },
    };
    (globalThis as unknown as { window: typeof window }).window.ave = ave as never;
    // osToolSandbox=true so the component loads into the Windows consent state
    const api = installMockAveApi({ settings: { features: { osToolSandbox: overrides.togglesOff !== true } } });
    return { ave, updateSettings: api.updateSettings! };
  }

  it.each(["absent", "ready"])("keeps raw sandbox diagnostics off the screen for user state %s", async (userState) => {
    const raw = String.raw`EACCES: open C:\Users\example\AppData\Local\ave`;
    const { ave } = installApiWithWindows({ sandboxWindowsStatus: vi.fn(async () => ({
      applicable: true, userState, wfpState: "absent", ready: false, instructions: raw,
    })) });
    ave.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: raw,
      potentialReason: raw, runtime: { available: false, kind: "none", reason: raw },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "degrade", reason: "degrade-windows-not-installed", onSignal: "default-settings", causes: ["windows-setup-incomplete"] },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(document.body.textContent).not.toContain("EACCES");
    expect(document.body.textContent).not.toContain("AppData");
    expect(screen.getByText(t("permissionsTab.osSandboxWindowsReloginPending"))).toBeTruthy();
  });

  it.each([
    { ok: false, error: String.raw`EACCES: open C:\Users\example\AppData` },
    { outcome: "failed", errorCode: String.raw`EACCES: open C:\Users\example\AppData` },
  ])("does not render raw refusal codes from %j", async (result) => {
    installApiWithWindows({ sandboxWindowsInstall: vi.fn(async () => result) });
    await act(async () => { render(<PermissionsTab />); });
    await act(async () => { fireEvent.click(screen.getByTestId("os-sandbox-windows-install")); });
    expect(document.body.textContent).not.toContain("EACCES");
    expect(document.body.textContent).not.toContain("AppData");
  });

  it("shows MXC shells, the Bash note and unconfined extensions when ASRT runs only as the containers' proxy", async () => {
    const { ave } = installApiWithWindows();
    ave.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
      runtime: { available: true, kind: "none", reason: "r" },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "activate", reason: "activate-windows-mxc-proxy-only", onSignal: "default-settings", causes: [] },
      windowsSubstrate: {
        mxc: { state: "available" }, windowsBuild: "10.0.26300.9711", srtWinReady: false,
        shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel", extensionEgressIdentity: "shared",
      },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    const block = screen.getByTestId("os-sandbox-windows-substrate");
    expect(block.dataset.shells).toBe("mxc");
    expect(screen.getByTestId("os-sandbox-windows-substrate-shells").textContent).toBe(t("permissionsTab.osSandboxWindowsShellsMxc"));
    expect(screen.getByTestId("os-sandbox-windows-bash-note")).toBeTruthy();
    expect(screen.getByTestId("os-sandbox-windows-substrate-extensions").textContent).toBe(t("permissionsTab.osSandboxWindowsExtensionsNone"));
    expect(screen.queryByTestId("os-sandbox-windows-mxc-reason")).toBeNull();
    expect(screen.queryByTestId("os-sandbox-windows-shared-identity")).toBeNull();
  });

  it.each([
    ["srt-win-not-found", "permissionsTab.osSandboxWindowsInstallFailedHelperMissing"],
    ["srt-win-integrity-mismatch", "permissionsTab.osSandboxWindowsHelperIntegrityError"],
  ] as const)("shows %s and restores setup actions on a fresh status", async (helperError, messageKey) => {
    const sandboxWindowsStatus = vi.fn().mockResolvedValueOnce({
      applicable: true, userState: null, wfpState: null, ready: false,
      helperError, instructions: "",
    }).mockResolvedValueOnce({
      applicable: true, userState: "absent", wfpState: "absent", ready: false, instructions: "",
    });
    const { ave } = installApiWithWindows({ sandboxWindowsStatus });
    ave.permission.sandboxCapability.mockResolvedValue({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
      runtime: { available: true, kind: "none", reason: "r" },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "activate", reason: "activate-windows-mxc-proxy-only", onSignal: "default-settings", causes: [] },
      windowsSubstrate: {
        mxc: { state: "available" }, windowsBuild: "10.0.26300", srtWinReady: false,
        shells: "mxc", extensions: "none", shellEgressIdentity: "kernel-channel", extensionEgressIdentity: "shared",
      },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.getByTestId("os-sandbox-windows-helper-unavailable"))
      .toHaveAttribute("data-error-code", helperError);
    expect(screen.getByTestId("os-sandbox-windows-helper-unavailable"))
      .toHaveTextContent(t(messageKey));
    expect(screen.getByTestId("os-sandbox-windows-substrate-shells"))
      .toHaveTextContent(t("permissionsTab.osSandboxWindowsShellsMxc"));
    expect(screen.getByTestId("os-sandbox-windows-substrate-extensions"))
      .toHaveTextContent(t("permissionsTab.osSandboxWindowsExtensionsNone"));
    expect(screen.getByTestId("os-sandbox-toggle")).not.toBeDisabled();
    expect(document.querySelector('[data-settings-section="permissions-network"]')).toBeInTheDocument();
    expect(screen.queryByText(t("permissionsTab.errorLoadFailed"))).toBeNull();
    expect(screen.queryByTestId("os-sandbox-windows-install")).toBeNull();
    expect(ave.permission.sandboxWindowsInstall).not.toHaveBeenCalled();

    cleanup();
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.queryByTestId("os-sandbox-windows-helper-unavailable")).toBeNull();
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeInTheDocument();
    expect(screen.getByTestId("os-sandbox-windows-install")).toBeInTheDocument();
  });

  it.each([
    ["en", "icacls-failed"], ["ko", "icacls-failed"],
    ["en", "read-back-failed"], ["ko", "read-back-failed"],
    ["en", "not-protected"], ["ko", "not-protected"],
    ["en", "extra-principals"], ["ko", "extra-principals"],
    ["en", "reparse-point"], ["ko", "reparse-point"],
  ] as const)("names the private directory and reason in %s for %s without elevated setup", async (locale, category) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const path = String.raw`D:\private-state\secrets`;
      const { ave } = installApiWithWindows({
        sandboxWindowsStatus: vi.fn().mockResolvedValue({
          applicable: true, userState: null, wfpState: null, ready: false,
          homePrivacyError: { path, category, extraPrincipals: [{ sid: "S-1-1-0", account: "Everyone" }, { sid: "S-1-5-21-100-200-300-9999" }] }, instructions: "",
        }),
      });
      await act(async () => { render(<PermissionsTab />); });
      const notice = screen.getByTestId("os-sandbox-windows-home-privacy-error");
      expect(notice).toHaveAttribute("role", "alert");
      expect(notice).toHaveTextContent(path);
      expect(notice).toHaveTextContent("AVE_HOME");
      expect(screen.getByRole("button", { name: t("permissionsTab.homePrivacyApproveForSession") })).toBeInTheDocument();
      if (category === "extra-principals") {
        expect(notice).toHaveTextContent("S-1-1-0 (Everyone)");
        expect(notice).toHaveTextContent("S-1-5-21-100-200-300-9999");
        expect(notice).toHaveTextContent(t("permissionsTab.homePrivacyExtraPrincipals", { principals: "S-1-1-0 (Everyone), S-1-5-21-100-200-300-9999" }));
      } else {
        expect(notice).toHaveTextContent({
          "icacls-failed": t("permissionsTab.homePrivacyIcaclsFailed"),
          "read-back-failed": t("permissionsTab.homePrivacyReadBackFailed"),
          "not-protected": t("permissionsTab.homePrivacyNotProtected"),
          "reparse-point": t("permissionsTab.homePrivacyReparsePoint"),
        }[category]);
      }
      expect(screen.queryByTestId("os-sandbox-windows-install")).toBeNull();
      expect(ave.permission.sandboxWindowsInstall).not.toHaveBeenCalled();
    } finally {
      setLocale(previousLocale);
    }
  });

  it("shows readable and unverified profile warnings in English while ready", async () => {
    const previousLocale = getLocale();
    setLocale("en");
    try {
      const path = String.raw`D:\Users\tester\.ssh`;
      const unverified = String.raw`D:\Users\tester\.aws`;
      installApiWithWindows({ sandboxWindowsStatus: vi.fn().mockResolvedValue({
        applicable: true, userState: "ready", wfpState: "installed", ready: true, instructions: "",
        profileReadDenyWarnings: [{ path, principals: ["Everyone", "srt-sandbox", "sandbox-runtime-users"] }, { path: unverified }],
      }) });
      await act(async () => { render(<PermissionsTab />); });
      const notices = screen.getAllByTestId("os-sandbox-windows-profile-read-deny-warning");
      expect(notices).toHaveLength(2);
      expect(notices[0]).toHaveAttribute("role", "alert");
      expect(notices[0]).toHaveTextContent(`${path} is readable by Everyone, srt-sandbox, sandbox-runtime-users and cannot be protected by the sandbox`);
      expect(notices[1]).toHaveTextContent(`${unverified} has unverified read protection and cannot be protected by the sandbox`);
    } finally {
      setLocale(previousLocale);
    }
  });

  it("shows Korean profile warnings from capability with both toggles off", async () => {
    const previousLocale = getLocale();
    setLocale("ko");
    try {
      const path = String.raw`D:\Users\tester\.ssh`;
      const unverified = String.raw`D:\Users\tester\.aws`;
      const { ave } = installApiWithWindows({ togglesOff: true });
      const capability = await ave.permission.sandboxCapability();
      ave.permission.sandboxCapability.mockResolvedValue({ ...capability,
        profileReadDenyWarnings: [{ path, principals: ["Users", "Authenticated Users", "INTERACTIVE"] }, { path: unverified }],
      } as never);
      await act(async () => { render(<PermissionsTab />); });
      const notices = screen.getAllByTestId("os-sandbox-windows-profile-read-deny-warning");
      expect(notices).toHaveLength(2);
      expect(notices[0]).toHaveTextContent(`${path} 경로는 Users, Authenticated Users, INTERACTIVE 주체가 읽을 수 있으며 샌드박스로 보호할 수 없습니다`);
      expect(notices[1]).toHaveTextContent(`${unverified} 경로의 읽기 보호가 검증되지 않았으며 샌드박스로 보호할 수 없습니다`);
      expect(ave.permission.sandboxWindowsInstall).not.toHaveBeenCalled();
    } finally {
      setLocale(previousLocale);
    }
  });

  it("requests a session approval once and reads the main-owned OFF status again after a reload", async () => {
    const status = { applicable: true, userState: null, wfpState: null, ready: false, instructions: "",
      homePrivacyError: { path: "D:/private-state/secrets", category: "read-back-failed", approvedForSession: false } };
    const readStatus = vi.fn(async () => structuredClone(status));
    const { ave } = installApiWithWindows({ sandboxWindowsStatus: readStatus });
    const approve = vi.fn(async () => { status.homePrivacyError.approvedForSession = true; return { ok: true }; });
    Object.assign(ave.permission, { approveExtensionsWithoutIsolation: approve });
    await act(async () => { render(<PermissionsTab />); });
    expect(approve).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.homePrivacyApproveForSession") })); });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t("permissionsTab.homePrivacyApprovedForSession"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("permissionsTab.homePrivacyApproveForSession") })).toBeNull();
    cleanup();
    await act(async () => { render(<PermissionsTab />); });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t("permissionsTab.homePrivacyApprovedForSession"))).toBeInTheDocument();
  });

  it.each([
    ["srt-win-not-found", "windows-sandbox-missing"],
    ["srt-win-integrity-mismatch", "windows-sandbox-integrity-failed"],
  ] as const)("shows %s from a boot opt-in while the toggles are off", async (helperError, cause) => {
    const { ave } = installApiWithWindows({
      togglesOff: true,
      sandboxWindowsStatus: vi.fn(async () => ({
        applicable: true, userState: null, wfpState: null, ready: false, helperError, instructions: "",
      })),
    });
    const capability = {
      platform: "win32", enabled: false, available: false, kind: "none", reason: "r", potentialReason: "r",
      runtime: { available: false, kind: "none", reason: "r" },
      confines: { filesystem: false, process: false, network: false },
      boot: { action: "degrade", reason: "degrade-windows-not-installed", onSignal: "explicit-env", causes: [cause] },
    };
    ave.permission.sandboxCapability.mockResolvedValue(capability as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.getByTestId("os-sandbox-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("os-sandbox-boot-degraded")).toBeInTheDocument();
    expect(screen.getByTestId("os-sandbox-windows-helper-unavailable"))
      .toHaveAttribute("data-error-code", helperError);

    // Without a helper cause at boot, toggles off keep the notice hidden.
    cleanup();
    ave.permission.sandboxCapability.mockResolvedValue({ ...capability, boot: null } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.queryByTestId("os-sandbox-windows-helper-unavailable")).toBeNull();
  });

  it("says the container check is still running instead of claiming MXC or a failure", async () => {
    const { ave } = installApiWithWindows();
    ave.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
      runtime: { available: true, kind: "none", reason: "r" },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "activate", reason: "activate-windows-mxc-proxy-only", onSignal: "default-settings", causes: [] },
      windowsSubstrate: {
        mxc: { state: "checking" }, windowsBuild: "10.0.26300", srtWinReady: false,
        shells: "approved-host", extensions: "none", shellEgressIdentity: "shared", extensionEgressIdentity: "shared",
      },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.getByTestId("os-sandbox-windows-substrate").dataset.mxc).toBe("checking");
    expect(screen.getByTestId("os-sandbox-windows-substrate-shells").textContent).toBe(t("permissionsTab.osSandboxWindowsShellsChecking"));
    expect(screen.queryByTestId("os-sandbox-windows-mxc-reason")).toBeNull();
    expect(screen.queryByTestId("os-sandbox-windows-bash-note")).toBeNull();
  });

  it("says MXC is available but unused when the sandbox did not start", async () => {
    const { ave } = installApiWithWindows();
    ave.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
      runtime: { available: false, kind: "none", reason: "r" },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "degrade", reason: "degrade-windows-init-failed", onSignal: "default-settings", causes: ["init-failed"] },
      windowsSubstrate: {
        mxc: { state: "available" }, windowsBuild: "10.0.26300.9711", srtWinReady: true,
        shells: "none", extensions: "none", shellEgressIdentity: "shared", extensionEgressIdentity: "shared",
      },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.getByTestId("os-sandbox-windows-mxc-unused").textContent)
      .toBe(t("permissionsTab.osSandboxWindowsMxcUnused", { build: "10.0.26300.9711" }));
    expect(screen.queryByTestId("os-sandbox-windows-mxc-reason")).toBeNull();
  });

  it("says why MXC is unavailable and that extensions share one proxy identity", async () => {
    const { ave } = installApiWithWindows();
    ave.permission.sandboxCapability.mockResolvedValueOnce({
      platform: "win32", enabled: true, available: true, kind: "partial", reason: "r", potentialReason: "r",
      runtime: { available: true, kind: "partial", reason: "r" },
      confines: { filesystem: true, process: false, network: true },
      boot: { action: "activate", reason: "deps-present", onSignal: "default-settings", causes: [] },
      windowsSubstrate: {
        mxc: { state: "unavailable", reason: "tier-unsupported" }, windowsBuild: "10.0.22631.4317", srtWinReady: true,
        shells: "approved-host", extensions: "srt-win", shellEgressIdentity: "shared", extensionEgressIdentity: "shared",
      },
    } as never);
    await act(async () => { render(<PermissionsTab />); });
    expect(screen.getByTestId("os-sandbox-windows-substrate-shells").textContent).toBe(t("permissionsTab.osSandboxWindowsShellsApprovedHost"));
    const reason = screen.getByTestId("os-sandbox-windows-mxc-reason");
    expect(reason.dataset.reason).toBe("tier-unsupported");
    expect(reason.textContent).toBe(t("permissionsTab.osSandboxWindowsMxcUnavailable", {
      reason: t("permissionsTab.osSandboxWindowsMxcReasonTierUnsupported"),
      build: "10.0.22631.4317",
    }));
    expect(screen.getByTestId("os-sandbox-windows-shared-identity").textContent).toBe(t("permissionsTab.osSandboxWindowsSharedIdentity"));
    expect(screen.queryByTestId("os-sandbox-windows-bash-note")).toBeNull();
  });

  it("does not claim a timeout or an unverified install proves isolation or an unchanged machine", async () => {
    for (const outcome of ["timed-out", "installed-unverified"]) {
      const { outcome: view } = await clickInstall(async () => ({ outcome, ready: false }));
      expect(view.textContent).not.toContain("아무것도 바뀌지 않았습니다");
      expect(view.textContent).not.toContain("꺼진 상태로 유지됩니다");
      cleanup();
    }
  });

  it("keeps opt-in enabled and shows a localized error, not main's raw detail, on an ok:false shape", async () => {
    const { updateSettings } = installApiWithWindows({
      sandboxWindowsInstall: vi.fn(async () => ({
        ok: false as const,
        error: "install-failed",
        message: String.raw`srt-win returned non-zero at C:\Users\example\AppData`,
      })),
    });

    await renderPermissionsTab();

    // The consent panel must be visible (sandboxEnabled=true, applicable, not ready).
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });

    // osToolSandbox must not be reverted to false; the user opted in and the consent panel remains the place to retry/follow instructions.
    expect(updateSettings).not.toHaveBeenCalledWith({ features: { osToolSandbox: false } });

    // The refusal is visible and localized; main's free text (srt-win output, local paths with the user name) is not on screen.
    const outcome = screen.getByTestId("os-sandbox-windows-install-outcome");
    expect(outcome).toHaveAttribute("data-outcome", "refused");
    expect(outcome).toHaveTextContent("Windows 샌드박스 설정 오류:");
    expect(document.body.textContent).not.toContain("srt-win returned non-zero");
    expect(document.body.textContent).not.toContain("AppData");

    // The consent panel must remain visible (toggle stays enabled).
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeTruthy();
  });

  it("keeps opt-in enabled when UAC is cancelled so the user can retry", async () => {
    const { updateSettings } = installApiWithWindows({
      sandboxWindowsInstall: vi.fn(async () => ({ cancelled: true })),
    });

    await renderPermissionsTab();

    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });

    expect(updateSettings).not.toHaveBeenCalledWith({ features: { osToolSandbox: false } });
    expect(screen.getByTestId("os-sandbox-windows-install-outcome")).toHaveAttribute("data-outcome", "cancelled");
    expect(screen.getByTestId("os-sandbox-windows-consent")).toBeTruthy();
  });

  // the click must always end in a visible state of its own. The status mock returns the same not-ready
  // snapshot before and after, which is exactly when the old handler left the panel looking untouched.
  async function clickInstall(result: () => Promise<unknown>) {
    const api = installApiWithWindows({ sandboxWindowsInstall: vi.fn(result) });
    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByText(t("permissionsTab.osSandboxWindowsInstallButton")));
    });
    return { outcome: screen.getByTestId("os-sandbox-windows-install-outcome"), api };
  }

  // What ASRT messages look like: srt-win output plus a path with the user name.
  const RAW_DETAIL = String.raw`srt-win install exited 12: C:\Users\example\AppData\Local\ave`;

  function expectNoRawDetail() {
    expect(document.body.textContent).not.toContain("AppData");
    expect(document.body.textContent).not.toContain("srt-win install exited");
  }

  it("shows that the install ran but could not be verified, for the shape an older main returns (#1608)", async () => {
    const { outcome } = await clickInstall(async () => ({ userState: "ready", wfpState: "cannot-read", ready: false }));
    expect(outcome).toHaveAttribute("data-outcome", "installed-unverified");
    expect(outcome).toHaveTextContent("설정은 실행되었지만 Ave가 샌드박스의 준비 상태를 확인하지 못했습니다(샌드박스 사용자: 설정됨, 네트워크 필터: 관리자 권한 없이는 확인 불가)");
    expect(outcome.textContent).not.toMatch(/cannot-read|: ready/);
  });

  it.each([
    [{ outcome: "installed-unverified", userState: "incomplete", wfpState: "absent", ready: false }, "installed-unverified", "샌드박스 사용자: 일부만 설정됨, 네트워크 필터: 설치 안 됨"],
    [{ outcome: "installed-unverified", userState: "absent", wfpState: "installed", ready: false }, "installed-unverified", "샌드박스 사용자: 설정 안 됨, 네트워크 필터: 설치됨"],
    [{ outcome: "installed-unverified", userState: "mystery", ready: false }, "installed-unverified", "샌드박스 사용자: 알 수 없음, 네트워크 필터: 알 수 없음"],
    [{ outcome: "ready", userState: "ready", wfpState: "installed", ready: true }, "ready", "Windows OS 격리 설정이 끝났고 확인되었습니다"],
    [{ outcome: "already-ready", userState: "ready", wfpState: "cannot-read", ready: true }, "already-ready", "이미 설정되어 있고 확인되었으므로 관리자 확인이 필요하지 않았습니다"],
    [{ outcome: "cancelled", cancelled: true }, "cancelled", "관리자 권한이 허용되지 않아"],
    [{ outcome: "timed-out" }, "timed-out", "설치 프로그램이 2분 안에 끝나지 않아"],
  ])("renders the %j outcome as a visible state", async (result, expected, text) => {
    const { outcome } = await clickInstall(async () => result);
    expect(outcome).toHaveAttribute("data-outcome", expected);
    expect(outcome).toHaveTextContent(text);
    expect(outcome.textContent).not.toMatch(/permissionsTab\./);
  });

  it.each([
    ["install_wfp_failed", "Base Filtering Engine"],
    ["install_user_failed", "로컬 샌드박스 사용자 계정을 만들거나 설정하지 못했"],
    ["install_config_conflict", "설정이 다른 Windows 샌드박스 네트워크 필터가 이미 있습니다"],
    ["install_ambient_failed", "시스템 폴더의 쓰기 차단이 적용되지 않아"],
    ["srt_win_not_found", "Windows 샌드박스 도우미가 없어"],
    ["unexpected", "예상하지 못한 오류로 중단되었고"],
    ["install_failed", "Windows 샌드박스 설정에 실패했고(install_failed)"],
  ])("shows localized copy for failure code %s, never main's message", async (errorCode, text) => {
    const { outcome } = await clickInstall(async () => ({ outcome: "failed", errorCode, message: RAW_DETAIL }));
    expect(outcome).toHaveAttribute("data-outcome", "failed");
    expect(outcome).toHaveAttribute("data-error-code", errorCode);
    expect(outcome).toHaveTextContent(text);
    expect(outcome.textContent).not.toMatch(/permissionsTab\.|force/);
    expectNoRawDetail();
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["an unknown outcome", { outcome: "rebooting", detail: RAW_DETAIL }],
    ["a string", RAW_DETAIL],
  ])("renders %s as an unexpected result, never as nothing", async (_label, result) => {
    const { outcome } = await clickInstall(async () => result);
    expect(outcome).toHaveAttribute("data-outcome", "unexpected");
    expect(outcome).toHaveTextContent("Windows 샌드박스 설정이 Ave가 알 수 없는 결과를 반환했습니다");
    expectNoRawDetail();
  });

  it("renders a rejected IPC call and a localized refusal as errors, without raw text", async () => {
    const { outcome: rejected } = await clickInstall(async () => {
      throw new Error(RAW_DETAIL);
    });
    expect(rejected).toHaveAttribute("data-outcome", "refused");
    expect(rejected).toHaveTextContent("Ave가 Windows 샌드박스 설정 결과를 받지 못했습니다");
    expectNoRawDetail();
    cleanup();

    const { outcome: refused } = await clickInstall(async () => ({ ok: false, error: "user-keyboard-required", message: "permission change requires active user gesture (keyboard intent)" }));
    expect(refused).toHaveAttribute("data-outcome", "refused");
    expect(refused.textContent).not.toContain("keyboard intent");
    expect(refused).toHaveTextContent("재설정은 이 창에서 클릭했을 때만 시작되는데, Ave가 클릭을 확인하지 못했습니다");
  });

  it.each(["en", "ko"] as const)("keeps unconfirmed setup results honest in %s", async (locale) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const results = [
        async () => { throw new Error(RAW_DETAIL); },
        async () => ({ outcome: "unrecognized" }),
        async () => ({ outcome: "cancelled", cancelled: true }),
        ...["install_wfp_failed", "install_user_failed", "install_config_conflict"].map(
          (errorCode) => async () => ({ outcome: "failed", errorCode }),
        ),
      ];
      for (const result of results) {
        const { outcome } = await clickInstall(result);
        expect(outcome.textContent).not.toMatch(/nothing changed|stays off|nothing is confined|아무것도 바뀌지|꺼진 상태|아무것도 격리되지/);
        expect(outcome.textContent).toMatch(/unconfirmed|sandbox status|준비 상태|샌드박스 상태|확인되지|확인하지 못/);
        cleanup();
      }
    } finally {
      setLocale(previousLocale);
    }
  });

  it.each([
    { outcome: "failed", errorCode: "c:private.cache" },
    { ok: false, error: "c:private.cache" },
  ])("does not render a drive-relative path as a diagnostic code: %j", async (result) => {
    const { outcome } = await clickInstall(async () => result);
    expect(outcome.textContent).not.toContain("c:private.cache");
    expect(outcome.getAttribute("data-error-code")).not.toBe("c:private.cache");
  });

  it("shows a localized banner, not the raw error, when the status re-read after install fails", async () => {
    const { ave } = installApiWithWindows({ sandboxWindowsInstall: vi.fn(async () => ({ outcome: "timed-out" })) });
    await renderPermissionsTab();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (ave.permission.sandboxWindowsStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(RAW_DETAIL));
    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });
    expect(screen.getByTestId("os-sandbox-windows-install-outcome")).toHaveAttribute("data-outcome", "timed-out");
    expect(screen.getByText(/설정 후 Ave가 Windows 샌드박스 상태를 다시 읽지 못했습니다/)).toBeTruthy();
    expectNoRawDetail();
    // The detail goes to the renderer log instead of the screen.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sandboxWindowsStatus re-read failed"), RAW_DETAIL);
    warn.mockRestore();
  });

  it("logs a rejected or refused install with its code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await clickInstall(async () => {
      throw new Error(RAW_DETAIL);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sandboxWindowsInstall rejected"), RAW_DETAIL);
    cleanup();
    warn.mockClear();
    await clickInstall(async () => ({ ok: false, error: "user-keyboard-required", message: "x" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sandboxWindowsInstall refused"), "user-keyboard-required");
    warn.mockRestore();
  });

  it.each(["en", "ko"] as const)("scopes the timeout result to the installer deadline in %s", async (locale) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const { outcome } = await clickInstall(async () => ({ outcome: "timed-out" }));
      expect(outcome).toHaveTextContent(locale === "en"
        ? "The installer did not finish within 2 minutes"
        : "설치 프로그램이 2분 안에 끝나지 않아");
    } finally {
      setLocale(previousLocale);
    }
  });

  it.each(["en", "ko"] as const)("explains a permission repair still pending beyond the installer deadline in %s", async (locale) => {
    const previousLocale = getLocale();
    setLocale(locale);
    const { grantAsrtWindowsBackendAcl, installAsrtWindowsSandbox } = await import("../../../../permissions/asrt-windows-support.js");
    let finishRepair: ((error: Error | null) => void) | undefined;
    const exec = vi.fn((
      file: string,
      _args: readonly string[],
      _options: { readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => {
      if (file.endsWith("icacls.exe")) callback(Object.assign(new Error("Access denied"), { code: 5 }));
      else finishRepair = callback;
    });
    const install = vi.fn(() => installAsrtWindowsSandbox({
      readStatus: async () => ({ applicable: true, userState: "incomplete", wfpState: "absent", ready: false, instructions: "" }),
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => ({
          user: { provisioned: true, sid: "S-1-5-21-1", groupExists: true, inBuiltinUsers: true, inSandboxGroup: true, hiddenFromLogon: true, credPresent: true },
          wfp: { state: "installed" },
        }),
        verifyWindowsWfpEgress: vi.fn(),
      }),
      grantBackendAcl: () => grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => true,
        resolvePackageRoot: () => String.raw`C:\fixture\runtime`,
        systemRoot: String.raw`C:\Windows`,
      }),
    }));
    installApiWithWindows({ sandboxWindowsInstall: install });
    try {
      await act(async () => { render(<PermissionsTab />); });
      await act(async () => { fireEvent.click(screen.getByTestId("os-sandbox-windows-install")); });
      await waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
      expect(exec.mock.calls[1]?.[0]).toMatch(/powershell\.exe$/);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
      const pending = screen.getByTestId("os-sandbox-windows-install-pending");
      expect(pending).toHaveAttribute("data-phase", "installing");
      expect(screen.getByTestId("os-sandbox-windows-install")).toBeDisabled();
      expect(pending).toHaveTextContent(locale === "en"
        ? "The installer and its administrator prompt share a 2-minute limit"
        : "설치 프로그램 실행과 해당 관리자 확인에는 합계 2분의 제한이 적용됩니다");
      expect(pending).toHaveTextContent(locale === "en"
        ? "Later status checks and permission repair can take longer and may show another administrator prompt"
        : "이후 상태 확인과 권한 복구는 더 오래 걸릴 수 있고 관리자 확인이 다시 나타날 수 있습니다");
      expect(screen.getByTestId("os-sandbox-windows-consent")).toHaveTextContent(locale === "en"
        ? "Permission repair may ask for administrator approval again"
        : "권한 복구 중 관리자 확인이 다시 나타날 수 있습니다");
    } finally {
      vi.useRealTimers();
      await act(async () => { finishRepair?.(null); });
      setLocale(previousLocale);
    }
  });

  it("invokes the install straight from the click, with one hint for the install and its own copy for the re-check", async () => {
    let finishInstall: ((value: unknown) => void) | undefined;
    let finishReread: ((value: unknown) => void) | undefined;
    const install = vi.fn(() => new Promise((resolve) => { finishInstall = resolve; }));
    const { ave } = installApiWithWindows({ sandboxWindowsInstall: install });
    await renderPermissionsTab();
    const status = ave.permission.sandboxWindowsStatus as ReturnType<typeof vi.fn>;
    const statusCallsAtMount = status.mock.calls.length;
    status.mockImplementationOnce(() => new Promise((resolve) => { finishReread = resolve; }));

    await act(async () => {
      fireEvent.click(screen.getByText("재설정"));
    });
    // No status read stands between the click and the install.
    expect(install).toHaveBeenCalledTimes(1);
    expect(status.mock.calls.length).toBe(statusCallsAtMount);
    let pending = screen.getByTestId("os-sandbox-windows-install-pending");
    expect(pending).toHaveAttribute("data-phase", "installing");
    expect(pending).toHaveTextContent("최대 약 45초");
    expect(pending).toHaveTextContent("Windows가 관리자 권한을 요청하니 허용하세요");
    expect(pending).toHaveTextContent("설치 프로그램 실행과 해당 관리자 확인에는 합계 2분의 제한이 적용됩니다");

    await act(async () => {
      finishInstall?.({ outcome: "ready", userState: "ready", wfpState: "installed", ready: true });
    });
    pending = screen.getByTestId("os-sandbox-windows-install-pending");
    expect(pending).toHaveAttribute("data-phase", "refreshing");
    expect(pending).toHaveTextContent("결과를 확인하고 있습니다");
    expect(pending.textContent).not.toContain("관리자 권한");
    expect(screen.getByTestId("os-sandbox-windows-install-outcome")).toHaveAttribute("data-outcome", "ready");

    await act(async () => {
      finishReread?.({ applicable: true, userState: "ready", wfpState: "installed", ready: true, instructions: "" });
    });
    expect(screen.queryByTestId("os-sandbox-windows-install-pending")).toBeNull();
  });

  describe("through the real preload surface (issue #1608 gesture expiry)", () => {
    // Electron 44 measured: navigator.userActivation.isActive is true ~4.8 s after a click and false by ~5.3 s. The fake keeps that window.
    const ACTIVATION_WINDOW_MS = 5_000;
    // Slower than the window: a real status read is up to ~45 s.
    const STATUS_READ_MS = 6_000;
    let clickedAt: number | null = null;
    let originalActivation: PropertyDescriptor | undefined;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      clickedAt = null;
      originalActivation = Object.getOwnPropertyDescriptor(navigator, "userActivation");
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        get: () => ({ isActive: clickedAt !== null && Date.now() - clickedAt < ACTIVATION_WINDOW_MS }),
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      if (originalActivation) Object.defineProperty(navigator, "userActivation", originalActivation);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
      ipcInvoke.mockReset();
    });

    it("keeps the click's gesture valid for the install when a status read takes longer than the activation window", async () => {
      const notReady = { applicable: true, userState: "ready", wfpState: "cannot-read", ready: false, instructions: "" };
      const installed: unknown[] = [];
      const originalPlatform = process.platform;
      const statusRead = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, STATUS_READ_MS));
          return { user: {}, wfp: { state: "absent" } };
      });
      const readyUser = { provisioned: true, sid: "S-1-5-21-1", groupExists: true, inBuiltinUsers: true, inSandboxGroup: true, hiddenFromLogon: true, credPresent: true };
      vi.doMock("@anthropic-ai/sandbox-runtime", () => ({
        WindowsSandboxError: class extends Error {},
        resolveSrtWin: () => ({ exe: "srt-win.exe", prependArgs: [] }),
        checkWindowsSandboxStatusAsync: statusRead,
        windowsInstallInstructions: () => "",
        DEFAULT_WINDOWS_PROXY_PORT_RANGE: [60080, 60089],
        installWindowsSandboxAsync: async (options: unknown) => {
          installed.push(options);
          return { user: readyUser, wfp: { state: "installed" } };
        },
        verifyWindowsWfpEgress: vi.fn(),
      }));
      vi.doMock("../../../../permissions/asrt-windows-support.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../../../../permissions/asrt-windows-support.js")>();
        return { ...actual, installAsrtWindowsSandbox: () => actual.installAsrtWindowsSandbox({ grantBackendAcl: async () => undefined }) };
      });
      setProcessPlatform("win32");
      try {
        const { registerPermissionsHandlers } = await import("../../../../ipc/domains/permissions.js");
        mainHandlers.clear();
        registerPermissionsHandlers({
          conversationLoop: { permissionManager: { getMode: () => "default" } },
          approvalGate: {}, auditLogger: { log: vi.fn() }, toolRegistry: { setDenyRules: vi.fn() },
          settingsService: { get: () => ({ osToolSandbox: false }) }, getAppWindows: () => [],
        } as never);
        ipcInvoke.mockImplementation((channel: string, payload?: unknown) => mainHandlers.get(channel)!(hostFrameEvent(), payload));
        const preload = buildInternalApiSurface().permission;
        const { ave } = installApiWithWindows({
          sandboxWindowsStatus: vi.fn(async () => notReady),
          sandboxWindowsInstall: vi.fn(),
        });
        await act(async () => {
          render(<PermissionsTab />);
        });
        // From here on the panel talks to main only through the real preload.
        ave.permission.sandboxWindowsStatus = vi.fn(() => preload.sandboxWindowsStatus());
        ave.permission.sandboxWindowsInstall = vi.fn(() => preload.sandboxWindowsInstall());

        clickedAt = Date.now();
        await act(async () => {
          fireEvent.click(screen.getByText("재설정"));
        });
        for (let i = 0; i < 4; i += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(STATUS_READ_MS);
          });
        }

        const outcome = screen.getByTestId("os-sandbox-windows-install-outcome");
        expect(outcome).not.toHaveAttribute("data-outcome", "refused");
        expect(outcome).toHaveAttribute("data-outcome", "ready");
        expect(installed).toHaveLength(1);
        expect(ipcInvoke).toHaveBeenCalledWith(PERMISSIONS.sandboxWindowsInstall, {
          intent: { inputOrigin: "user-keyboard", userActivation: true },
        });
        expect(navigator.userActivation.isActive).toBe(false);
        // An expired second click is refused before main starts a status read.
        const readsBeforeRefusal = statusRead.mock.calls.length;
        let refusal: unknown;
        void preload.sandboxWindowsInstall().then((result) => { refusal = result; });
        await vi.advanceTimersByTimeAsync(0);
        expect(refusal).toMatchObject({ ok: false, error: "user-keyboard-required" });
        expect(statusRead).toHaveBeenCalledTimes(readsBeforeRefusal);
      } finally {
        setProcessPlatform(originalPlatform);
        vi.doUnmock("@anthropic-ai/sandbox-runtime");
        vi.doUnmock("../../../../permissions/asrt-windows-support.js");
        mainHandlers.clear();
      }
    });
  });
});

describe("PermissionsTab — failures never put raw text on screen", () => {
  // What main's free-text messages and thrown errors can carry: English internals and local paths with the user's account name.
  const RAW = String.raw`EACCES: open C:\Users\example\AppData\Local\ave\settings.json`;

  async function renderTab() {
    const api = installApi([[]]);
    await renderPermissionsTab();
    return api;
  }

  function expectNoRaw() {
    expect(document.body.textContent).not.toContain("EACCES");
    expect(document.body.textContent).not.toContain("AppData");
  }

  it("keeps raw directory warnings in the log before and after acknowledgement", async () => {
    const api = await renderTab();
    api.permission.dirDispatch.mockResolvedValueOnce({
      ok: false, error: "directory warnings", warnings: [RAW], requiresAcknowledgement: true,
    } as never);
    const input = screen.getByPlaceholderText(t("permissionsTab.directoryInputPlaceholder"));
    fireEvent.change(input, { target: { value: "/tmp/project/.git" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(screen.getByTestId("directory-warning-confirmation")).toBeTruthy();
    expectNoRaw();
    api.permission.dirDispatch.mockResolvedValueOnce({
      ok: true, verb: "allow", persisted: ["/tmp/project/.git"], sessionOnly: false, warnings: [RAW],
    } as never);
    await act(async () => { fireEvent.click(screen.getByText(t("permissionsTab.directoryWarningConfirmButton"))); });
    expectNoRaw();
    expect(screen.getByText(t("permissionsTab.directoryWarningBody"))).toBeTruthy();
  });

  async function addRule() {
    fireEvent.change(screen.getByTestId("permissions-rule-pattern-input"), { target: { value: "bash:ls" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permissions-rule-add"));
    });
  }

  type FailureCase = (api: ReturnType<typeof installApi>) => Promise<string>;
  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
  const cases: ReadonlyArray<readonly [string, FailureCase]> = [
    ["a mode change refused with a message", async (api) => {
      mock(api.permission.setMode).mockResolvedValueOnce({ ok: false, error: "mode-locked", message: RAW });
      await act(async () => {
        fireEvent.click(screen.getByTestId(execModeTestId("auto")));
      });
      return "실행 모드 변경에 실패했습니다. (mode-locked)";
    }],
    ["a mode change that throws", async (api) => {
      mock(api.permission.setMode).mockRejectedValueOnce(new Error(RAW));
      await act(async () => {
        fireEvent.click(screen.getByTestId(execModeTestId("auto")));
      });
      return t("formatIpcError.unknownError");
    }],
    ["a rule add refused with a message", async (api) => {
      mock(api.permission.addRule).mockResolvedValueOnce({ ok: false, error: "rule-conflict", message: RAW });
      await addRule();
      return "rule-conflict";
    }],
    ["a rule add that throws", async (api) => {
      mock(api.permission.addRule).mockRejectedValueOnce(new Error(RAW));
      await addRule();
      return t("formatIpcError.unknownError");
    }],
  ];

  it.each(cases)("%s shows localized copy and logs the raw text", async (_label, failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await renderTab();
    const shown = await failure(api);
    expect(screen.getByText((content) => content.includes(shown))).toBeTruthy();
    expectNoRaw();
    expect(warn.mock.calls.some((call) => call.some((arg) => typeof arg === "string" && arg.includes("EACCES")))).toBe(true);
    warn.mockRestore();
  });

  // The slash-backed directory dispatch puts chat-oriented English, or a bare IPC code, in `error` itself.
  function dirDispatchFailing(failure: { add?: unknown; remove?: unknown }) {
    const api = installApi([[]]);
    mock(api.permission.dirDispatch).mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "list") {
        return { ok: true, verb: "list", defaults: [], userAdditions: ["/tmp/ave-extra"], effective: [] };
      }
      if (rawArgs.startsWith("allow") && failure.add) return failure.add;
      if (rawArgs.startsWith("deny") && failure.remove) return failure.remove;
      return { ok: true, verb: "list", defaults: [], userAdditions: [], effective: [] };
    });
    return api;
  }

  async function addDirectory() {
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("경로 (예: ~/Documents/project)"), { target: { value: "/tmp/other" } });
      fireEvent.click(screen.getAllByText("추가").at(-1)!);
    });
  }

  it.each([
    ["chat-oriented usage text", { ok: false, error: "missing subcommand — usage: /permission dir <allow|deny|list> [path] [--session]" }, "디렉터리를 추가하지 못했습니다.", "usage:"],
    ["a known IPC code", { ok: false, error: "user-keyboard-required" }, t("formatIpcError.userKeyboardRequired"), "user-keyboard-required"],
  ] as const)("a directory add refused with %s shows localized copy", async (_label, add, shown, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dirDispatchFailing({ add });
    await renderPermissionsTab();
    await addDirectory();
    expect(screen.getByText(shown)).toBeTruthy();
    expect(document.body.textContent).not.toContain(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("directory add failed"), add.error, "");
    warn.mockRestore();
  });

  it.each([
    ["free text", { ok: false, error: "workspace lifecycle unavailable" }, "디렉터리를 제거하지 못했습니다.", "workspace lifecycle"],
    ["an unknown code", { ok: false, error: "dir-locked" }, "디렉터리를 제거하지 못했습니다. (dir-locked)", "-"],
    ["the frame-trust code", { ok: false, error: "unauthorized-frame" }, t("formatIpcError.unauthorizedFrame"), "unauthorized-frame"],
  ] as const)("a directory remove refused with %s shows localized copy", async (_label, remove, shown, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dirDispatchFailing({ remove });
    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getAllByText("✕").at(-1)!);
    });
    expect(screen.getByText(shown)).toBeTruthy();
    if (raw !== "-") expect(document.body.textContent).not.toContain(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("directory remove failed"), remove.error, "");
    warn.mockRestore();
  });

  it("a reviewer dispatch slash-parse failure shows the localized reviewer error, not the parser text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = installApi([[]]);
    mock(api.permission.reviewerDispatch).mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") {
        return reviewerResult("show", "disabled", "deny");
      }
      return { ok: false, error: "unknown subcommand 'llm' — expected show|mode|model" };
    });
    await renderPermissionsTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });
    expect(screen.getByText(t("permissionsTab.errorReviewerFallbackContext"))).toBeTruthy();
    expect(document.body.textContent).not.toContain("unknown subcommand");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reviewer dispatch failed"), expect.stringContaining("unknown subcommand"), "");
    warn.mockRestore();
  });

  it("a load failure shows localized copy and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = installApi([[]]);
    api.permission.getMode.mockRejectedValueOnce(new Error(RAW));
    await renderPermissionsTab();
    await waitFor(() => expect(screen.getByTestId("permissions-load-error")).toHaveTextContent(t("permissionsTab.errorLoadFailed")));
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("load failed"), RAW);
    warn.mockRestore();
  });
});

/** A refresh must not blank the panel. Every rule/directory mutation broadcasts a permission-config-changed hint, and this tab answers it by re-running `fetchAll`. While `loading` was true for THAT fetch too, the whole panel collapsed to a single "loading" line; the
 * scroll container went from thousands of pixels to one viewport, the browser clamped scrollTop to the new maximum, and the position was gone by the time the content came back. Measured on the real app: removing a rule near the bottom took the scroll container from 1562 to 8. */
describe("PermissionsTab background refresh", () => {
  it("keeps the loaded panel on screen while a config-change refresh runs", async () => {
    const api = installApi([[], []]);
    const onConfigChanged = api.permission.onConfigChanged as unknown as ReturnType<typeof vi.fn>;

    await renderPermissionsTab();
    await waitFor(() => expect(screen.queryByTestId("permissions-loading")).toBeNull());

    // The hint the host broadcasts after addRule/removeRule.
    const notify = onConfigChanged.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(notify).toBeTypeOf("function");

    let resolveRules: ((rows: { rules: never[]; errors: ScopedPermissionRuleError[] }) => void) | undefined;
    (api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRules = resolve as (rows: { rules: never[]; errors: ScopedPermissionRuleError[] }) => void; }),
    );

    await act(async () => {
      notify!();
    });

    // Mid-refresh: the panel the user was reading is still there.
    expect(screen.queryByTestId("permissions-loading")).toBeNull();
    expect(screen.getByTestId("permissions-rule-pattern-input")).toBeTruthy();

    await act(async () => {
      resolveRules?.({ rules: [], errors: [] });
    });
    expect(screen.queryByTestId("permissions-loading")).toBeNull();
  });

  it("still shows the loading surface on the FIRST load, where there is nothing to keep", async () => {
    const api = installApi([[]]);
    let resolveRules: ((rows: { rules: never[]; errors: ScopedPermissionRuleError[] }) => void) | undefined;
    (api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRules = resolve as (rows: { rules: never[]; errors: ScopedPermissionRuleError[] }) => void; }),
    );

    await renderPermissionsTab();
    expect(screen.getByTestId("permissions-loading")).toBeTruthy();

    await act(async () => {
      resolveRules?.({ rules: [], errors: [] });
    });
    await waitFor(() => expect(screen.queryByTestId("permissions-loading")).toBeNull());
  });
});

describe("PermissionsTab — revoking a stored approval", () => {
  it("revokes a persistent decision at once, with nothing to confirm", async () => {
    // Removing a stored decision destroys nothing and grants nothing: the next matching call follows the current policy and may ask
    // again. A browser confirm here blocked the renderer thread to ask about an action that was already reversible by re-answering the prompt.
    const confirm = vi.spyOn(window, "confirm");
    try {
      const api = installApi([[]]);
      (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => [
        {
          key: "bash:rm",
          decision: "allow" as const,
          approvedAt: "2026-01-01T00:00:00.000Z",
          scope: "persistent" as const,
          verdictAtApproval: "medium" as const,
          nlJustification: null,
          revokedAt: null,
          toolName: "bash",
        },
      ]);

      await act(async () => {
        render(<PermissionsTab />);
      });
      await waitFor(() => expect(screen.getByTestId("permissions-rules-table")).toBeTruthy());

      await act(async () => {
        fireEvent.click(screen.getByText(t("permissionsTab.revokeButton")));
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(api.userApproval.revokeByKey).toHaveBeenCalledWith("bash:rm");
    } finally {
      confirm.mockRestore();
    }
  });
});

describe("PermissionsTab unified permission rules", () => {
  it("lists user/project rules and persistent/session exact approvals together and revokes each at its owner", async () => {
    const api = installApi([[]]);
    const userRule = { pattern: "Bash(git status *)", action: "allow", scope: "user" };
    const projectRule = { pattern: "Bash(git push *)", action: "deny", scope: "project", projectCwd: "/workspace/project" };
    const listRules = api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>;
    listRules.mockResolvedValue({ rules: [userRule, projectRule], errors: [] });
    (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: "exact-persistent", decision: "allow", approvedAt: "2026-01-01T00:00:00.000Z", scope: "persistent", verdictAtApproval: "medium", nlJustification: null, revokedAt: null, toolName: "read_file", projectCwd: "/workspace/project" },
      { key: "exact-session", decision: "allow", approvedAt: "2026-01-01T00:00:00.000Z", scope: "session", verdictAtApproval: "medium", nlJustification: null, revokedAt: null, toolName: "bash", sessionId: "conversation-session" },
    ]);
    await act(async () => { render(<PermissionsTab />); });
    const table = await screen.findByTestId("permissions-rules-table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(table).toHaveTextContent("Bash(git status *)");
    expect(table).toHaveTextContent("Bash(git push *)");
    expect(table).toHaveTextContent("conversation-session");
    expect(screen.queryByTestId("permissions-approvals-table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.revokeNamedRule", { pattern: projectRule.pattern }) }));
    await waitFor(() => expect(api.permission.removeScopedRule).toHaveBeenCalledWith(projectRule));
    const exactRow = Array.from(table.querySelectorAll('tr[data-rule-store="exact"]')).find((row) => row.textContent?.includes("conversation-session"));
    fireEvent.click(exactRow!.querySelector("button")!);
    await waitFor(() => expect(api.userApproval.revokeByKey).toHaveBeenCalledWith("exact-session"));
  });

  it.each(["en", "ko"] as const)("shows an inert wildcard reason and one-click removal in %s", async (locale) => {
    setLocale(locale);
    const api = installApi([[]]);
    const inert = { pattern: "Bash(npm run *)", action: "allow", scope: "user", invalidReason: "wildcard-not-allowlisted" };
    const healthy = { pattern: "Bash(git status *)", action: "allow", scope: "user" };
    const list = api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce({ rules: [inert, healthy], errors: [] }).mockResolvedValue({ rules: [healthy], errors: [] });
    await act(async () => { render(<PermissionsTab />); });
    const table = await screen.findByTestId("permissions-rules-table");
    const reasons = screen.getAllByTestId("permissions-rule-invalid");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toHaveTextContent(t("permissionsTab.ruleInvalidWildcardNotAllowlisted"));
    expect(reasons[0].closest("tr")).toHaveTextContent(inert.pattern);
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.revokeNamedRule", { pattern: inert.pattern }) }));
    await waitFor(() => expect(api.permission.removeScopedRule).toHaveBeenCalledWith(inert));
    await waitFor(() => expect(screen.queryByTestId("permissions-rule-invalid")).toBeNull());
    expect(table).toHaveTextContent(healthy.pattern);
  });

  it.each(["en", "ko"] as const)("lists a retired host terminal rule with a delete action in %s", async (locale) => {
    setLocale(locale);
    const api = installApi([[]]);
    const retired = { pattern: 'HostTerminal(zsh "/workspace" printf ready)', action: "allow", scope: "user", invalidReason: "retired-host-terminal" };
    const list = api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce({ rules: [retired], errors: [] }).mockResolvedValue({ rules: [], errors: [] });
    await act(async () => { render(<PermissionsTab />); });
    const reason = await screen.findByTestId("permissions-rule-invalid");
    expect(reason).toHaveTextContent(t("permissionsTab.ruleRetiredHostTerminal"));
    expect(reason.closest("tr")).toHaveTextContent(retired.pattern);
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.revokeNamedRule", { pattern: retired.pattern }) }));
    await waitFor(() => expect(api.permission.removeScopedRule).toHaveBeenCalledWith(retired));
    await waitFor(() => expect(screen.queryByTestId("permissions-rule-invalid")).toBeNull());
  });

  it("refreshes the scoped list after adding or revoking a rule", async () => {
    const api = installApi([[]]);
    const rule = { pattern: "Bash(git status *)", action: "allow", scope: "user" };
    const list = api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce({ rules: [], errors: [] }).mockResolvedValueOnce({ rules: [rule], errors: [] }).mockResolvedValueOnce({ rules: [], errors: [] });
    await act(async () => { render(<PermissionsTab />); });
    await waitFor(() => expect(screen.getByTestId("permissions-rule-pattern-input")).toBeVisible());
    fireEvent.change(screen.getByTestId("permissions-rule-pattern-input"), { target: { value: rule.pattern } });
    fireEvent.click(screen.getByTestId("permissions-rule-add"));
    await waitFor(() => expect(screen.getByTestId("permissions-rules-table")).toHaveTextContent(rule.pattern));
    fireEvent.click(screen.getByRole("button", { name: t("permissionsTab.revokeNamedRule", { pattern: rule.pattern }) }));
    await waitFor(() => expect(screen.queryByTestId("permissions-rules-table")).toBeNull());
    expect(api.permission.listRules).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("keeps live session approvals visible and revocable when the persistent store is corrupt", async () => {
    const api = installApi([[]]);
    const session = { key: "live-session", decision: "allow", approvedAt: "2026-01-01T00:00:00.000Z", scope: "session", verdictAtApproval: "medium", nlJustification: null, revokedAt: null, toolName: "bash", sessionId: "live-conversation" };
    (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unreadable store"));
    const sessionList = api.userApproval.listSession as unknown as ReturnType<typeof vi.fn>;
    sessionList.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
    await act(async () => { render(<PermissionsTab />); });
    const table = await screen.findByTestId("permissions-rules-table");
    expect(table).toHaveTextContent("live-conversation");
    expect(screen.getByTestId("permissions-rule-load-error")).toHaveTextContent(t("permissionsTab.savedApprovalsFile"));
    fireEvent.click(table.querySelector('tr[data-rule-store="exact"] button')!);
    await waitFor(() => expect(api.userApproval.revokeByKey).toHaveBeenCalledWith(session.key));
    await waitFor(() => expect(screen.queryByTestId("permissions-rules-table")).toBeNull());
    expect(sessionList).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("permissions-rule-load-error")).toBeVisible();
  });

  it("preserves the visible store error if session listing also fails", async () => {
    const api = installApi([[]]);
    (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unreadable store"));
    (api.userApproval.listSession as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("session unavailable"));
    await act(async () => { render(<PermissionsTab />); });
    await waitFor(() => expect(api.userApproval.listSession).toHaveBeenCalled());
    expect(screen.getByTestId("permissions-rule-load-error")).toHaveTextContent(t("permissionsTab.savedApprovalsFile"));
  });

  it("shows scoped corruption and exact-store load failures visibly", async () => {
    const api = installApi([[]]);
    (api.permission.listScopedRules as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rules: [], errors: [{ filePath: "/ave-home/permissions/projects/project.json", errorCode: "rules-file-unavailable" }] });
    (api.userApproval.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unreadable store"));
    await act(async () => { render(<PermissionsTab />); });
    await waitFor(() => expect(screen.getByTestId("permissions-rule-load-error")).toBeVisible());
    expect(screen.getByTestId("permissions-rule-load-error")).toHaveTextContent(t("permissionsTab.unifiedRulesLoadError"));
    expect(screen.getByTestId("permissions-rule-load-error")).toHaveTextContent("/ave-home/permissions/projects/project.json");
    expect(screen.getByTestId("permissions-rule-load-error")).toHaveTextContent(t("permissionsTab.savedApprovalsFile"));
  });
});


describe("owner-away approval auto-skip", () => {
  function settingsApi() {
    return window.aveApi as unknown as { getSettings: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
  }

  it("shows unlimited by default and saves the chosen number of minutes", async () => {
    installApi([[]]);
    settingsApi().getSettings.mockResolvedValue({ permissions: { ownerAwayAutoSkipMinutes: 0 } });
    settingsApi().updateSettings.mockResolvedValue({ ok: true });
    await renderPermissionsTab();
    const input = screen.getByTestId("owner-away-auto-skip");
    expect(input).toHaveValue(0);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.blur(input);
    await waitFor(() => expect(settingsApi().updateSettings).toHaveBeenCalledWith({ permissions: { ownerAwayAutoSkipMinutes: 7 } }));
    await waitFor(() => expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(7));
  });

  it("restores the saved value after an invalid edit or rejected save", async () => {
    installApi([[]]);
    settingsApi().getSettings.mockResolvedValue({ permissions: { ownerAwayAutoSkipMinutes: 4 } });
    settingsApi().updateSettings.mockResolvedValue({ ok: false, error: "invalid-owner-away-auto-skip" });
    await renderPermissionsTab();
    const input = screen.getByTestId("owner-away-auto-skip");
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(4));
    expect(settingsApi().updateSettings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("owner-away-auto-skip"), { target: { value: "9" } });
    fireEvent.blur(screen.getByTestId("owner-away-auto-skip"));
    await waitFor(() => expect(settingsApi().updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(4));
  });
});

describe("reviewer mode recovery", () => {
  function invalidReviewerResult() {
    return {
      ...reviewerResult("show", "disabled", "deny"),
      fault: {
        kind: "reviewer-mode-invalid" as const,
        filePath: "/ave-home/config/settings.json",
        detail: "private unsupported reviewer value",
      },
    };
  }

  it.each([
    ["en", "llm"], ["en", "disabled"], ["ko", "llm"], ["ko", "disabled"],
  ] as const)("repairs the saved mode with one %s action to %s", async (locale, recoveredMode) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const api = installApi([[]]);
      api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
        if (rawArgs === "show") return invalidReviewerResult();
        if (rawArgs === `mode ${recoveredMode}`) return reviewerResult("mode", recoveredMode, "deny");
        throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
      });
      const settings = window.aveApi as unknown as { getSettings: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
      settings.getSettings.mockResolvedValue({ permissions: { ownerAwayAutoSkipMinutes: 9 } });

      await renderPermissionsTab();

      expect(screen.getByTestId("reviewer-mode-fault")).toHaveTextContent(t("permissionsTab.reviewerModeFaultTitle"));
      expect(screen.getByTestId("reviewer-mode-fault")).toHaveTextContent(t("permissionsTab.reviewerModeFaultDescription"));
      expect(screen.getByTestId("reviewer-mode-repair-llm")).toHaveTextContent(locale === "ko" ? "자동 리뷰 사용" : "Use automatic review");
      expect(screen.getByTestId("reviewer-mode-repair-disabled")).toHaveTextContent(locale === "ko" ? "리뷰 끄기: auto 모드에서도 카드로 확인" : "Turn off review: auto asks with a card");
      const judgeMode = screen.getByLabelText(t("permissionJudge.mode"));
      expect(judgeMode).toBeDisabled();
      expect(judgeMode).toHaveValue("");
      expect(judgeMode).toHaveDisplayValue(locale === "ko" ? "선택 필요" : "Choose a mode");
      expect(judgeMode).toHaveAttribute("aria-describedby", "reviewer-mode-fault");
      expect(screen.queryByTestId("permissions-load-error")).toBeNull();
      expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(9);
      expect(document.body.textContent).not.toContain("private unsupported reviewer value");
      expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show"]);

      await act(async () => { fireEvent.click(screen.getByTestId(`reviewer-mode-repair-${recoveredMode}`)); });

      expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show", `mode ${recoveredMode}`]);
      expect(screen.queryByTestId("reviewer-mode-fault")).toBeNull();
      expect(screen.getByLabelText(t("permissionJudge.mode"))).toBeEnabled();
      expect(screen.getByLabelText(t("permissionJudge.mode"))).toHaveValue("off");
      expect(screen.getByTestId("owner-away-auto-skip")).toHaveValue(9);
      expect(api.permission.setMode).not.toHaveBeenCalled();
      expect(settings.updateSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      setLocale(previousLocale);
    }
  });

  it("saves an unrelated reviewer model without replacing an invalid reviewer mode or evaluator chain", async () => {
    const api = installApi([[]]);
    api.permission.reviewerDispatch.mockResolvedValue(invalidReviewerResult());
    const judgeGet = mockJudgeGet({
      modelOptions: [{ vendor: "claude", model: "available-reviewer" }],
    });
    const judgeSet = vi.fn(async (patch: { model: unknown }) => ({
      ...(await judgeGet()), settings: { ...(await judgeGet()).settings, model: patch.model },
    }));
    Object.assign(api.permission, { judgeGet, judgeSet });
    await renderPermissionsTab();

    const judgeMode = screen.getByLabelText(t("permissionJudge.mode"));
    expect(judgeMode).toBeDisabled();
    expect(judgeMode).toHaveValue("");
    const picker = await screen.findByTestId("permission-reviewer-model");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    const option = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")]
        .find((row) => row.textContent?.includes("available-reviewer"));
      if (!found) throw new Error("chooser not open yet");
      return found;
    });
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t("permissionJudge.save") })); });

    expect(judgeSet).toHaveBeenCalledExactlyOnceWith({ model: { vendor: "claude", model: "available-reviewer" } });
    expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show"]);
    expect(screen.getByTestId("reviewer-mode-fault")).toBeVisible();
    expect(screen.getByLabelText(t("permissionJudge.mode"))).toBeDisabled();
    expect(screen.getByLabelText(t("permissionJudge.mode"))).toHaveValue("");
  });

  it("refreshes the saved repair choice while keeping a reconnect error visible", async () => {
    const api = installApi([[]]);
    let repaired = false;
    api.permission.reviewerDispatch.mockImplementation(async (rawArgs: string) => {
      if (rawArgs === "show") return repaired ? reviewerResult("show", "llm", "deny") : invalidReviewerResult();
      if (rawArgs === "mode llm") {
        repaired = true;
        return { ok: false, error: "reviewer-rewire-failed: private reviewer transport failure" };
      }
      throw new Error(`unexpected reviewerDispatch: ${rawArgs}`);
    });
    await renderPermissionsTab();

    await act(async () => { fireEvent.click(screen.getByTestId("reviewer-mode-repair-llm")); });

    expect(screen.queryByTestId("reviewer-mode-fault")).toBeNull();
    expect(screen.getByText(t("permissionsTab.reviewerModeRecoveryRewireFailed"), { exact: false })).toBeVisible();
    expect(api.permission.reviewerDispatch.mock.calls.map(([verb]) => verb)).toEqual(["show", "mode llm", "show"]);
    expect(document.body.textContent).not.toContain("private reviewer transport failure");
    expect(screen.queryByTestId("permissions-load-error")).toBeNull();
    expect(api.permission.setMode).not.toHaveBeenCalled();
  });
});
