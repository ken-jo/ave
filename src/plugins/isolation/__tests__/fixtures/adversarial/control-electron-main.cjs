// The positive control for escape 3 (plugin-hostapi-protocol.md §9.8, table
// row 3): a FULL Electron main process — the same binary the plugin child runs,
// started with `ELECTRON_RUN_AS_NODE` removed from its environment — runs the
// SAME detector `escape_electron` runs, `probeElectron()` from `entry.mjs`, and
// reports what it found. Row 3's "no usable main-process API" is worth
// something only if that detector says "usable-api" here, where the API is
// real. The test process cannot be this control: it runs under
// `ELECTRON_RUN_AS_NODE=1` itself and sees the same path-string export the
// child sees.
//
// The caller passes `--user-data-dir=<a temporary directory>` and, on macOS,
// `--use-mock-keychain`, so Electron keeps nothing under the user's profile and
// never opens the login Keychain; it reads one JSON line from stdout.
//
// The line is written synchronously, and everything the detector created — a
// hidden `BrowserWindow` per form that constructed one, and its `ipcMain`
// handler — is torn down before `app.exit`, so exit starts from an empty window
// list instead of closing windows whose renderers may still be launching.
const { writeSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, session } = require("electron");

app.disableHardwareAcceleration();
if (process.platform === "darwin" && app.dock) app.dock.hide();

app
  .whenReady()
  .then(async () => {
    const { probeElectron } = await import(pathToFileURL(join(__dirname, "entry.mjs")).href);
    const detector = await probeElectron(pathToFileURL(__filename).href);
    writeSync(
      1,
      `${JSON.stringify({
        BrowserWindow: typeof BrowserWindow,
        defaultSession: typeof session.defaultSession,
        ipcMain: typeof ipcMain,
        detector: { outcome: detector.outcome, usable: detector.usable },
      })}\n`,
    );
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    ipcMain.removeHandler("adversarial");
    app.exit(0);
  })
  .catch((error) => {
    writeSync(2, `control-electron-main: ${String(error?.stack ?? error)}\n`);
    app.exit(1);
  });
