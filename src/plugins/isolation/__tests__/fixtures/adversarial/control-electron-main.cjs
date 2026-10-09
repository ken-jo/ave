// The positive control for escape 3 (plugin-hostapi-protocol.md §9.8, table
// row 3): a FULL Electron main process — the same binary the plugin child runs,
// started with `ELECTRON_RUN_AS_NODE` removed from its environment — reports
// what `escape_electron` would have reached had it been one. The test process
// cannot be this control: it runs under `ELECTRON_RUN_AS_NODE=1` itself and sees
// the same path-string export the child sees.
//
// The caller passes `--user-data-dir=<a temporary directory>`, so Electron keeps
// nothing under the user's profile, and reads one JSON line from stdout.
const { app, BrowserWindow, ipcMain, session } = require("electron");

app.disableHardwareAcceleration();
if (process.platform === "darwin" && app.dock) app.dock.hide();

app.whenReady().then(
  () => {
    process.stdout.write(
      `${JSON.stringify({
        BrowserWindow: typeof BrowserWindow,
        defaultSession: typeof session.defaultSession,
        ipcMain: typeof ipcMain,
      })}\n`,
    );
    app.exit(0);
  },
  (error) => {
    process.stderr.write(`control-electron-main: ${String(error)}\n`);
    app.exit(1);
  },
);
