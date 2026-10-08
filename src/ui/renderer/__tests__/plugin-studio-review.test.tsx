import "../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/runtime.js";
import type { PluginStudioApi, StudioDraftView, StudioLocalPreview } from "../../../shared/plugin-studio.js";
import { LocalPluginPackageSheet, PluginStudioView } from "../tabs/git-marketplace/PluginStudioView.js";

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
    expect(screen.getByText(t("pluginStudio.hooksNotComposable"))).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "team-kit" }));
    expect(await screen.findByTestId("plugin-studio:review-status")).toHaveTextContent(t("pluginStudio.needsReview"));
    expect(screen.getByTestId("plugin-studio:install")).toBeDisabled();
    expect(screen.getByTestId("plugin-studio:share")).toBeDisabled();
  });

  it("sends a hook approval only after its package-sheet checkbox is selected", async () => {
    const digest = "a".repeat(64);
    const preview: StudioLocalPreview = { previewId: "one", name: "team-kit", version: "1.0.0", description: "A team plugin",
      files: [{ path: "plugin.json", text: "{}" }], treeDigest: "b".repeat(64), expiresAt: "2026-01-01T00:00:00Z",
      hookConfinement: "user-permissions", components: { skills: [], prompts: [], agents: [], mcpServers: {}, routineTemplates: [], hooks: [
        { event: "pre", command: ["node", "./server/hook.js"], timeoutMs: 1200, digest },
      ] } };
    const installFromFile = vi.fn(async () => ({ ok: true as const, value: { name: "team-kit", version: "1.0.0", sourceId: null } }));
    render(<LocalPluginPackageSheet api={{ installFromFile } as unknown as PluginStudioApi} preview={preview}
      onClose={vi.fn()} onInstalled={vi.fn()} />);
    expect(screen.getByTestId("plugin-studio:hook-consent:0")).toHaveTextContent("./server/hook.js");
    fireEvent.click(screen.getByTestId("plugin-studio:hook-consent:0").querySelector("[role=checkbox]")!);
    fireEvent.click(screen.getByTestId("plugin-studio:install-confirm"));
    await waitFor(() => expect(installFromFile).toHaveBeenCalledWith("one", [{ kind: "hook", index: 0, digest }]));
  });
});
