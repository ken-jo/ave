/** Only host-renderer permission channels may change upstream routing; generic settings updates reject it and snapshots omit it. */

/** `off`: always direct. `system`: environment variables, else the OS settings. `manual`: {@link UpstreamProxySettings.manualUrl}. */
export type UpstreamProxyMode = "off" | "system" | "manual";

export const UPSTREAM_PROXY_MODES: readonly UpstreamProxyMode[] = ["off", "system", "manual"];

export interface UpstreamProxySettings {
  mode: UpstreamProxyMode;
  /** Persist manual proxy URLs without credentials; move supplied credentials to the secret store. */
  manualUrl: string;
  /** Manual mode: hosts that skip the proxy, in NO_PROXY form (`.example.com, 10.0.0.0/8`). */
  bypass: string;
  /** Forward unresolved names only with explicit upstream trust; they remain unverified and conversation-scoped. */
  resolvesNames: boolean;
}

export const DEFAULT_UPSTREAM_PROXY: UpstreamProxySettings = {
  mode: "system",
  manualUrl: "",
  bypass: "",
  resolvesNames: false,
};

export const UPSTREAM_PROXY_CREDENTIALS_SECRET = "upstreamProxy.manualCredentials";

/** Diagnostics expose routes and credential presence, never credential values. */
export interface UpstreamProxyRouteView {
  kind: "direct" | "http" | "https";
  /** `host:port` of the proxy; absent for direct. */
  endpoint?: string;
  credentials?: boolean;
}

export type UpstreamProxySource =
  | "off"
  | "manual"
  | "manual-bypass"
  | "environment"
  | "environment-bypass"
  | "system"
  | "system-unavailable";

export interface UpstreamProxyDiagnostic {
  url: string;
  source: UpstreamProxySource;
  /** The environment variable that decided it (`source: "environment"`), by name only. */
  envVar?: string;
  routes: UpstreamProxyRouteView[];
  /** Entries passed over (a SOCKS proxy, a malformed entry), credentials removed. */
  skipped: string[];
  refusal?: string;
}

export interface UpstreamProxyView {
  settings: UpstreamProxySettings;
  hasCredentials: boolean;
  diagnostic: UpstreamProxyDiagnostic;
}

export interface UpstreamProxyPatch {
  mode?: UpstreamProxyMode;
  /** May carry `user:pass@`; the credentials are moved to the secret store. */
  manualUrl?: string;
  bypass?: string;
  resolvesNames?: boolean;
  clearCredentials?: boolean;
}
