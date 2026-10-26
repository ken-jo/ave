// Remote pages and their popups never receive host privileges or nested guests.
export function hardenRemoteWebPreferences(prefs: Record<string, unknown>): void {
  delete prefs.preload;
  delete prefs.preloadURL;
  delete prefs.additionalArguments;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.webSecurity = true;
  prefs.sandbox = true;
  prefs.javascript = true;
  prefs.webviewTag = false;
}
