/**
 * Build an Edge-flavoured UA string aligned with the current Chromium major.
 *
 * Microsoft AAD's KMSI ("Stay signed in?") gating treats UAs containing
 * `Electron/...` as embedded browsers and refuses to issue the persistent
 * `ESTSAUTHPERSISTENT` cookie — which is why even after a successful login,
 * reopening webmail.example.com asks the user to sign in again. Mimicking Edge
 * (the `Edg/<major>` token) puts us back on the supported-browser path.
 *
 * Shared by the two remote-browsing sessions: the external-link viewer
 * (`link-window-service.ts`) and the in-app side browser
 * (`side-browser-webview.ts`), where Google sign-in rejects the same
 * embedded-browser UA.
 */
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
    `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
  );
}
