import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";
import { primeHostMarketplaceApi } from "./ui/renderer/host-marketplace-api.js";
import { I18nSettingsProvider } from "./ui/renderer/context/I18nSettingsProvider.js";
import { getApi } from "./ui/renderer/api-client.js";
import { installRendererModelCatalog, renderModelCatalogUnavailable } from "./ui/renderer/model-catalog-bootstrap.js";

export { App } from "./ui/renderer/App.js";

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  primeHostMarketplaceApi();
  const root = document.getElementById("root");
  if (root) {
    // Mount only once the catalog is in: the first settings snapshot resolves
    // the context window against it (model-catalog-bootstrap.ts).
    void installRendererModelCatalog(getApi()).then(() => {
      createRoot(root).render(
        <I18nSettingsProvider>
          <App />
        </I18nSettingsProvider>,
      );
    }, (error: unknown) => {
      // Main logged the refusal it answered; the window says why it is empty.
      return renderModelCatalogUnavailable(root, error, getApi());
    });
  }
}
