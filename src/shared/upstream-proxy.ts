/**
 * Where the sandbox egress proxy sends allowed connections next (owner
 * decision 2026-10-20: environment variables and the OS proxy settings,
 * PAC included, unless Settings names a proxy explicitly). Types and
 * defaults only, so the renderer can share them; the routing itself is
 * `src/permissions/upstream-proxy.ts`.
 *
 * Main-owned: `settings.update` refuses a patch naming `upstreamProxy`, and
 * the renderer snapshot leaves it out. The Settings page reads and writes it
 * through the permissions channels `upstreamProxyGet` / `upstreamProxySet`,
 * which take the host renderer only. Plugins, agents and sandboxed processes
 * have no path to it.
 */

/** `off`: always direct. `system`: environment variables, else the OS settings. `manual`: {@link UpstreamProxySettings.manualUrl}. */
export type UpstreamProxyMode = "off" | "system" | "manual";

export const UPSTREAM_PROXY_MODES: readonly UpstreamProxyMode[] = ["off", "system", "manual"];

export interface UpstreamProxySettings {
  mode: UpstreamProxyMode;
  /**
   * Manual mode: `http://host:port` or `https://host:port`. Stored without
   * credentials; a user name and password given with it live in the secret
   * store under {@link UPSTREAM_PROXY_CREDENTIALS_SECRET}.
   */
  manualUrl: string;
  /** Manual mode: hosts that skip the proxy, in NO_PROXY form (`.example.com, 10.0.0.0/8`). */
  bypass: string;
  /**
   * Trust an upstream proxy on this host (cntlm, px, …) to resolve names this
   * host cannot. Off, such a name is refused through it; on, it is forwarded
   * and treated as unverified (at most This conversation).
   */
  resolvesNames: boolean;
}

export const DEFAULT_UPSTREAM_PROXY: UpstreamProxySettings = {
  mode: "system",
  manualUrl: "",
  bypass: "",
  resolvesNames: false,
};

/** Secret-store key of the manual proxy's `{ username, password }` (JSON). */
export const UPSTREAM_PROXY_CREDENTIALS_SECRET = "upstreamProxy.manualCredentials";

/** One route of the effective upstream, as Settings shows it: never a credential, only whether one is sent. */
export interface UpstreamProxyRouteView {
  kind: "direct" | "http" | "https";
  /** `host:port` of the proxy; absent for direct. */
  endpoint?: string;
  /** A user name and password are sent to this proxy (Basic). */
  credentials?: boolean;
}

/** Where the routes for a destination came from. */
export type UpstreamProxySource =
  | "off"
  | "manual"
  | "manual-bypass"
  | "environment"
  | "environment-bypass"
  | "system"
  | "system-unavailable";

export interface UpstreamProxyDiagnostic {
  /** The URL the diagnostic resolved, e.g. `https://example.com/`. */
  url: string;
  source: UpstreamProxySource;
  /** The environment variable that decided it (`source: "environment"`), by name only. */
  envVar?: string;
  routes: UpstreamProxyRouteView[];
  /** Entries passed over (a SOCKS proxy, a malformed entry), credentials removed. */
  skipped: string[];
  /** Why the destination would be refused (no usable route), when it would be. */
  refusal?: string;
}

/** What `upstreamProxyGet` answers: the setting, whether credentials are stored, and the diagnostic. */
export interface UpstreamProxyView {
  settings: UpstreamProxySettings;
  /** The manual proxy has a stored user name and password (never the values). */
  hasCredentials: boolean;
  diagnostic: UpstreamProxyDiagnostic;
}

/** What `upstreamProxySet` takes from Settings. */
export interface UpstreamProxyPatch {
  mode?: UpstreamProxyMode;
  /** May carry `user:pass@`; the credentials are moved to the secret store. */
  manualUrl?: string;
  bypass?: string;
  resolvesNames?: boolean;
  /** Remove the stored manual credentials. */
  clearCredentials?: boolean;
}
