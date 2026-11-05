import type { PluginCardSummary } from "../types.js";
import type { PluginProtocolUpdatePath } from "./plugin-doctor-match.js";

/** The host protocol this build serves; a test pins it to `HOST_PROTOCOL_VERSIONS_SERVED`, which the renderer cannot import. */
export const MIGRATION_TARGET_HOST_PROTOCOL = "5";

/** The chat draft Doctor prepares for an extension this build refuses for its host protocol: the model migrates a copy of
 * its source, and the user reinstalls it through the reviewed folder install. */
export function buildHostProtocolMigrationPrompt(
  plugin: Pick<PluginCardSummary, "id" | "name" | "version">,
  source: PluginProtocolUpdatePath | null,
): string {
  const target = MIGRATION_TARGET_HOST_PROTOCOL;
  const label = `"${plugin.name}" (${plugin.id}${plugin.version ? `, v${plugin.version}` : ""})`;
  const where = source?.kind === "repository"
    ? `Its source is ${source.url} (${source.sourceLabel}). Clone or copy it into a new folder in this workspace and work there.`
    : "Ask me where its source repository or folder is, then copy it into a new folder in this workspace and work there.";
  return [
    `Migrate the Ave extension ${label} to host protocol ${target}, the only protocol this Ave build runs.`,
    "",
    `${where} Do not edit the installed copy inside Ave's data folder.`,
    "",
    `Protocol ${target} needs:`,
    `1. In plugin.json, set extensions["ai.agent-connector.ave"].requires.hostProtocol to "${target}". Keep the declared minAppVersion; do not raise it to guess a release.`,
    "2. Loopback OAuth: api.authRedirect.open() returns { handle, redirectUri, state }. Send that state unchanged as the authorization request's state, with a fresh PKCE S256 challenge, and never mint your own. Call api.authRedirect.wait({ handle }), handle callback.error before exchanging the code, and close the handle in finally. No code change is needed when the extension does not use authRedirect.",
    "3. Delegated workers: every api.spawnWorker call declares control \"output-only-v1\" (stdout read with onStdout) or \"stdio-control-v1\" (newline-delimited JSON-RPC on stdout, logs on stderr). There is no socket, port or udsArgName. No change is needed when the extension starts no workers.",
    `4. If the extension vendors contract/ files, re-vendor public-contract.ts, plugin-manifest.schema.json, plugin-host-protocol/${target}/protocol.schema.json and worker-stdio-control/1/worker-control.schema.json from the Ave source that serves protocol ${target}, and update contract/sources.json.`,
    "5. Bump the extension version, build it, and run its tests.",
    "",
    "When it is done, tell me the folder path. I will install it from Settings → Extensions → Install from folder…, which shows its permissions for review first.",
  ].join("\n");
}
