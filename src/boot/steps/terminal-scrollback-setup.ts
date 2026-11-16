import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { setTerminalScrollbackStore } from "../../main/terminal/pty-manager.js";
import {
  savedTerminalTabIds, terminalScrollbackProfile, terminalScrollbackStore, unresolvedTerminalScrollbackProfile,
  type TerminalScrollbackProfile, type TerminalScrollbackStore,
} from "../../main/terminal/terminal-scrollback-store.js";
import { aveHome, isAveHomeConfigurationRefused } from "../../shared/ave-home.js";
import { errorMessage } from "../../shared/error-message.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

/**
 * Host terminal tabs come back after a restart with what they showed. Once per run, after settings load and before any window can save a layout, this
 * deletes the output kept for every tab the loaded layout does not bring back (closed while its window was not showing it, or by another run), whether
 * or not the run opens a terminal: that output can hold anything the user printed. The layout is the one the settings file held when settings loaded,
 * so a tab it brings back keeps its output even when its window saves a layout without the tab before the tab's view is mounted.
 *
 * It deletes only against a layout the file is known to hold. When the settings file is missing (a fresh install), could not be read or does not hold
 * settings, or holds a layout this build refused, the run started on defaults that say nothing of the tabs on disk: nothing is deleted, and the next
 * run whose layout is known sweeps. Nor is anything deleted in a run that refused the Ave home's configuration. The layout speaks only for its own
 * profile, so the sweep touches only that profile's files (terminal-scrollback-store.ts): another profile sharing the Ave home keeps its tabs. The
 * profile is the settings directory as the filesystem names it; when that directory cannot be resolved, its earlier files may be under another
 * name, so nothing is deleted and the user is told once, and the store keeps this run's tabs under the directory as given.
 *
 * The sweep is queued on the store before the store is installed, and the store runs what it is asked in order, so every read and save of the run
 * comes after it. A sweep that fails is logged and the user is told once; the store is installed all the same, so terminals start and come back with
 * what was kept. A tab whose output could not be kept comes back empty; the user hears so when it happens, not at the restart that shows it.
 */
export function setupTerminalScrollback(
  ctx: Pick<BootContext, "host" | "settingsService" | "notificationService">,
  openStore: (profile: TerminalScrollbackProfile) => TerminalScrollbackStore = (profile) => terminalScrollbackStore(profile),
): void {
  const notRemoved = (err: unknown): void => {
    log.warn({ err: errorMessage(err) }, "boot: kept output of closed terminal tabs not removed");
    if (ctx.host.desktop) {
      ctx.notificationService.fire({ kind: "system", title: t("ptyTerminal.closedOutputNotRemovedTitle"), body: t("ptyTerminal.closedOutputNotRemoved") });
    }
  };
  let profile: TerminalScrollbackProfile;
  try {
    profile = terminalScrollbackProfile(ctx.host.userDataPath);
  } catch (err) {
    notRemoved(new Error(`the settings directory could not be resolved, so kept terminal output is not swept this run: ${errorMessage(err)}`));
    setTerminalScrollbackStore(openStore(unresolvedTerminalScrollbackProfile(ctx.host.userDataPath)), notKept(ctx));
    return;
  }
  const store = openStore(profile);
  try {
    const loaded = ctx.settingsService.loadedMainLayout();
    if (isAveHomeConfigurationRefused(aveHome())) {
      log.warn("boot: the Ave home's configuration was refused; kept terminal output is not swept this run");
    } else if (loaded.kind === "read") {
      store.keepOnly(savedTerminalTabIds(loaded.layout)).catch(notRemoved);
    } else if (loaded.reason === "no-file") {
      log.info("boot: no settings file to read a saved layout from; kept terminal output is not swept this run");
    } else {
      log.warn({ reason: loaded.reason }, "boot: the saved layout is not known; kept terminal output is not swept this run");
    }
  } catch (err) {
    // The layout could not be read: nothing is removed this run, and nothing it would have kept is lost.
    notRemoved(err);
  }
  setTerminalScrollbackStore(store, notKept(ctx));
}

function notKept(ctx: Pick<BootContext, "notificationService">): () => void {
  return () => {
    ctx.notificationService.fire({ kind: "system", title: t("ptyTerminal.outputNotSavedTitle"), body: t("ptyTerminal.outputNotSaved") });
  };
}
