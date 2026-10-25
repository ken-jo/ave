import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { RolesTab } from "../RolesTab.js";
import type { AveApi } from "../../types.js";
import { SavedToastProvider } from "../../context/SavedToastContext.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { t } from "../../../../i18n/runtime.js";

function renderRolesTab(api: Record<string, unknown>) {
  return render(
    <SavedToastProvider value={vi.fn()}>
      <RolesTab api={api as unknown as AveApi} />
    </SavedToastProvider>,
  );
}

describe("RolesTab — long-term memory consolidation", () => {
  it("runs manual consolidation and reports an updated global or project scope", async () => {
    const { api } = makeMockAveApi();
    api.memoryRefreshLongTerm.mockResolvedValue({
      ok: true,
      global: { status: "up-to-date", sourceCount: 2 },
      project: { status: "updated", sourceCount: 1, consolidatedAt: "2026-08-02T00:00:00.000Z" },
    });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:refresh-long-term-memory"));

    await waitFor(() => expect(api.memoryRefreshLongTerm).toHaveBeenCalledOnce());
    expect(await screen.findByText(t("rolesTab.statusLongTermMemoryConsolidated"))).toBeInTheDocument();
  });

  it("keeps service failures localized instead of exposing host error details", async () => {
    const { api } = makeMockAveApi();
    api.memoryRefreshLongTerm.mockResolvedValue({
      ok: false,
      error: "memory-consolidation-service-unavailable",
    });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:refresh-long-term-memory"));

    expect(await screen.findByText(t("rolesTab.errorLongTermMemoryConsolidationUnavailable"))).toBeInTheDocument();
  });
});

describe("RolesTab — ~/.ave reference doc upgrades", () => {
  it("shows the live doc path and no marker list when nothing is pending", async () => {
    const { api } = makeMockAveApi();
    const docs = deferred<Awaited<ReturnType<AveApi["homeDocsStatus"]>>>();
    api.homeDocsStatus.mockReturnValue(docs.promise);
    renderRolesTab(api);

    await waitFor(() => expect(api.homeDocsStatus).toHaveBeenCalled());
    await act(async () => {
      docs.resolve({
        agentsDisplayPath: "~/.ave/AGENTS.md",
        customDisplayPath: "~/.ave/agents.custom.md",
        markers: [],
        mergedContent: null,
      });
      await docs.promise;
    });
    expect(await screen.findByText("~/.ave/AGENTS.md")).toBeInTheDocument();
    expect(screen.queryByTestId("roles-tab:upgrade-markers")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roles-tab:merged-result")).not.toBeInTheDocument();
  });

  it("offers apply / keep-mine / diff per actionable marker and read-only for the rest", async () => {
    const { api } = makeMockAveApi();
    api.homeDocsStatus.mockResolvedValue({
      agentsDisplayPath: "~/.ave/AGENTS.md",
      customDisplayPath: "~/.ave/agents.custom.md",
      markers: [
        {
          markerPath: "AGENTS.md.new",
          sourcePath: "AGENTS.md",
          markerDisplayPath: "~/.ave/AGENTS.md.new",
          sourceDisplayPath: "~/.ave/AGENTS.md",
          actionable: true,
        },
        {
          markerPath: "skills/report.md.new",
          sourcePath: "skills/report.md",
          markerDisplayPath: "~/.ave/skills/report.md.new",
          sourceDisplayPath: "~/.ave/skills/report.md",
          actionable: false,
        },
      ],
      mergedContent: null,
    });
    api.homeDocsReadMarker.mockResolvedValue({ ok: true, content: "packaged v2", live: "mine" });
    renderRolesTab(api);

    expect(await screen.findByTestId("roles-tab:upgrade-markers")).toBeInTheDocument();
    // The pending markers belong to the AGENTS.md section, not a surface of their own: a marker rendered outside it has no
    // path shown beside it.
    expect(screen.getByTestId("roles-tab:agents-section")).toContainElement(
      screen.getByTestId("roles-tab:upgrade-markers"),
    );
    expect(screen.getByText(t("rolesTab.markerReadOnlyNote"))).toBeInTheDocument();
    expect(
      screen.queryByTestId("roles-tab:marker-apply:skills/report.md.new"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("roles-tab:marker-diff:AGENTS.md.new"));
    expect(await screen.findByTestId("file-edit-diff")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("roles-tab:marker-apply:AGENTS.md.new"));
    await waitFor(() =>
      expect(api.homeDocsApplyPackaged).toHaveBeenCalledWith("AGENTS.md.new"),
    );
  });

  it("reports the custom split when applying moved the user's content aside", async () => {
    const { api } = makeMockAveApi();
    api.homeDocsStatus.mockResolvedValue({
      agentsDisplayPath: "~/.ave/AGENTS.md",
      customDisplayPath: "~/.ave/agents.custom.md",
      markers: [
        {
          markerPath: "AGENTS.md.new",
          sourcePath: "AGENTS.md",
          markerDisplayPath: "~/.ave/AGENTS.md.new",
          sourceDisplayPath: "~/.ave/AGENTS.md",
          actionable: true,
        },
      ],
      mergedContent: null,
    });
    api.homeDocsApplyPackaged.mockResolvedValue({ ok: true, movedToCustom: true });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:marker-apply:AGENTS.md.new"));

    expect(
      await screen.findByText(t("rolesTab.statusPackagedAppliedWithCustom")),
    ).toBeInTheDocument();
  });

  it("edits AGENTS.md while keep-latest is off", async () => {
    const { api } = makeMockAveApi();
    renderRolesTab(api);

    const editor = await screen.findByTestId("roles-tab:agents-editor");
    expect((editor as HTMLTextAreaElement).value).toBe("# Agents");
    expect(screen.queryByTestId("roles-tab:packaged-view")).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Edited" } });
    fireEvent.click(screen.getByText(t("rolesTab.saveAgentsButton")));
    await waitFor(() => expect(api.memoryUpdateAgentsMd).toHaveBeenCalledWith("# Edited"));
    expect(api.homeDocsUpdateCustom).not.toHaveBeenCalled();
  });

  it("edits agents.custom.md and shows AGENTS.md read-only while keep-latest is on", async () => {
    const { api } = makeMockAveApi({
      settings: { ...MOCK_DEFAULT_SETTINGS, homeDocs: { keepLatest: true } },
    });
    api.homeDocsGetCustom.mockResolvedValue("# My rules");
    renderRolesTab(api);

    const editor = await screen.findByTestId("roles-tab:agents-editor");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("# My rules"));
    expect(screen.getByTestId("roles-tab:packaged-view")).toBeInTheDocument();
    expect(screen.getByText(t("rolesTab.packagedBadge"))).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# My edited rules" } });
    fireEvent.click(screen.getByText(t("rolesTab.saveAgentsButton")));
    await waitFor(() =>
      expect(api.homeDocsUpdateCustom).toHaveBeenCalledWith("# My edited rules"),
    );
    expect(api.memoryUpdateAgentsMd).not.toHaveBeenCalled();
  });

  it("runs the merge, shows the result read-only, and applies it against the loaded baseline", async () => {
    const { api } = makeMockAveApi();
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:merge-agents"));

    const merged = await screen.findByTestId("roles-tab:merged-result");
    expect(merged).toBeInTheDocument();
    expect(await screen.findByText(t("rolesTab.statusMerged"))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("roles-tab:merged-apply"));
    await waitFor(() => expect(api.homeDocsApplyMerged).toHaveBeenCalledWith("# Agents"));
  });

  it("surfaces a merge conflict as localized text rather than the host code", async () => {
    const { api } = makeMockAveApi();
    api.homeDocsMerge.mockResolvedValue({ ok: false, error: "agents-doc-changed" });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:merge-agents"));

    expect(
      await screen.findByText(t("formatIpcError.agentsDocChanged")),
    ).toBeInTheDocument();
    expect(screen.queryByText("agents-doc-changed")).not.toBeInTheDocument();
  });

  it("restores a merge left waiting from a previous session", async () => {
    const { api } = makeMockAveApi();
    api.homeDocsStatus.mockResolvedValue({
      agentsDisplayPath: "~/.ave/AGENTS.md",
      customDisplayPath: "~/.ave/agents.custom.md",
      markers: [],
      mergedContent: "# Pending merge",
    });
    renderRolesTab(api);

    expect(await screen.findByTestId("roles-tab:merged-result")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("roles-tab:merged-discard"));
    await waitFor(() => expect(api.homeDocsDiscardMerged).toHaveBeenCalledOnce());
    expect(await screen.findByText(t("rolesTab.statusMergedDiscarded"))).toBeInTheDocument();
  });

  it("persists the keep-latest toggle through settings", async () => {
    const { api } = makeMockAveApi();
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:keep-latest"));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ homeDocs: { keepLatest: true } }),
    );
  });
});
