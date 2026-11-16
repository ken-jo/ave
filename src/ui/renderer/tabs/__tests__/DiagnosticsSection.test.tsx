import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { installMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { DiagnosticsSection } from "../DiagnosticsSection.js";
import { t } from "../../../../i18n/runtime.js";

function installDiagnosticsApi() {
  const api = installMockAveApi();
  const tail = vi.fn(async (_args?: unknown) => ({ ok: true, lines: ["latest log"] }));
  const exportBundle = vi.fn(async () => ({ ok: false, canceled: true }));
  Object.assign(api, {
    logs: { tail },
    diagnostics: { export: exportBundle, crashList: vi.fn(async () => ({ ok: true, dumps: [] })) },
  });
  return { tail, exportBundle };
}

describe("DiagnosticsSection filters", () => {
  it("loads changed log levels immediately and ignores older responses", async () => {
    const { tail } = installDiagnosticsApi();
    let finishOld: (result: { ok: boolean; lines: string[] }) => void = () => { throw new Error("not requested"); };
    tail.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const view = render(<DiagnosticsSection defaultDateFrom="2026-01-01" defaultDateTo="2026-01-31" />);
    await waitFor(() => expect(tail).toHaveBeenCalledTimes(1));
    fireEvent.change(view.getByRole("combobox"), { target: { value: "error" } });
    await view.findByText("latest log");
    expect(tail).toHaveBeenLastCalledWith({ lines: 200, level: "error" });
    await act(async () => finishOld({ ok: true, lines: ["stale log"] }));
    expect(view.queryByText("stale log")).toBeNull();
  });

  it("names the bundle export range and refuses reversed dates before IPC", async () => {
    const { exportBundle } = installDiagnosticsApi();
    const view = render(<DiagnosticsSection defaultDateFrom="2026-02-01" defaultDateTo="2026-01-01" />);
    expect(view.getByTestId("diagnostics-export-range")).toHaveTextContent("2026-02-01");
    expect(view.getByTestId("diagnostics-export-range")).toHaveTextContent("2026-01-01");
    fireEvent.click(view.getByRole("button", { name: t("auditTab.bundleExportButton") }));
    await view.findByText(t("auditTab.invalidDateRange"));
    expect(exportBundle).not.toHaveBeenCalled();
  });
});
