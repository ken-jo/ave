/** Validate parsed protocols and credentials through the shared authority at every navigation boundary; substring checks
 * are insufficient. */
import { DEFAULT_ADDRESS_SEARCH_ENGINE, isAddressSearchEngine, resolveAddressBarInput, type AddressBarTarget } from "../../../shared/browser-address.js";
import type { AveApi } from "../types.js";

export { normalizeBrowserNavigationUrl } from "../../../shared/browser-address.js";

/** What submitted address-row text opens, read against the search engine configured at the moment of submission. */
export async function resolveAddressSubmission(api: Pick<AveApi, "getSettings">, text: string): Promise<AddressBarTarget | null> {
  const engine = (await api.getSettings()).webView?.addressSearchEngine;
  return resolveAddressBarInput(text, isAddressSearchEngine(engine) ? engine : DEFAULT_ADDRESS_SEARCH_ENGINE);
}
