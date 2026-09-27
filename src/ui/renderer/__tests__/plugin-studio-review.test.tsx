import "../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/runtime.js";
import type { PluginStudioApi, StudioDraftView } from "../../../shared/plugin-studio.js";
import { PluginStudioView } from "../tabs/git-marketplace/PluginStudioView.js";

describe("Studio review page", () => {
  it("reports an interrupted draft as needing review and blocks install and sharing", async () => {
    const view: StudioDraftView = {
      draft: { version: 1, name: "team-kit", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        parts: [], diagnostics: [], pendingHooks: [], reviewed: { treeDigest: "a".repeat(64), at: "2026-01-01T00:00:00Z" }, writeState: "pending" },
      files: [{ path: "plugin.json", text: JSON.stringify({ version: "1.0.1", description: "A team plugin" }) }],
      treeDigest: "b".repeat(64), reviewStatus: "needs-review", diagnostics: [], connectorStatuses: [],
      components: null, errors: ["Studio draft has an incomplete write; save it again before review"], lint: [],
    };
    const api = { listDrafts: vi.fn(async () => ({ ok: true, value: [view.draft] })),
      availableParts: vi.fn(async () => ({ ok: true, value: { skills: [], routines: [], connectors: [], prompts: [], agents: [] } })),
      readDraft: vi.fn(async () => ({ ok: true, value: view })) } as unknown as PluginStudioApi;
    render(<PluginStudioView api={api} onInstalled={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "team-kit" }));
    expect(await screen.findByTestId("plugin-studio:review-status")).toHaveTextContent(t("pluginStudio.needsReview"));
    expect(screen.getByTestId("plugin-studio:install")).toBeDisabled();
    expect(screen.getByTestId("plugin-studio:share")).toBeDisabled();
  });
});
