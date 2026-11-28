import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { DocumentEngineApi } from "../../../../shared/document-engine-api.js";
import type { DocumentEngineInstallationState } from "../../../../shared/document-engine.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { DocumentEngineInstallContent } from "../DocumentEngineInstallContent.js";
import { DOCUMENT_ENGINE_IMPORTER } from "../../../../shared/document-engine-importer.js";

const ABSENT: DocumentEngineInstallationState = { phase: "absent", version: "26.8.1", downloadBytes: 314_572_800,
  downloadedBytes: 0, installedBytes: 943_718_400 };
let previousLocale: ReturnType<typeof getLocale>;
beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
afterEach(() => { setLocale(previousLocale); vi.useRealTimers(); vi.restoreAllMocks(); });

function installation(initial = ABSENT) {
  let current = initial;
  const status = vi.fn(async () => ({ ok: true as const, state: current }));
  const install = vi.fn(async () => { current = { ...ABSENT, phase: "downloading", downloadedBytes: ABSENT.downloadBytes / 2 }; return { ok: true as const }; });
  const cancel = vi.fn(async () => { current = { ...ABSENT, phase: "error", error: "cancelled" }; return { ok: true as const }; });
  const uninstall = vi.fn(async () => { current = ABSENT; return { ok: true as const }; });
  return { api: { status, install, cancel, uninstall } satisfies DocumentEngineApi, status, install, cancel, uninstall,
    setState: (state: DocumentEngineInstallationState) => { current = state; } };
}

describe("optional document engine installation", () => {
  it("discloses the extension size and local processing before a direct setup action", async () => {
    const { api, install } = installation();
    const dismissed = vi.fn();
    render(<DocumentEngineInstallContent api={api} onDismiss={dismissed} />);
    expect(await screen.findByTestId("document-engine-size")).toHaveTextContent("HWP import extension · 300 MiB download · LibreOffice 26.8.1");
    expect(screen.getByRole("heading")).toHaveTextContent("Document engine (LibreOffice) (optional)");
    expect(screen.getByText(/private copy/)).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /^Later$/ }).at(-1)!);
    expect(dismissed).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
  });

  it("shows progress, cancels directly, and offers a retry after cleanup", async () => {
    const { api, install, cancel } = installation();
    render(<DocumentEngineInstallContent api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install import extension" }));
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveValue(ABSENT.downloadBytes / 2));
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(install).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await screen.findByText("Setup cancelled. Existing viewers remain available.");
    expect(cancel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
  });

  it("surfaces a signature refusal and removes an installed engine without a confirmation", async () => {
    const { api, uninstall } = installation({ ...ABSENT, phase: "ready" });
    const confirm = vi.spyOn(window, "confirm");
    render(<DocumentEngineInstallContent api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove import extension" }));
    await screen.findByRole("button", { name: "Install import extension" });
    expect(uninstall).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    api.install.mockImplementationOnce(async () => ({ ok: false, error: "signature-failed" }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Install import extension" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("publisher signature could not be verified");
  });

  it("shows first-use verification of an installed engine without offering a cancel or install action", async () => {
    const { api, status, setState } = installation({ ...ABSENT, phase: "verifying-installation" });
    render(<DocumentEngineInstallContent api={api} />);
    expect(await screen.findByText("Verifying LibreOffice before first use")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install import extension" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove import extension" })).toBeNull();
    setState({ ...ABSENT, phase: "ready" });
    await screen.findByRole("button", { name: "Remove import extension" }, { timeout: 2_000 });
    expect(status.mock.calls.length).toBeGreaterThan(1);
  });

  it("releases polling and ignores a late state response after unmount", async () => {
    const { api, status } = installation({ ...ABSENT, phase: "downloading" });
    const view = render(<DocumentEngineInstallContent api={api} />);
    await screen.findByRole("progressbar");
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<DocumentEngineApi["status"]>>>();
    status.mockReturnValueOnce(pending.promise as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    view.unmount();
    const calls = status.mock.calls.length;
    await act(async () => { pending.resolve({ ok: true, state: { ...ABSENT, phase: "downloading" } });
      await vi.advanceTimersByTimeAsync(2000); });
    expect(status).toHaveBeenCalledTimes(calls);
  });

  it("uses the Korean optional-install copy and disables unsupported package installation", async () => {
    setLocale("ko");
    const { api, install } = installation({ ...ABSENT, phase: "unsupported", error: "unsupported-platform" });
    render(<DocumentEngineInstallContent api={api} />);
    expect(screen.getByRole("heading")).toHaveTextContent("문서 엔진 (LibreOffice)");
    expect(await screen.findByRole("button", { name: "다시 설정" })).toBeDisabled();
    expect(install).not.toHaveBeenCalled();
  });

  it("reports an unverifiable installation record without promising an automatic repair", async () => {
    const { api, install, uninstall, status } = installation();
    status.mockResolvedValueOnce({ ok: false, error: "integrity-failed" } as never);
    render(<DocumentEngineInstallContent api={api} />);
    expect(await screen.findByText(/installation record could not be verified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove import extension" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByRole("button", { name: "Install import extension" });
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("asks the user to install LibreOffice when it is missing, offering no download, and checks again on request", async () => {
    const { api, install, status, setState } = installation({ ...ABSENT, phase: "app-missing", version: "" });
    const previousApi = window.aveApi;
    const openExternalUrl = vi.fn(async () => ({ ok: true }));
    window.aveApi = { openExternalUrl } as never;
    try {
      render(<DocumentEngineInstallContent api={api} />);
      expect(await screen.findByTestId("document-engine-app-missing")).toHaveTextContent("LibreOffice is not installed");
      expect(screen.queryByRole("button", { name: "Install import extension" })).toBeNull();
      fireEvent.click(screen.getByRole("link", { name: "Get LibreOffice" }));
      expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://www.libreoffice.org/download/download-libreoffice/");
      setState(ABSENT);
      const calls = status.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await screen.findByRole("button", { name: "Install import extension" });
      expect(status.mock.calls.length).toBeGreaterThan(calls);
      expect(install).not.toHaveBeenCalled();
    } finally {
      window.aveApi = previousApi;
    }
  });

  it("exposes pinned source and license links and opens them only on a user click", async () => {
    const { api } = installation();
    const previousApi = window.aveApi;
    const openExternalUrl = vi.fn(async () => ({ ok: true }));
    window.aveApi = { openExternalUrl } as never;
    try {
      render(<DocumentEngineInstallContent api={api} />);
      const source = screen.getByRole("link", { name: "H2Orestart source" });
      const license = screen.getByRole("link", { name: "GPL-3.0 license" });
      expect(source).toHaveAttribute("href", DOCUMENT_ENGINE_IMPORTER.source);
      expect(license).toHaveAttribute("href", DOCUMENT_ENGINE_IMPORTER.license);
      expect(openExternalUrl).not.toHaveBeenCalled();
      fireEvent.click(source);
      expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ENGINE_IMPORTER.source);
      fireEvent.click(license);
      expect(openExternalUrl).toHaveBeenLastCalledWith(DOCUMENT_ENGINE_IMPORTER.license);
    } finally {
      window.aveApi = previousApi;
    }
  });
});
