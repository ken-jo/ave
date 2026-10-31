/** Permission policy hidden Settings reviewer controls. Provider/model are no longer reviewer-local
 * controls. In Settings, auto mode exposes the read-only prompt panel only; reviewer config stays slash/internal. */
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

import { PermissionsTab } from "../PermissionsTab.js";
import { makeHookTrustRow as hook } from "./test-helpers.js";
import type { HookTrustRow } from "../../types.js";
import { TEST_IDS, execModeTestId } from "../../../../shared/test-ids.js";


/** Build a minimal window.ave mock for the reviewer section. */
function installApi() {
  const ave = {
    permission: {
      egressGrantsList: vi.fn(async () => ({ ok: true as const, grants: [] })),
      egressGrantRevoke: vi.fn(async () => ({ ok: true as const })),
      // The reviewer config only renders under the auto-verification mode now that the permission UI exposes a single axis.
      getMode: vi.fn(async () => ({ mode: "auto" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
      addRule: vi.fn(async () => ({ ok: true, rule: { pattern: "x", action: "allow" } })),
      removeRule: vi.fn(async () => ({ ok: true })),
      recentlyDeniedList: vi.fn(async () => ({ ok: true as const, entries: [], total: 0 })),
      recentlyDeniedRerun: vi.fn(async () => ({ ok: true })),
      onRecentlyDeniedChanged: vi.fn(() => () => undefined),
      hookTrustList: vi.fn(async () => ({
        ok: true as const,
        active: [],
        disabled: [hook("test.sh")],
        totalDisabled: 1,
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
          return {
            ok: true as const,
            verb: "show" as const,
            settings: {
              mode: "disabled" as const,
              fallbackOnError: "deny" as const,
            },
          };
        }
        // provider change command
        return {
          ok: true as const,
          verb: "provider" as const,
          settings: {
            mode: "disabled" as const,
            fallbackOnError: "deny" as const,
          },
        };
      }),
      sandboxCapability: vi.fn(async () => ({
        platform: "linux" as NodeJS.Platform,
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
        source: "defaults",
        adminPath: undefined,
      })),
      set: vi.fn(async () => ({ ok: true })),
    },
  };

  (globalThis as unknown as { window: typeof window }).window.ave = ave as never;
  // The tab subscribes to settings changes and reads the env-forced set on mount, so it needs a real api double rather than a bare object.
  installMockAveApi({ settings: { features: { osToolSandbox: false } } });
  return ave;
}

describe("PermissionsTab C3 — active LLM following", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { ave?: unknown }).ave;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ave?: unknown }).ave;
  });

  it("renders the prompt collapse inside Auto-verify instead of reviewer provider/model controls", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.queryByTestId(TEST_IDS.reviewerPromptPanel)).toBeInTheDocument(),
    );
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.queryByTestId("reviewer-active-llm-source")).toBeNull();
    expect(screen.queryByTestId("reviewer-provider-select")).toBeNull();
    expect(screen.queryByTestId("reviewer-model-input")).toBeNull();
  });

  it("shows the read-only permission reviewer prompt collapsed under Auto-verify", async () => {
    installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeInTheDocument(),
    );
    expect(screen.queryByText("검증 프롬프트")).toBeNull();
    expect(screen.getByTestId(execModeTestId("auto"))).toContainElement(screen.getByTestId(TEST_IDS.reviewerPromptPanel));
    expect(screen.getByTestId("reviewer-system-prompt")).toHaveTextContent("UNTRUSTED_INPUT");
  });

  it("re-selecting auto-verify wires the llm reviewer", async () => {
    const api = installApi();
    await act(async () => {
      render(<PermissionsTab />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeInTheDocument(),
    );

    // Re-selecting the auto-verification mode auto-wires `mode llm`.
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("default")));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(execModeTestId("auto")));
    });

    expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
  });
});
