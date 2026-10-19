// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { UpstreamProxySettings } from "../permissions/UpstreamProxySettings.js";
import type { UpstreamProxyPatch, UpstreamProxyView } from "../../../../shared/upstream-proxy.js";

function view(overrides: Partial<UpstreamProxyView> = {}): UpstreamProxyView {
  return {
    settings: { mode: "system", manualUrl: "", bypass: "", resolvesNames: false },
    hasCredentials: false,
    diagnostic: {
      url: "https://example.com/",
      source: "system",
      routes: [{ kind: "http", endpoint: "proxy.test:8080" }, { kind: "direct" }],
      skipped: ["SOCKS5 s:1080 (a SOCKS proxy, which the sandbox cannot use as an upstream)"],
    },
    ...overrides,
  };
}

describe("UpstreamProxySettings", () => {
  let previousLocale: ReturnType<typeof getLocale>;
  beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
  afterEach(() => { setLocale(previousLocale); });

  it("shows the mode, the trusted opt-in and the effective upstream line", async () => {
    render(<UpstreamProxySettings reader={async () => view()} writer={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("upstream-proxy-effective-routes").textContent).toBe("PROXY proxy.test:8080; DIRECT"));
    expect(screen.getByTestId("upstream-proxy-mode-system").getAttribute("data-state")).toBe("checked");
    expect(screen.getByTestId("upstream-proxy-effective").textContent).toContain("Effective upstream for https://example.com/");
    expect(screen.getByTestId("upstream-proxy-effective-source").textContent).toBe("From this computer's proxy settings.");
    expect(screen.getByTestId("upstream-proxy-effective").textContent).toContain("Passed over: SOCKS5 s:1080");
    expect(screen.getByTestId("upstream-proxy-settings").textContent).toContain("Upstream proxy resolves names (local proxy)");
    expect(screen.getByTestId("upstream-proxy-settings").textContent).toContain("cntlm or px");
    expect(screen.queryByTestId("upstream-proxy-manual")).toBeNull();
  });

  it("writes a mode change at once, and waits for a URL before switching to manual", async () => {
    const writer = vi.fn(async (patch: UpstreamProxyPatch) => ({
      ok: true,
      view: view({
        settings: { mode: patch.mode ?? "system", manualUrl: patch.manualUrl === undefined ? "" : "http://proxy.test:3128", bypass: patch.bypass ?? "", resolvesNames: false },
        hasCredentials: patch.manualUrl?.includes("@") === true,
        diagnostic: { url: "https://example.com/", source: patch.mode === "off" ? "off" : "manual", routes: [{ kind: "direct" }], skipped: [] },
      }),
    }));
    render(<UpstreamProxySettings reader={async () => view()} writer={writer} />);
    await screen.findByTestId("upstream-proxy-effective-routes");
    fireEvent.click(screen.getByTestId("upstream-proxy-mode-off"));
    await waitFor(() => expect(writer).toHaveBeenCalledWith({ mode: "off" }));
    fireEvent.click(screen.getByTestId("upstream-proxy-mode-manual"));
    expect(await screen.findByTestId("upstream-proxy-manual")).toBeTruthy();
    expect(writer).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId("upstream-proxy-url"), { target: { value: "http://me:pw@proxy.test:3128" } });
    fireEvent.change(screen.getByTestId("upstream-proxy-bypass"), { target: { value: ".lan" } });
    fireEvent.click(screen.getByTestId("upstream-proxy-save"));
    await waitFor(() => expect(writer).toHaveBeenLastCalledWith({ mode: "manual", manualUrl: "http://me:pw@proxy.test:3128", bypass: ".lan" }));
    // The stored URL comes back without credentials; only their presence is shown.
    await waitFor(() => expect((screen.getByTestId("upstream-proxy-url") as HTMLInputElement).value).toBe("http://proxy.test:3128"));
    expect(screen.getByTestId("upstream-proxy-credentials").textContent).toContain("A user name and password are stored");
    expect(screen.getByTestId("upstream-proxy-notice").textContent).toBe("Saved. New connections use it now.");
    fireEvent.click(screen.getByTestId("upstream-proxy-clear-credentials"));
    await waitFor(() => expect(writer).toHaveBeenLastCalledWith({ clearCredentials: true }));
  });

  it("toggles the resolves-names opt-in, and shows a refusal from main", async () => {
    const writer = vi.fn(async () => ({ ok: false, error: "invalid-upstream-proxy-url", message: "x" }));
    render(<UpstreamProxySettings reader={async () => view()} writer={writer} />);
    await screen.findByTestId("upstream-proxy-effective-routes");
    fireEvent.click(screen.getByTestId("upstream-proxy-resolves-names"));
    await waitFor(() => expect(writer).toHaveBeenCalledWith({ resolvesNames: true }));
    expect((await screen.findByTestId("upstream-proxy-error")).textContent)
      .toBe("Could not change the upstream proxy: Enter the upstream proxy as http://host:port or https://host:port.");
  });

  it("shows why connections would be refused", async () => {
    render(<UpstreamProxySettings
      reader={async () => view({ diagnostic: { url: "https://example.com/", source: "environment", envVar: "ALL_PROXY", routes: [], skipped: [], refusal: "the proxy in ALL_PROXY is a SOCKS proxy" } })}
      writer={vi.fn()}
    />);
    expect((await screen.findByTestId("upstream-proxy-effective-refusal")).textContent)
      .toBe("Connections would be refused: the proxy in ALL_PROXY is a SOCKS proxy");
    expect(screen.getByTestId("upstream-proxy-effective-source").textContent).toBe("From the environment variable ALL_PROXY.");
  });
});
