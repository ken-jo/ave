import "../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { DEFAULT_APPEARANCE } from "../../../shared/appearance-settings.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { ensureInstalledContent, fontFaceCss, resetInstalledContentForTests } from "../installed-content.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { isLocale, setLocale } from "../../../i18n/index.js";
import type { InstalledContentApi, InstalledContentView } from "../../../shared/installed-content.js";

configure({ asyncUtilTimeout: 5000 });

const view = (patch: Partial<InstalledContentView> = {}): InstalledContentView => ({ fonts: [], routineTemplates: [], broken: [], ...patch });

function bridge(content: InstalledContentView): InstalledContentApi {
  return {
    installed: vi.fn(async () => ({ ok: true as const, content })),
  };
}

beforeEach(() => {
  resetInstalledContentForTests();
});

afterEach(() => {
  cleanup();
  resetInstalledContentForTests();
  setLocale("en");
  const root = document.documentElement;
  root.removeAttribute("data-theme-bundle");
  root.removeAttribute("data-shell");
  root.style.cssText = "";
  delete (window as unknown as Record<string, unknown>).aveApi;
});

describe("marketplace changes", () => {
  it("reads the installed content again when the marketplace catalog changes", async () => {
    const api = bridge(view());
    let changed: () => void = () => undefined;
    const off = vi.fn();
    await ensureInstalledContent({ installedContent: api, gitMarketplace: { onCatalogChanged: (listener) => ((changed = listener), off) } });
    expect(isLocale("fr")).toBe(false);

    vi.mocked(api.installed).mockResolvedValue({ ok: true, content: view({ broken: [{ kind: "skill", name: "review", problem: "changed bytes" }] }) });
    changed();
    await waitFor(() => expect(api.installed).toHaveBeenCalledTimes(2));
    expect(isLocale("fr")).toBe(false);

    resetInstalledContentForTests();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("reloads installed templates when extension contributions change", async () => {
    const api = bridge(view());
    let changed: () => void = () => undefined;
    const off = vi.fn();
    await ensureInstalledContent({ installedContent: api, onPersonaPromptsUpdated: (listener) => ((changed = listener), off) });
    vi.mocked(api.installed).mockResolvedValue({ ok: true, content: view({ routineTemplates: [{
      id: "daily", title: "Daily review", description: "Review", trigger: "shutdown",
      execution: "notification-only", notificationTitle: "Review", packageName: "sampleportal",
      version: "1.0.0", sourceKind: "extension",
    }] }) });
    changed();
    await waitFor(() => expect(api.installed).toHaveBeenCalledTimes(2));
    resetInstalledContentForTests();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("installed fonts", () => {
  it("declares @font-face rules only for ave-content font URLs", () => {
    const css = fontFaceCss([
      {
        name: "harbor-sans",
        family: "Harbor Sans",
        stack: "\"ave-font-harbor-sans\", system-ui",
        faces: [
          { url: "ave-content://t0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2", format: "woff2", weight: "100 900", style: "normal" },
          { url: "https://evil.example/x.woff2", format: "woff2", weight: "400", style: "normal" },
        ],
        sourceId: "acme",
        version: "1.0.0",
      },
    ]);
    expect(css).toBe(
      '@font-face { font-family: "ave-font-harbor-sans"; src: url("ave-content://t0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }',
    );
  });
});

describe("appearance pickers list installed items", () => {
  it("lists installed fonts alongside compiled language options", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE } } });
    api.installedContent = bridge(view({
      fonts: [{ name: "harbor-sans", family: "Harbor Sans", stack: "\"ave-font-harbor-sans\", system-ui", faces: [], sourceId: "acme", version: "1.0.0" }],
    })) as never;
    (window as unknown as { aveApi: unknown }).aveApi = api;
    const { queryByTestId, getByText } = render(
      <ThemeProvider api={api as never}><AppearanceTab /></ThemeProvider>,
    );
    await act(async () => {
      await ensureInstalledContent(api as never);
    });
    expect(queryByTestId("language-option-fr")).toBeNull();
    expect(getByText("Harbor Sans")).toBeTruthy();
  });
});
