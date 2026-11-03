import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";
import { primeHostMarketplaceApi } from "./ui/renderer/host-marketplace-api.js";
import { I18nSettingsProvider, resolveBootLocale } from "./ui/renderer/context/I18nSettingsProvider.js";
import { getApi } from "./ui/renderer/api-client.js";
import { installRendererModelCatalog, renderBootFailure } from "./ui/renderer/model-catalog-bootstrap.js";

export { App } from "./ui/renderer/App.js";

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  primeHostMarketplaceApi();
  const root = document.getElementById("root");
  if (root) {
    const api = getApi();
    // Mount only once the catalog is in: the first settings snapshot resolves
    // the context window against it (model-catalog-bootstrap.ts). The saved
    // language resolves alongside, so the first paint is already localized.
    // Either step failing shows the boot-failure panel instead of a blank root.
    void Promise.all([installRendererModelCatalog(api), resolveBootLocale(api)]).then(([, initialLocale]) => {
      createRoot(root).render(
        <I18nSettingsProvider initialLocale={initialLocale}>
          <App />
        </I18nSettingsProvider>,
      );
    }, (error: unknown) => {
      // Main logged the refusal it answered; the window says why it is empty.
      return renderBootFailure(root, error, api);
    });
  }
}
