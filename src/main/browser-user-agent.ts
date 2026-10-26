import { app, type Session } from "electron";

// Browser surfaces identify both the rendering engine and the application.
export function buildPersistentBrowserUserAgent(input?: {
  chromiumVersion?: string;
  platform?: NodeJS.Platform;
}): string {
  const chromium = input?.chromiumVersion ?? process.versions.chrome ?? "136.0.0.0";
  const major = chromium.split(".")[0] || "136";
  const platform = input?.platform ?? process.platform;
  const platformToken =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36 Ave/${app.getVersion()}`
  );
}

/** Set the user agent before creating guests; engine client hints remain untouched. */
export function applyBrowserSessionIdentity(browserSession: Session): void {
  browserSession.setUserAgent(buildPersistentBrowserUserAgent());
}
