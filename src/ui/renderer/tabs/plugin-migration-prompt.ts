import type { PluginCardSummary } from "../types.js";
import type { PluginProtocolUpdatePath } from "./plugin-doctor-match.js";

/** The chat draft Doctor prepares for a protocol-3 extension: the model migrates a copy of its source, and the user
 * reinstalls it through the reviewed folder install. */
export function buildProtocol4MigrationPrompt(
  plugin: Pick<PluginCardSummary, "id" | "name" | "version">,
  source: PluginProtocolUpdatePath | null,
): string {
  const label = `"${plugin.name}" (${plugin.id}${plugin.version ? `, v${plugin.version}` : ""})`;
  const where = source?.kind === "repository"
    ? `Its source is ${source.url} (${source.sourceLabel}). Clone or copy it into a new folder in this workspace and work there.`
    : "Ask me where its source repository or folder is, then copy it into a new folder in this workspace and work there.";
  return [
    `Migrate the Ave extension ${label} from host protocol 3 to host protocol 4.`,
    "",
    `${where} Do not edit the installed copy inside Ave's data folder.`,
    "",
    "Protocol 4 needs:",
    "1. In plugin.json, set extensions[\"ai.agent-connector.ave\"].requires to { \"hostProtocol\": \"4\", \"minAppVersion\": \"0.15.0\" }; keep a higher minAppVersion if one is declared.",
    "2. Loopback OAuth: api.authRedirect.open() returns { handle, redirectUri, state }. Send that state unchanged as the authorization request's state, with a fresh PKCE S256 challenge, and never mint your own. Call api.authRedirect.wait({ handle }), handle callback.error before exchanging the code, and close the handle in finally. No code change is needed when the extension does not use authRedirect.",
    "3. If the extension vendors contract/ files, re-vendor public-contract.ts, plugin-manifest.schema.json and plugin-host-protocol/4/protocol.schema.json from the Ave release that serves protocol 4, and update contract/sources.json.",
    "4. Bump the extension version, build it, and run its tests.",
    "",
    "When it is done, tell me the folder path. I will install it from Settings → Extensions → Install from folder…, which shows its permissions for review first.",
  ].join("\n");
}
