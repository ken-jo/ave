// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Sidebar } from "../Sidebar.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onLoadSession = vi.fn();
  const onNewChatForProject = vi.fn();
  const sessions: SessionSummary[] = [
    {
      id: "sess-1",
      title: "전체 동기화로 상태 파악",
      modifiedAt: new Date().toISOString(),
      sessionKind: "main",
    },
    {
      id: "sess-2",
      title: "사이드 패널 개선",
      modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionKind: "main",
    },
    {
      id: "sess-other",
      title: "다른 프로젝트 대화",
      modifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      sessionKind: "main",
      projectRoot: "C:\\Users\\ikcha\\workspace\\former_org\\other-app",
      projectName: "other-app",
    },
  ];

  const props: Parameters<typeof Sidebar>[0] = {
    activeView: "home",
    onSelect: vi.fn(),
    pluginViews: [],
    hasApiKey: true,
    onOpenSettings: vi.fn(),
    onNewChat: vi.fn(),
    streaming: false,
    onOpenMarketplace: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
    isCurrentSessionStarred: false,
    onToggleCurrentSessionStar: vi.fn(),
    onExport: vi.fn(),
    sessions,
    currentSessionId: "sess-1",
    onLoadSession,
    onNewChatForProject,
    ...overrides,
  };

  const previous = (window as unknown as { ave?: unknown }).ave;
  (window as unknown as { ave?: unknown }).ave = {
    ...(previous && typeof previous === "object" ? previous : {}),
    workspace: {
      listRoots: vi.fn(async () => ({
        ok: true,
        defaultRoot: "C:\\Users\\ikcha\\workspace\\former_org\\ave",
        roots: [
          { path: "C:\\Users\\ikcha\\workspace\\former_org\\ave", isDefault: true },
          { path: "C:\\Users\\ikcha\\workspace\\former_org\\other-app", isDefault: false },
        ],
      })),
    },
  };

  const result = render(
    <TooltipProvider>
      <Sidebar {...props} />
    </TooltipProvider>,
  );

  return {
    ...result,
    onLoadSession,
    onNewChatForProject,
    restore: () => {
      if (previous === undefined) {
        delete (window as unknown as { ave?: unknown }).ave;
      } else {
        (window as unknown as { ave?: unknown }).ave = previous;
      }
    },
  };
}

describe("Sidebar project sessions", () => {
  it("renders no-project conversations as a plain ungrouped list, and only real projects as groups", async () => {
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar();
    try {
      // "other-app" is a real (non-default) project — still rendered as its
      // own named group with a project row.
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-ikcha-workspace-ave-project-other-app").textContent).toContain("other-app");
      });
      expect(getByText("다른 프로젝트 대화")).toBeTruthy();

      // sess-1/sess-2 carry no projectRoot — they render in the plain
      // ungrouped list, NOT wrapped in a fake "Current Project"/default
      // group (2026-07 "remove Current Project labeling"). No such testid
      // exists anymore.
      expect(queryByTestId("sidebar-current-project")).toBeNull();
      const unassigned = getByTestId("sidebar-unassigned-sessions");
      expect(unassigned.textContent).toContain("전체 동기화로 상태 파악");
      expect(unassigned.textContent).toContain("사이드 패널 개선");
      expect(getByText("전체 동기화로 상태 파악")).toBeTruthy();
      expect(getByText("사이드 패널 개선")).toBeTruthy();
      expect(getByTestId("sidebar-session-sess-1").getAttribute("aria-current")).toBe("page");
    } finally {
      restore();
    }
  });

  it("loads a selected project conversation through the existing session loader", async () => {
    const { getByTestId, onLoadSession, restore } = renderSidebar();
    try {
      fireEvent.click(getByTestId("sidebar-session-sess-2"));
      expect(onLoadSession).toHaveBeenCalledWith("sess-2");
    } finally {
      restore();
    }
  });

  it("starts a new conversation scoped to the selected project", async () => {
    const { getByTestId, onNewChatForProject, restore } = renderSidebar();
    try {
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-ikcha-workspace-ave-project-other-app").textContent).toContain("other-app");
      });
      fireEvent.click(getByTestId("sidebar-project-C-Users-ikcha-workspace-ave-project-other-app"));
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\ikcha\\workspace\\former_org\\other-app",
        projectName: "other-app",
      });
    } finally {
      restore();
    }
  });
});
