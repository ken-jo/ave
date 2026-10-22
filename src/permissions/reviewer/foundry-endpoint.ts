/**
 * Azure AI Foundry endpoint validation for the chat `azure-foundry` vendor's
 * `baseUrl` setting. The settings IPC rejects an endpoint that fails here
 * before it is saved, so a chat request never leaves for an untrusted host.
 */
import { TRUSTED_NETWORK_HOST_SUFFIXES } from "./risk-classifier.js";

/**
 * Validate that the Foundry endpoint is HTTPS, ends with one of the approved
 * Azure suffixes, and has a well-formed subdomain (LOW: tightened check).
 * Throws on invalid input so the caller fails closed (atomic cutover).
 *
 * Subdomain takeover analysis: both accepted suffixes are managed by the
 * Azure control plane. A dangling CNAME attack requires an attacker to claim
 * the exact Azure resource, which requires the user's subscription credentials.
 *
 * LOW: subdomain regex rejects double-dot, percent-encoded dots, and other
 * malformed label sequences that pass the suffix-only check.
 */
export function validateFoundryEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `Azure AI Foundry endpoint is not a valid URL: ${endpoint}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `Azure AI Foundry endpoint must use HTTPS (got ${url.protocol}): ${endpoint}`,
    );
  }
  const matchedSuffix = TRUSTED_NETWORK_HOST_SUFFIXES.find((s) => url.hostname.endsWith(s));
  if (!matchedSuffix) {
    throw new Error(
      `Azure AI Foundry endpoint hostname must end with ` +
      `.services.ai.azure.com or .openai.azure.com ` +
      `(got ${url.hostname}). Provide the full Foundry project endpoint, ` +
      `e.g. https://<project>.services.ai.azure.com`,
    );
  }
  // LOW: validate the subdomain portion (everything before the matched suffix).
  // Rejects: bare suffix (no subdomain), double-dot sequences, invalid label chars.
  const subdomain = url.hostname.slice(0, url.hostname.length - matchedSuffix.length);
  if (
    subdomain.length === 0 ||
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(subdomain)
  ) {
    throw new Error(
      `Azure AI Foundry endpoint: invalid subdomain '${subdomain}' in endpoint '${endpoint}'. ` +
      `Subdomain must consist of valid DNS labels (alphanumeric + hyphens, no leading/trailing hyphens).`,
    );
  }
}
