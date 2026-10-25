// Queue deep links until services are ready; marketplace links open confirmation UI before any mutation.
import { app } from "electron";
import { createLogger } from "../lib/logger.js";
import { sendToWindow } from "../ipc/safe-send.js";
import { emitEvent as emitHostEvent } from "../boot/types.js";
import { CHANNELS } from "../contract/app-contract.js";
import { parseGitMarketplaceUri, parsePluginAuthUri } from "./ave-protocol.js";
import { getMainWindow, getMarketplaceLifetime, getServices, setPendingGitMarketplaceLink, setPendingAveUri } from "./app-state.js";
import { activateInlineSettings } from "./app-menu.js";

const log = createLogger("ave");

// Dev-only diagnostics for the `ave://` path. The `app.isPackaged` boundary alone is the right level for log-only output (no trust decisions ride on these calls).
export const aveDevLog = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.info(obj, msg);
  else log.info(msg);
};

export async function handleAveUri(url: string) {
  aveDevLog("[ave] handleAveUri called", { url });

  // Route generic plugin OAuth callback (`ave://plugin-auth/<pluginId>?code=<code>`) to a host event so the matching plugin can exchange the code.
  // Validation lives in parsePluginAuthUri — bad URIs silently drop (DoS / probing defense). Plain-text `code` MUST NOT be logged.
  const authParams = parsePluginAuthUri(url);
  if (authParams) {
    aveDevLog("[ave] handleAveUri: plugin auth callback received", {
      pluginId: authParams.pluginId,
      codeLength: authParams.code.length,
    });
    emitHostEvent("plugin.auth.code.received", {
      pluginId: authParams.pluginId,
      code: authParams.code,
    });
    return;
  }

  const gitLink = parseGitMarketplaceUri(url);
  if (gitLink) {
    // Once the app is shutting down a marketplace link is refused: nothing is held, opened or sent.
    if (getMarketplaceLifetime().signal.aborted) {
      log.info("[ave] handleAveUri: marketplace link ignored while the app shuts down");
      return;
    }
    if (!getServices()) {
      setPendingAveUri(url);
      return;
    }
    // The tab takes the link when it opens, or on this event when it is already open.
    setPendingGitMarketplaceLink(gitLink);
    activateInlineSettings("marketplace");
    sendToWindow(getMainWindow(), CHANNELS.gitMarketplace.deepLink, null, log);
    return;
  }

  // The server-era forms (`ave://install/<slug>`, `ave://mcp-login/<slug>`) named a catalog that no longer exists; they are refused like any other unknown
  // link. Logged in every build so a link that does nothing leaves a trace; the query can carry a secret, so it stays out of the log.
  log.warn({ link: url.split(/[?#]/, 1)[0] }, "[ave] handleAveUri: unrecognized ave:// link ignored");
}
