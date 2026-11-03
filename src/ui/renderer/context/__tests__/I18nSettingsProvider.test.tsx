// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { useTranslation } from "../../../../i18n/react.js";
import type { Locale } from "../../../../i18n/locale.js";
import { __resetLazyLocaleMessagesForTest, __setLocaleLoaderForTest } from "../../../../i18n/messages/index.js";
import { I18nSettingsProvider, resolveBootLocale } from "../I18nSettingsProvider.js";

function installApi(initialLanguage: Locale = "en") {
  const settingsUpdatedHandlers: Array<(settings: { appearance?: { language?: Locale } }) => void> = [];
  const api = {
    getSettings: vi.fn(async () => ({ appearance: { language: initialLanguage } })),
    updateSettings: vi.fn(async () => ({})),
    onSettingsUpdated: vi.fn((handler: (settings: { appearance?: { language?: Locale } }) => void) => {
      settingsUpdatedHandlers.push(handler);
      return () => undefined;
    }),
  };
  (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
  return { api, settingsUpdatedHandlers };
}

function LocaleProbe() {
  const { locale, setLocale, t } = useTranslation();
  return (
    <div>
      <span data-testid="active-locale">{locale}</span>
      <span data-testid="language-title">{t("settings.appearance.language.title")}</span>
      <button type="button" onClick={() => setLocale("ko")}>ko</button>
    </div>
  );
}

function renderLocaleProbe() {
  return render(<I18nSettingsProvider><LocaleProbe /></I18nSettingsProvider>);
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { aveApi?: unknown }).aveApi;
});

describe("I18nSettingsProvider boot locale", () => {
  it("renders a saved Korean setting on the very first render, before any hydration effect runs", async () => {
    __resetLazyLocaleMessagesForTest();
    const { api } = installApi("ko");

    const initialLocale = await resolveBootLocale(api as never);
    render(<I18nSettingsProvider initialLocale={initialLocale}><LocaleProbe /></I18nSettingsProvider>);

    // Synchronous: the first commit already carries the saved language (no waitFor).
    expect(screen.getByTestId("active-locale")).toHaveTextContent("ko");
    expect(screen.getByTestId("language-title")).toHaveTextContent("언어");
  });

  it("boots in English when the saved language's catalog cannot load", async () => {
    const restore = __setLocaleLoaderForTest("ko", () => Promise.reject(new Error("missing chunk")));
    try {
      await expect(resolveBootLocale({ getSettings: async () => ({ appearance: { language: "ko" } }) as never })).resolves.toBe("en");
    } finally {
      restore();
    }
  });

  it("mounts the renderer entry with the saved language as the provider's initial locale", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const api = { getSettings: vi.fn(async () => ({ appearance: { language: "ko" } })) };
    const render = vi.fn();
    vi.resetModules();
    vi.doMock("../../api-client.js", () => ({ getApi: () => api }));
    vi.doMock("../../host-marketplace-api.js", () => ({ primeHostMarketplaceApi: vi.fn() }));
    vi.doMock("../../App.js", () => ({ App: () => null }));
    vi.doMock("../../model-catalog-bootstrap.js", () => ({
      installRendererModelCatalog: vi.fn(async () => undefined),
      renderModelCatalogUnavailable: vi.fn(),
    }));
    vi.doMock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
    try {
      await import("../../../../renderer.js");
      await waitFor(() => expect(render).toHaveBeenCalledOnce());
      const element = render.mock.calls[0]![0] as { props: { initialLocale?: string } };
      expect(element.props.initialLocale).toBe("ko");
    } finally {
      root.remove();
      vi.doUnmock("../../api-client.js");
      vi.doUnmock("../../host-marketplace-api.js");
      vi.doUnmock("../../App.js");
      vi.doUnmock("../../model-catalog-bootstrap.js");
      vi.doUnmock("react-dom/client");
    }
  });

  it("boots in English for an English setting", async () => {
    await expect(resolveBootLocale({ getSettings: async () => ({ appearance: { language: "en" } }) as never })).resolves.toBe("en");
  });
});

describe("I18nSettingsProvider lazy locale loading", () => {
  it("hydrates a persisted lazy locale before switching the rendered catalog", async () => {
    installApi("ko");

    renderLocaleProbe();

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ko");
      expect(screen.getByTestId("language-title")).toHaveTextContent("언어");
    });
  });

  it("loads the selected locale catalog before applying a user language switch", async () => {
    const { api } = installApi("en");

    renderLocaleProbe();

    expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

    fireEvent.click(screen.getByText("ko"));

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ko");
      expect(screen.getByTestId("language-title")).toHaveTextContent("언어");
    });
    expect(api.updateSettings).toHaveBeenCalledWith({
      appearance: { schemaVersion: 2, language: "ko" },
    });
  });

  it("loads a lazy locale received from cross-window settings sync", async () => {
    const { settingsUpdatedHandlers } = installApi("en");

    renderLocaleProbe();

    expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

    settingsUpdatedHandlers[0]?.({ appearance: { language: "ko" } });

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ko");
      expect(screen.getByTestId("language-title")).toHaveTextContent("언어");
    });
  });

  it("keeps the current rendered locale when a selected lazy catalog fails to load", async () => {
    const { api } = installApi("en");
    const restore = __setLocaleLoaderForTest("ko", () => Promise.reject(new Error("missing chunk")));

    try {
      renderLocaleProbe();

      expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

      fireEvent.click(screen.getByText("ko"));

      await waitFor(() => {
        expect(api.updateSettings).toHaveBeenCalledWith({
          appearance: { schemaVersion: 2, language: "ko" },
        });
      });
      expect(screen.getByTestId("active-locale")).toHaveTextContent("en");
      expect(screen.getByTestId("language-title")).toHaveTextContent("Language");
    } finally {
      restore();
    }
  });
});
