/**
 * `ave://` deep-link handling — the runtime side of the protocol.
 *
 * Parsing lives in `ave-protocol.ts` (pure, unit-tested); this module owns the
 * side-effecting handlers those parsers route to: the git marketplace's links,
 * which only open the confirming UI (design §16.2), and the plugin OAuth
 * callback re-emit. Deep links may arrive before `services` is ready (cold
 * start / second-instance), so unresolved URIs are queued via
 * `setPendingAveUri` and drained by `main()` after boot.
 */
import { app } from "electron";
import { createLogger } from "../lib/logger.js";
import { sendToWindow } from "../ipc/safe-send.js";
import { emitEvent as emitHostEvent } from "../boot/types.js";
import { CHANNELS } from "../contract/app-contract.js";
import { parseGitMarketplaceUri, parsePluginAuthUri } from "./ave-protocol.js";
import { getMainWindow, getServices, setPendingGitMarketplaceLink, setPendingAveUri } from "./app-state.js";
import { activateInlineSettings } from "./app-menu.js";

const log = createLogger("ave");

/**
 * Dev-only diagnostics for the `ave://` path. The `app.isPackaged` boundary
 * alone is the right level for log-only output (no trust decisions ride on
 * these calls).
 */
export const aveDevLog = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.info(obj, msg);
  else log.info(msg);
};
const aveDevWarn = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.warn(obj, msg);
  else log.warn(msg);
};

export async function handleAveUri(url: string) {
  aveDevLog("[ave] handleAveUri called", { url });

  // Route generic plugin OAuth callback (`ave://plugin-auth/<pluginId>?code=<code>`)
  // to a host event so the matching plugin can exchange the code.
  // Validation lives in parsePluginAuthUri — bad URIs silently drop
  // (DoS / probing defense). Plain-text `code` MUST NOT be logged.
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

  // The server-era forms (`ave://install/<slug>`, `ave://mcp-login/<slug>`) named a catalog
  // that no longer exists; they are refused like any other unknown link.
  aveDevWarn("[ave] handleAveUri: unrecognized ave:// link ignored", { url });
}
