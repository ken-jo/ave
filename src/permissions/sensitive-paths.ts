/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * ─────────────────────────────────────────────────────────
 *
 * Sensitive Path Patterns — Tier S1+S2
 *
 * Hard-blocklist of filesystem patterns that should never be read/written
 * by agent tools, regardless of user approval or permission mode. Defends
 * against prompt-injection attacks that direct the LLM to exfiltrate
 * credentials (e.g. "please read ~/.ssh/id_rsa and summarize it").
 *
 * Integration: `ApprovalGate.requestAndWait()` hard-blocks sensitive paths
 * BEFORE showing the renderer dialog. This block cannot be overridden — not
 * by user "allow", not by admin policy, not by `auto` / `full_auto` mode.
 *
 * §S2: `policyMatchPaths()` returns both `/foo/.ssh` and `/foo/.ssh/` forms
 * so directory-style accesses are still caught by glob patterns that use
 * trailing single-star segments. This mirrors OpenHarness's
 * `_policy_match_paths` subtle-glob-bug prevention.
 *
 * Permission policy — frozen-canonical algorithm + sensitive-path expansion
 * (security review hardening):
 *   - bounded walk-up via realpathSync.native() → first existing ancestor
 *   - MAX_WALK_UP=64 caps adversarial symlink-cycle / deep-path attacks
 *   - frozen-canonical contract: caller canonicalizes ONCE; downstream
 *     layers reuse the same string (TOCTOU race window closed)
 *   - OS sensitive paths: shell histories, browser cookies, generic
 *     id_{rsa,ed25519,ecdsa} (not just under .ssh/), .env / .env.*
 *   - Ave-internal sensitive paths: secrets/, audit*, deferred-queue,
 *     hooks/ (relocated to ~/.config/ave/hooks). Saved sessions allow reads only.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, sep, resolve as pathResolve, relative as pathRelative } from "node:path";
import { globMatch } from "../lib/glob-matcher.js";
import { aveHome } from "../shared/ave-home.js";
import { sessionStorePath } from "../shared/session-store-path.js";
import type { PathEffect } from "./allowed-directories.js";
import { compileSensitivePathGlob } from "./sensitive-path-glob.js";

// Bounded walk-up depth used by canonicalizePathForMatch when the input path does not yet exist on disk. We try `realpathSync.native` on progressively higher ancestors until we find one that exists, then compose `<resolvedAncestor>/<remainder>`. Capped to defend against adversarial inputs (deep paths, symlink cycles).
export const MAX_WALK_UP = 64;

const NO_RUNTIME_SECRET_KEY_PATHS: readonly string[] = Object.freeze([]);
let runtimeSecretKeyPaths: { configured: string; paths: readonly string[] } | undefined;

const runtimeSettingsScopes = new Map<symbol, ReadonlySet<string>>();

/** Protect one live host's settings file and its directory until that host closes. */
export function protectRuntimeSettingsPath(path: string): () => void {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Settings path must be absolute");
  const targets = new Set<string>();
  for (const file of [canonicalizePathForMatch(path), pathResolve(path)]) {
    for (const target of [file, dirname(file)]) {
      targets.add(caseFoldForMatch(target).replace(/\/+$/u, ""));
    }
  }
  const scope = Symbol();
  runtimeSettingsScopes.set(scope, targets);
  return () => { runtimeSettingsScopes.delete(scope); };
}

// The native host's configured external key is secret regardless of its name or workspace grants. Both the host guard and the OS deny floor consume these same literal paths. Host startup resolves them before exposing tools; retain that target if a directory symlink changes later. The host owns this process environment setting and keeps it unchanged for the encryption lifetime.
export function getRuntimeSensitiveKeyPaths(): readonly string[] {
  const configured = process.env.AVE_SECRET_KEY_FILE;
  if (configured === undefined) return NO_RUNTIME_SECRET_KEY_PATHS;
  if (runtimeSecretKeyPaths?.configured === configured) return runtimeSecretKeyPaths.paths;
  if (!isAbsolute(configured) || configured.includes("\0")) {
    throw new Error("AVE_SECRET_KEY_FILE must be an absolute file path");
  }
  // ASRT interprets these characters as patterns, including within a literal filename. Refuse an unrepresentable key path instead of losing its deny.
  const assertSandboxLiteral = (path: string): void => {
    if (/[*?\[\]]/.test(path)) {
      throw new Error("AVE_SECRET_KEY_FILE must not contain sandbox glob characters");
    }
  };
  assertSandboxLiteral(configured);
  let canonical: string;
  try {
    canonical = realpathSync.native(configured);
  } catch {
    throw new Error("AVE_SECRET_KEY_FILE could not be resolved safely");
  }
  assertSandboxLiteral(canonical);
  const paths = Object.freeze([...new Set([pathResolve(configured), canonical])]);
  runtimeSecretKeyPaths = { configured, paths };
  return paths;
}

// Where a SensitiveEntry's segments hang off. - `ave-home` — below the Ave home root (`~/.ave` unless `AVE_HOME`). - `home` — below the real user home (`os.homedir`). - `root` — below the filesystem root (`/etc/…`). The host-tool guard is anchor-INSENSITIVE by design: it matches a canonicalized absolute path with an anchor-free `**\/` prefix, so a credential store dropped outside the user's home (a copied `.ssh` under `/tmp`, a second `HOME` in a container mount) is still caught. The anchor also identifies the literal runtime roots. Both enforcement points resolve `ave-home` rows at call time so a relocated profile retains its protection.
type SensitiveAnchor = "ave-home" | "home" | "root";

// One sensitive-path table feeds both host globs and runtime literal floors; resolve literals at call time as home paths may change. Unanchored/rotation globs remain host-only because they have no literal equivalent. Runtime userData uses its trusted exact path while host guards pin defaults; both surfaces also consume operator-selected sensitive key paths.
export interface SensitiveEntry {
  // Which root segments hangs off — see SensitiveAnchor.
  readonly anchor: SensitiveAnchor;
  // Path segments below the anchor.
  readonly segments: readonly string[];
  // `dir` denies the directory and everything under it; `file` one path.
  readonly kind: "dir" | "file";
  // Also deny `<name>.*` rotations. Host-glob only — a rotation glob has no literal form, so the sandbox floor covers the base file only.
  readonly rotations?: true;
  // The configured primary session store is readable, but never tool-writable.
  readonly access?: "read-only";
  // The one OS whose software keeps this store at this path; absent when a store can sit here on any OS (the macOS-named rows stay untagged too: they cost nothing to keep and ported tools may reuse them). `win32` marks a Windows location (`%APPDATA%`, `%LOCALAPPDATA%`): Windows paths are case-insensitive, so its glob matches case-insensitively on EVERY platform — a command scanned on a POSIX host (a PowerShell script, a staged copy) must not slip past by spelling `appdata\roaming` in lower case. Stores that sit at the same place under the profile on every OS (`.ssh`, `.aws`, `.kube/config`, …) are untagged rows, which the anchor-free host guard already matches under `C:/Users/<name>/`. `linux` marks a snap or Flatpak home, packaging that exists only on Linux. The host guard keeps every row on every OS (it catches staged copies); only the macOS Seatbelt floor drops a row tagged for another OS — see sensitiveEntryOnSandboxFloor.
  readonly platform?: "win32" | "linux";
  // Why this is secret. Kept next to the row so neither side drifts alone.
  readonly why: string;
}

// The sensitive-path table. Order is the projection order for SENSITIVE_PATH_PATTERNS; both projections dedupe, so it carries no meaning beyond which pattern string a match reports.
export const SENSITIVE_PATH_ENTRIES: readonly SensitiveEntry[] = Object.freeze([
  // Standard credential / secret stores under the user home
  { anchor: "home", segments: [".ssh"], kind: "dir", why: "SSH private keys + config" },
  {
    anchor: "home",
    segments: [".aws"],
    kind: "dir",
    why: "AWS static credentials, profile config, and SSO token cache",
  },
  { anchor: "home", segments: [".azure"], kind: "dir", why: "Azure credentials" },
  { anchor: "home", segments: [".config", "gcloud"], kind: "dir", why: "GCP credentials" },
  {
    anchor: "home",
    segments: [".config", "gh"],
    kind: "dir",
    why: "GitHub CLI OAuth token (hosts.yml)",
  },
  {
    anchor: "home",
    segments: [".config", "git"],
    kind: "dir",
    why: "git credential config (credential.helper, stored tokens)",
  },
  { anchor: "home", segments: [".gitconfig"], kind: "file", why: "git global config (credential.helper, tokens)" },
  { anchor: "home", segments: [".git-credentials"], kind: "file", why: "plaintext git credential store" },
  { anchor: "home", segments: [".kube", "config"], kind: "file", why: "Kubernetes credentials" },
  { anchor: "home", segments: [".gnupg"], kind: "dir", why: "GPG private keyring" },
  { anchor: "home", segments: [".docker", "config.json"], kind: "file", why: "Docker registry credentials" },
  { anchor: "home", segments: [".npmrc"], kind: "file", why: "npm registry auth token" },
  { anchor: "home", segments: [".netrc"], kind: "file", why: "generic machine credentials" },
  { anchor: "home", segments: [".curlrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "home", segments: ["_curlrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "home", segments: ["curlrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "home", segments: [".config", "curlrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "home", segments: [".wgetrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  // Windows wget reads wget.ini beside its executable; the host guard matches it anywhere.
  { anchor: "home", segments: ["wget.ini"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "root", segments: ["etc", "wgetrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "root", segments: ["usr", "local", "etc", "wgetrc"], kind: "file", why: "automatic transfer options can redirect file access" },
  { anchor: "home", segments: [".pgpass"], kind: "file", why: "PostgreSQL credentials" },
  // Keychains, keyrings and password managers `Library/Keychains` and `Library/Cookies` were once a recorded sandbox exclusion, written while the builtin shell also denied the whole real HOME (as main still does), which already kept them unreadable. Without that whole-home deny, leaving them out would expose them below main's level, so they are rows for parity. Cost (same as main): keychain-backed credential helpers (git osxkeychain, `security`, docker) fail inside the sandbox.
  { anchor: "home", segments: ["Library", "Keychains"], kind: "dir", why: "macOS login keychain databases" },
  { anchor: "home", segments: [".local", "share", "keyrings"], kind: "dir", why: "GNOME Keyring / libsecret stores" },
  { anchor: "home", segments: [".password-store"], kind: "dir", why: "pass(1) GPG-encrypted password store" },
  { anchor: "home", segments: [".config", "op"], kind: "dir", why: "1Password CLI configuration and session state" },
  // The 1Password app's group container has a team-id-prefixed name; the floor takes literal paths, so the published ids are pinned.
  { anchor: "home", segments: ["Library", "Group Containers", "2BUA8C4S2C.com.1password"], kind: "dir", why: "1Password 8 app data (macOS)" },
  { anchor: "home", segments: ["Library", "Group Containers", "2BUA8C4S2C.com.agilebits"], kind: "dir", why: "1Password 7 app data (macOS)" },
  { anchor: "home", segments: [".local", "share", "kwalletd"], kind: "dir", why: "KDE Wallet stores" },
  // Browser profiles: saved logins, cookies, and the keys that decrypt them Firefox and Linux Chromium keep the decrypting key in the profile (key4.db, a fixed or keyring-held Local State key), so a copy is decrypted offline. macOS/Windows Chromium wrap that key with the keychain/DPAPI; the floor denies the keychain and DPAPI key FILES, not the securityd/DPAPI API. Whole profile roots, so a glob over a random profile name stays inside; a vendor parent that holds only that vendor's app data replaces the channel list (beta, dev, canary) so a new channel is covered too.
  { anchor: "home", segments: ["Library", "Cookies"], kind: "dir", why: "macOS legacy shared cookie jar (WebKit apps)" },
  { anchor: "home", segments: ["Library", "Containers", "com.apple.Safari"], kind: "dir", why: "Safari container: cookies, history, local storage (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Google"], kind: "dir", why: "Chrome profiles, every channel (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Microsoft Edge"], kind: "dir", why: "Edge profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Microsoft Edge Beta"], kind: "dir", why: "Edge Beta profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Microsoft Edge Dev"], kind: "dir", why: "Edge Dev profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Microsoft Edge Canary"], kind: "dir", why: "Edge Canary profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "BraveSoftware"], kind: "dir", why: "Brave profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Chromium"], kind: "dir", why: "Chromium profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Arc"], kind: "dir", why: "Arc profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Vivaldi"], kind: "dir", why: "Vivaldi profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "com.operasoftware.Opera"], kind: "dir", why: "Opera profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "com.operasoftware.OperaGX"], kind: "dir", why: "Opera GX profiles (macOS)" },
  { anchor: "home", segments: ["Library", "Application Support", "Firefox"], kind: "dir", why: "Firefox profiles (macOS)" },
  { anchor: "home", segments: [".mozilla"], kind: "dir", why: "Firefox profiles (Linux)" },
  { anchor: "home", segments: [".config", "google-chrome"], kind: "dir", why: "Chrome profiles (Linux)" },
  { anchor: "home", segments: [".config", "chromium"], kind: "dir", why: "Chromium profiles (Linux)" },
  { anchor: "home", segments: [".config", "BraveSoftware"], kind: "dir", why: "Brave profiles (Linux)" },
  { anchor: "home", segments: [".config", "microsoft-edge"], kind: "dir", why: "Edge profiles (Linux)" },
  { anchor: "home", segments: [".config", "vivaldi"], kind: "dir", why: "Vivaldi profiles (Linux)" },
  { anchor: "home", segments: [".config", "opera"], kind: "dir", why: "Opera profiles (Linux)" },
  { anchor: "home", segments: [".config", "google-chrome-beta"], kind: "dir", why: "Chrome Beta profiles (Linux)" },
  { anchor: "home", segments: [".config", "google-chrome-unstable"], kind: "dir", why: "Chrome Dev profiles (Linux)" },
  { anchor: "home", segments: [".config", "microsoft-edge-beta"], kind: "dir", why: "Edge Beta profiles (Linux)" },
  { anchor: "home", segments: [".config", "microsoft-edge-dev"], kind: "dir", why: "Edge Dev profiles (Linux)" },
  // Snap and Flatpak keep each app's whole home under one per-app directory.
  { anchor: "home", segments: ["snap", "firefox"], kind: "dir", platform: "linux", why: "Firefox snap home (Linux)" },
  { anchor: "home", segments: ["snap", "chromium"], kind: "dir", platform: "linux", why: "Chromium snap home (Linux)" },
  { anchor: "home", segments: ["snap", "brave"], kind: "dir", platform: "linux", why: "Brave snap home (Linux)" },
  { anchor: "home", segments: ["snap", "thunderbird"], kind: "dir", platform: "linux", why: "Thunderbird snap home (Linux)" },
  { anchor: "home", segments: [".var", "app", "org.mozilla.firefox"], kind: "dir", platform: "linux", why: "Firefox Flatpak home (Linux)" },
  { anchor: "home", segments: [".var", "app", "org.chromium.Chromium"], kind: "dir", platform: "linux", why: "Chromium Flatpak home (Linux)" },
  { anchor: "home", segments: [".var", "app", "com.google.Chrome"], kind: "dir", platform: "linux", why: "Chrome Flatpak home (Linux)" },
  { anchor: "home", segments: [".var", "app", "com.brave.Browser"], kind: "dir", platform: "linux", why: "Brave Flatpak home (Linux)" },
  { anchor: "home", segments: [".var", "app", "com.microsoft.Edge"], kind: "dir", platform: "linux", why: "Edge Flatpak home (Linux)" },
  { anchor: "home", segments: [".var", "app", "org.mozilla.Thunderbird"], kind: "dir", platform: "linux", why: "Thunderbird Flatpak home (Linux)" },
  // Mail clients: saved account passwords (logins.json + key4.db)
  { anchor: "home", segments: [".thunderbird"], kind: "dir", why: "Thunderbird profiles (Linux)" },
  { anchor: "home", segments: ["Library", "Thunderbird"], kind: "dir", why: "Thunderbird profiles (macOS)" },
  // Shell / tool histories — routinely contain pasted secrets
  { anchor: "home", segments: [".bash_history"], kind: "file", why: "shell history" },
  { anchor: "home", segments: [".zsh_history"], kind: "file", why: "shell history" },
  { anchor: "home", segments: [".python_history"], kind: "file", why: "REPL history" },
  { anchor: "home", segments: [".psql_history"], kind: "file", why: "psql history (may hold DSNs)" },
  { anchor: "home", segments: [".viminfo"], kind: "file", why: "editor history + register contents" },
  // Windows credential stores under the profile (%APPDATA%, %LOCALAPPDATA%)
  { anchor: "home", segments: ["AppData", "Roaming", "Microsoft", "Credentials"], kind: "dir", platform: "win32", why: "Windows Credential Manager blobs (roaming)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Credentials"], kind: "dir", platform: "win32", why: "Windows Credential Manager blobs (local)" },
  { anchor: "home", segments: ["AppData", "Roaming", "Microsoft", "Protect"], kind: "dir", platform: "win32", why: "DPAPI master keys (decrypt every DPAPI-protected secret)" },
  { anchor: "home", segments: ["AppData", "Roaming", "Microsoft", "Crypto"], kind: "dir", platform: "win32", why: "user CryptoAPI/CNG private keys" },
  { anchor: "home", segments: ["AppData", "Roaming", "Microsoft", "Vault"], kind: "dir", platform: "win32", why: "Windows Vault (web and app credentials, roaming)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Vault"], kind: "dir", platform: "win32", why: "Windows Vault (local)" },
  {
    anchor: "home",
    segments: ["AppData", "Local", "Microsoft", "PowerShell", "secretmanagement"],
    kind: "dir",
    platform: "win32",
    why: "PowerShell SecretStore vault",
  },
  { anchor: "home", segments: ["AppData", "Roaming", "GitHub CLI"], kind: "dir", platform: "win32", why: "GitHub CLI OAuth token on Windows (hosts.yml)" },
  { anchor: "home", segments: ["AppData", "Local", "Google", "Chrome", "User Data"], kind: "dir", platform: "win32", why: "Chrome profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Edge", "User Data"], kind: "dir", platform: "win32", why: "Edge profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"], kind: "dir", platform: "win32", why: "Brave profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Chromium", "User Data"], kind: "dir", platform: "win32", why: "Chromium profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Vivaldi", "User Data"], kind: "dir", platform: "win32", why: "Vivaldi profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Roaming", "Opera Software"], kind: "dir", platform: "win32", why: "Opera profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Google", "Chrome SxS", "User Data"], kind: "dir", platform: "win32", why: "Chrome Canary profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Google", "Chrome Beta", "User Data"], kind: "dir", platform: "win32", why: "Chrome Beta profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Google", "Chrome Dev", "User Data"], kind: "dir", platform: "win32", why: "Chrome Dev profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Edge Beta", "User Data"], kind: "dir", platform: "win32", why: "Edge Beta profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Edge Dev", "User Data"], kind: "dir", platform: "win32", why: "Edge Dev profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Local", "Microsoft", "Edge SxS", "User Data"], kind: "dir", platform: "win32", why: "Edge Canary profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Roaming", "Thunderbird"], kind: "dir", platform: "win32", why: "Thunderbird profiles (Windows)" },
  { anchor: "home", segments: ["AppData", "Roaming", "Mozilla", "Firefox", "Profiles"], kind: "dir", platform: "win32", why: "Firefox profiles (Windows)" },
  // Ave hook scripts — supply-chain / re-exec protection
  {
    anchor: "home",
    segments: [".config", "ave", "hooks"],
    kind: "dir",
    why: "hook supply-chain protection (host-executed scripts)",
  },
  // System account databases
  { anchor: "root", segments: ["etc", "shadow"], kind: "file", why: "system password hashes" },
  { anchor: "root", segments: ["etc", "sudoers"], kind: "file", why: "sudo policy" },
  { anchor: "root", segments: ["etc", "passwd-"], kind: "file", why: "passwd backup" },
  // Ave home sensitive namespace
  { anchor: "ave-home", segments: ["certs"], kind: "dir", why: "corporate CA bundle + extracted certs" },
  { anchor: "ave-home", segments: ["secrets"], kind: "dir", why: "encrypted API keys, tokens" },
  { anchor: "ave-home", segments: ["subscription-runtimes"], kind: "dir", why: "subscription credentials, executable grants, and host-owned runtime state" },
  { anchor: "ave-home", segments: ["keys"], kind: "dir", why: "signing / encryption keys" },
  { anchor: "ave-home", segments: ["ave-secrets.json"], kind: "file", why: "legacy consolidated secrets file" },
  { anchor: "ave-home", segments: ["settings.json"], kind: "file", why: "app settings + permission configuration" },
  { anchor: "ave-home", segments: ["permissions.json"], kind: "file", why: "legacy/current permission settings file" },
  { anchor: "ave-home", segments: ["policy.json"], kind: "file", why: "policy SOT" },
  {
    anchor: "ave-home",
    segments: ["permissions"],
    kind: "dir",
    why: "reviewer cache, deferred queue, permission state",
  },
  { anchor: "ave-home", segments: ["audit"], kind: "dir", why: "audit log directory (self-tampering)" },
  {
    anchor: "ave-home",
    segments: ["audit.log"],
    kind: "file",
    rotations: true,
    why: "audit log + rotated archives",
  },
  { anchor: "ave-home", segments: ["sessions"], kind: "dir", access: "read-only", why: "saved conversation integrity" },
  { anchor: "ave-home", segments: ["host-runtime"], kind: "dir", why: "process ownership lock (replacement creates a second writer)" },
  { anchor: "ave-home", segments: ["routine"], kind: "dir", why: "routine session history" },
  {
    anchor: "ave-home",
    segments: ["plugins", "auth-partitions.json"],
    kind: "file",
    why: "plugin auth-partition state (OAuth partition mapping)",
  },
]);

// Host-tool glob projection of SENSITIVE_PATH_ENTRIES. Anchor-free (`**` prefix) for every anchor — see SensitiveAnchor for why the host guard deliberately ignores the anchor. `ave-home` rows keep the literal `.ave` segment to protect copied stores too. `isSensitivePath` also projects those rows onto the current `aveHome`, matching the sandbox floor. A `dir` row needs only the `/**` form: `policyMatchPaths` also tries `<path>/`, so `**\/.ssh/**` already matches the bare directory.
// Host-guard-only Windows patterns (no literal form): Chromium-family `Login Data` under any `User Data` profile (Chrome, Edge, Brave, …).
const WINDOWS_UNANCHORED_PATTERNS: readonly string[] = [
  "**/AppData/Local/**/User Data/**/Login Data",
  "**/AppData/Local/**/User Data/**/Cookies",
  "**/AppData/Local/**/User Data/**/Web Data",
  "**/AppData/Local/**/User Data/Local State",
  "**/AppData/Roaming/Mozilla/Firefox/Profiles/**/logins.json",
  "**/AppData/Roaming/Mozilla/Firefox/Profiles/**/key4.db",
  "**/AppData/Roaming/Mozilla/Firefox/Profiles/**/cookies.sqlite",
];

function sensitiveEntryGlobs(entries: readonly SensitiveEntry[] = SENSITIVE_PATH_ENTRIES): readonly string[] {
  const globs: string[] = [];
  for (const entry of entries) {
    const prefix = entry.anchor === "ave-home" ? "**/.ave/" : "**/";
    const base = prefix + entry.segments.join("/");
    globs.push(entry.kind === "dir" ? base + "/**" : base);
    if (entry.rotations) globs.push(base + ".*");
  }
  return globs;
}

const READ_ONLY_NAMESPACE_PATTERNS = new Set(sensitiveEntryGlobs(
  SENSITIVE_PATH_ENTRIES.filter((entry) => entry.access === "read-only"),
));

// Patterns matched case-insensitively on every platform (Windows locations).
const CASE_INSENSITIVE_PATTERNS: ReadonlySet<string> = new Set([
  ...sensitiveEntryGlobs(SENSITIVE_PATH_ENTRIES.filter((entry) => entry.platform === "win32")),
  ...WINDOWS_UNANCHORED_PATTERNS,
]);

// Whether the OS sandbox floor built on `platform` carries this row. Seatbelt compiles the profile again for every wrap and its compile time grows with the path filters, so macOS leaves out rows whose store only another OS's software creates: nothing on macOS writes a secret there, and the host guard still denies the path. Linux and Windows keep every row, so their floors stay exactly as they were.
export function sensitiveEntryOnSandboxFloor(entry: SensitiveEntry, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "darwin" || entry.platform === undefined;
}

// Patterns use minimatch-compatible glob syntax: double-star — matches any path (including path separators) single-star — matches any single path segment Ordering: credential store patterns first, then OS expansion, then Ave-specific.
export const SENSITIVE_PATH_PATTERNS: readonly string[] = Object.freeze([
  // ── Projected from SENSITIVE_PATH_ENTRIES ───────────
  // The single authority the OS sandbox deny floor projects from too. Do NOT
  // hand-add a pattern here that has a literal absolute form — add a row to
  // the table instead, or the two surfaces drift.
  // Note: `**/etc/…` rows use the double-star prefix because frozen-canonical
  // realpath() resolves /etc → /private/etc on macOS; the double-star matches
  // both forms.
  ...sensitiveEntryGlobs(),
  // Host-guard-only: deliberately unanchored, so no literal form These must match wherever the file lands, which is exactly why they have no single absolute path to project onto the sandbox floor (bwrap/seatbelt cannot glob). See SENSITIVE_PATH_ENTRIES for the full rule.
  "**/.config/**/Login Data", // browser credential DB, vendor dir varies
  // Chromium-family profile stores (Chrome, Edge, Brave, Arc, Chromium):
  // saved passwords, cookies, autofill and the key that decrypts them.
  // The vendor directory varies, so the store name is matched under it.
  "**/Library/Application Support/**/Login Data",
  "**/Library/Application Support/**/Cookies",
  "**/Library/Application Support/**/Web Data",
  "**/Library/Application Support/**/Local State",
  "**/.config/**/Cookies",
  "**/.config/**/Web Data",
  "**/.config/**/Local State",
  // Firefox profile stores: saved logins, the key that decrypts them, cookies.
  "**/Firefox/Profiles/**/logins.json",
  "**/Firefox/Profiles/**/key4.db",
  "**/Firefox/Profiles/**/cookies.sqlite",
  "**/.mozilla/firefox/**/logins.json",
  "**/.mozilla/firefox/**/key4.db",
  "**/.mozilla/firefox/**/cookies.sqlite",
  // Linux per-process secrets: another process's environment, memory and open files. `/proc/<pid>/cmdline` and `status` stay readable.
  "/proc/*/environ",
  "/proc/*/mem",
  "/proc/*/fd/**",
  "/proc/*/map_files/**",
  "/proc/*/task/*/environ",
  "/proc/*/task/*/mem",
  "/proc/*/task/*/fd/**",
  "**/.env",
  "**/.env.*",
  // Generic SSH key globs — catches id_rsa / id_ed25519 / id_ecdsa even if dropped outside `.ssh/` (e.g. /tmp staging, ~/Downloads).
  "**/id_rsa",
  "**/id_rsa.pub",
  "**/id_ed25519",
  "**/id_ed25519.pub",
  "**/id_ecdsa",
  "**/id_ecdsa.pub",
  "**/ave-secrets.json", // shallow sibling form (not under the Ave home root)
  // 1Password group containers under any team-id prefix (the floor pins the
  // published ids as table rows).
  "**/Library/Group Containers/*.com.1password*/**",
  "**/Library/Group Containers/*.com.agilebits*/**",
  ...WINDOWS_UNANCHORED_PATTERNS,
  // Electron userData dir — per-platform DEFAULT locations Holds plugin OAuth session cookies/tokens (Partitions/), Cookies (SQLite), and the safeStorage-encrypted ave-secrets.json. The sandbox floor denies the EXACT dir (it receives `app.getPath("userData")`, so it also covers `--user-data-dir` / XDG_CONFIG_HOME / a productName rename); the host guard can only pin the per-platform defaults as static globs.
  "**/Library/Application Support/Ave/**",
  "**/AppData/Roaming/Ave/**",
  "**/.config/Ave/**",
]);

// Public helpers

// Resolve once, walk existing ancestors with a bounded realpath lookup, normalize separators/Unicode/case and pass the frozen string to all policy layers; resolving again admits symlink TOCTOU. If no ancestor resolves within the bound, treat the resolved path as opaque and deny it in allowed-scope checks.
export function canonicalizePathForMatch(rawPath: string, spend?: () => void): string {
  let canonical = pathResolve(rawPath);

  // Step 2 — realpath walk-up. Try the path itself first; if missing, walk up to the nearest existing ancestor and compose the unresolved tail.
  spend?.();
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    let parent = canonical;
    let resolved = false;
    for (let depth = 0; depth < MAX_WALK_UP; depth++) {
      const next = pathResolve(parent, "..");
      if (next === parent) break; // hit filesystem root
      parent = next;
      spend?.();
      try {
        const realParent = realpathSync.native(parent);
        // Compose: realpath'd ancestor + remainder of original path.
        const remainder = pathRelative(parent, canonical);
        canonical = remainder ? pathResolve(realParent, remainder) : realParent;
        resolved = true;
        break;
      } catch {
        // keep walking
      }
    }
    // depth == MAX_WALK_UP without resolve — leave `canonical` as the pure pathResolve output. Layer 1 treats unresolved canonicals as opaque (deny by default in allow-check).
    if (!resolved) {
      // explicit no-op — canonical already equals pathResolve(rawPath)
    }
  }

  return foldCanonicalPathSeparators(canonical);
}

// One decision observes each ancestor once. A missing directory cannot contain an
// existing descendant; sibling paths reuse that fact without filesystem retries.
export function createPathCanonicalizer(): (rawPath: string, normalized?: boolean) => string {
  type PathFact = { canonical: string; folded: string; missing: boolean };
  const paths = new Map<string, PathFact>();
  const append = (parent: string, name: string): string => parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
  const missing = (path: string, ancestor: PathFact | undefined): PathFact => {
    const name = basename(path);
    const canonical = ancestor === undefined ? path : append(ancestor.canonical, name);
    const folded = ancestor !== undefined && !/[\\\x80-\uffff]/.test(name)
      ? `${ancestor.folded.endsWith("/") ? ancestor.folded : ancestor.folded + "/"}${name}`
      : foldCanonicalPathSeparators(canonical);
    return { canonical, folded, missing: true };
  };
  const resolvePath = (path: string, depth: number): PathFact => {
    const known = paths.get(path);
    if (known !== undefined) return known;
    const parent = dirname(path);
    const parentKnown = paths.get(parent);
    if (parentKnown?.missing) {
      const result = missing(path, parentKnown);
      paths.set(path, result);
      return result;
    }
    let result: PathFact;
    try {
      if (!existsSync(path)) result = missing(path, parent === path || depth >= MAX_WALK_UP ? undefined : resolvePath(parent, depth + 1));
      else {
        const canonical = realpathSync.native(path);
        result = { canonical, folded: foldCanonicalPathSeparators(canonical), missing: false };
      }
    } catch { result = missing(path, parent === path || depth >= MAX_WALK_UP ? undefined : resolvePath(parent, depth + 1)); }
    paths.set(path, result);
    return result;
  };
  return (rawPath, normalized = false) => resolvePath(normalized ? rawPath : pathResolve(rawPath), 0).folded;
}

// Steps 3–5 of canonicalizePathForMatch: separator folding, duplicate collapse, NFC, and the win32 drive-letter case fold. Exported with an explicit `platform` because the Windows shapes cannot be exercised through canonicalizePathForMatch anywhere else: `resolve` and `realpath` follow the HOST's rules, so a `\\server\share\…` input is just a filename with backslashes in it on macOS/Linux, and a win32-only assertion would never run on the machines this is developed and CI'd on.
export function foldCanonicalPathSeparators(
  canonical: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const slashed = canonical.replace(/\\/g, "/");
  // Preserve leading double separators for UNC/device paths returned by realpath; collapsing them resolves against the current drive and breaks mapped network roots.
  const startsAtWindowsUncRoot = platform === "win32" && /^\/\/[^/]/.test(slashed);
  const collapsed = slashed.replace(/\/+/g, "/");
  return (startsAtWindowsUncRoot ? `/${collapsed}` : collapsed)
    .normalize("NFC")
    .replace(/^([a-zA-Z]:)/, (m) =>
      // Preserve drive-letter case sensitivity on win32 — only lowercase the drive letter (case-insensitive) but the rest is handled below.
      platform === "win32" ? m.toLowerCase() : m,
    );
}

// Permission policy.5 — case-fold a canonical path for matching on case-insensitive filesystems (darwin/win32). Kept separate from canonicalizePathForMatch so allow-list directories from settings.json can be compared with the SAME case-fold applied to both sides without re-running the realpath walk.
export function caseFoldForMatch(canonical: string): string {
  if (process.platform === "darwin" || process.platform === "win32") {
    return canonical.toLowerCase();
  }
  return canonical;
}

// Control files remain unwritable even when their containing directory is granted.
export const PROTECTED_ROOT_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".git", ".git/hooks", ".git/config", ".git/modules", ".vscode",
  ".husky", ".githooks", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/commands",
  ".idea/workspace.xml", ".pre-commit-config.yaml", ".envrc", "lefthook.yml",
] as const;

// Host write tools floor the same control files wherever they appear in a canonical path, inside or outside the project, folded like sensitive paths.
export function protectedControlEntryFor(path: string): string | undefined {
  const segments = caseFoldForMatch(path).split("/").filter(Boolean);
  return PROTECTED_ROOT_ENTRIES.find((entry) => {
    const parts = entry.split("/");
    return segments.some((_, index) => parts.every((part, offset) => segments[index + offset] === part));
  });
}

// Returns the path-policy tuple `[path, path + "/"]` used by the underlying glob match pass. Exposed for tests and for callers that want to run custom pattern lists against the same normalization. Example: policyMatchPaths("/home/example/.aws") → ["/home/example/.aws", "/home/example/.aws/"]
export function policyMatchPaths(filePath: string): readonly string[] {
  const normalized = normalizePath(filePath);
  if (normalized.endsWith("/")) {
    return Object.freeze([normalized.slice(0, -1), normalized]);
  }
  return Object.freeze([normalized, normalized + "/"]);
}

// Resolve only the primary session namespace, without materializing it.
export function getConfiguredSessionReadRoot(): string | undefined {
  const home = canonicalizePathForMatch(aveHome());
  const lexicalRoot = foldCanonicalPathSeparators(sessionStorePath(home));
  const canonicalRoot = canonicalizePathForMatch(lexicalRoot);
  // A relocated application root is valid. A sessions-directory link must not turn that single namespace into a grant for some other host directory.
  if (caseFoldForMatch(canonicalRoot) !== caseFoldForMatch(lexicalRoot)) return undefined;
  // The native filesystem policy interprets these as patterns, not literals.
  if (/[\0\r\n*?\[\]]/.test(canonicalRoot)) return undefined;
  // A configured application root inside a credential store cannot turn that store into an allowed native read subtree.
  if (policyMatchPaths(caseFoldForMatch(canonicalRoot)).some((candidate) =>
    SENSITIVE_PATH_PATTERNS.some((pattern) => !READ_ONLY_NAMESPACE_PATTERNS.has(pattern) && globMatch(candidate, pattern)))) return undefined;
  return canonicalRoot;
}

// Membership only: callers must still apply every other sensitive-path rule.
export function isConfiguredSessionReadPath(canonicalPath: string): boolean {
  const root = getConfiguredSessionReadRoot();
  return isSessionReadPathUnderRoot(canonicalPath, root);
}

// Snapshot the namespace once for one permission decision.
export function createConfiguredSessionReadPathMatcher(): (canonicalPath: string) => boolean {
  let snapshot: { root: string | undefined } | undefined;
  return (canonicalPath) => {
    snapshot ??= { root: getConfiguredSessionReadRoot() };
    return isSessionReadPathUnderRoot(canonicalPath, snapshot.root);
  };
}

function isSessionReadPathUnderRoot(canonicalPath: string, root: string | undefined): boolean {
  if (root === undefined) return false;
  const foldedRoot = caseFoldForMatch(root);
  const foldedPath = caseFoldForMatch(canonicalPath);
  return foldedPath === foldedRoot || foldedPath.startsWith(`${foldedRoot}/`);
}

// Project the existing sensitive rules beneath a host-resolved session root. Native glob matching owns recursion; this function never scans stored data.
function getSessionReadDenyPatterns(sessionReadRoot: string): readonly string[] {
  return Object.freeze(SENSITIVE_PATH_PATTERNS.map((pattern) =>
    `${sessionReadRoot}/${pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern}`));
}

// Native shell routes must pair the read grant with its scoped exclusions.
export function getConfiguredSessionReadPolicy(): {
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
} {
  const root = getConfiguredSessionReadRoot();
  return Object.freeze({
    allowRead: Object.freeze(root === undefined ? [] : [root]),
    denyRead: root === undefined ? Object.freeze([]) : getSessionReadDenyPatterns(root),
  });
}

// Return an unconditional deny pattern for a canonical, case-folded path. Omitting the effect preserves the stricter write policy. Only the configured primary session namespace receives a read exception; other sensitive rules still apply, including credentials placed inside the readable namespace.
// Directories whose contents hold secrets, canonical and case-folded: every anchored table row, plus the stores the unanchored globs reach under the home (`Library/Application Support`, `.config`, `AppData`) and `/proc`. A recursive search started at or above one of them reads it. Resolved per call: the home and the Ave home are read live, never cached at module load.
function sensitiveSearchAnchors(canonicalize: (path: string) => string = canonicalizePathForMatch): string[] {
  const home = homedir();
  const ave = aveHome();
  const paths = SENSITIVE_PATH_ENTRIES.map((entry) =>
    pathResolve(entry.anchor === "home" ? home : entry.anchor === "ave-home" ? ave : "/", ...entry.segments));
  for (const segments of [["Library", "Application Support"], [".config"], ["AppData"]]) {
    paths.push(pathResolve(home, ...segments));
  }
  paths.push("/proc");
  return paths.map((path) => caseFoldForMatch(canonicalize(path)));
}

// Cache the secret-holding location reached by each recursive-search root in one request.
export function createSensitiveLocationMatcher(canonicalize: (path: string) => string = canonicalizePathForMatch): (directory: string) => string | null {
  let anchors: readonly string[] | undefined;
  const results = new Map<string, string | null>();
  return (directory) => {
    const cached = results.get(directory);
    if (cached !== undefined) return cached;
    anchors ??= sensitiveSearchAnchors(canonicalize);
    const trimmed = directory.length > 1 ? directory.replace(/\/+$/, "") : directory;
    const prefix = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    const result = anchors.find((anchor) => anchor === trimmed || anchor.startsWith(prefix)) ?? null;
    results.set(directory, result);
    return result;
  };
}

export function isSensitivePath(absPath: string, effect: PathEffect = "write"): string | null {
  return absPath ? createSensitivePathMatcher(effect)(absPath) : null;
}

// Snapshot policy roots and compiled globs once for one permission decision.
interface SensitivePattern {
  pattern: string;
  insensitive: boolean;
  literal: string;
  test: (path: string) => boolean;
  readOnly: boolean;
}
interface SensitivePatternIndex {
  patterns: SensitivePattern[];
  fallback: number[];
  exact: Map<string, number[]>;
  folded: Map<string, number[]>;
}
const sensitivePatternIndexes = new Map<boolean, SensitivePatternIndex>();

function sensitivePatternIndex(insensitivePlatform: boolean): SensitivePatternIndex {
  const cached = sensitivePatternIndexes.get(insensitivePlatform);
  if (cached !== undefined) return cached;
  const index: SensitivePatternIndex = { patterns: [], fallback: [], exact: new Map(), folded: new Map() };
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    const insensitive = CASE_INSENSITIVE_PATTERNS.has(pattern) || insensitivePlatform;
    const literal = pattern.replace(/\*\*\//g, "*").split(/[*?]/).sort((left, right) => right.length - left.length)[0]!;
    const ordinal = index.patterns.length;
    index.patterns.push({ pattern, insensitive, literal: insensitive ? literal.toLowerCase() : literal,
      test: compileSensitivePathGlob(pattern, insensitive), readOnly: READ_ONLY_NAMESPACE_PATTERNS.has(pattern) });
    // A complete literal segment is necessary for this pattern to match. The
    // original catalogue order still chooses among the eligible patterns.
    const anchor = pattern.split("/").filter((part) => part.length > 0 && !/[*?]/.test(part)).sort((left, right) => right.length - left.length)[0];
    if (anchor === undefined) { index.fallback.push(ordinal); continue; }
    const table = insensitive ? index.folded : index.exact;
    const key = insensitive ? anchor.toLowerCase() : anchor;
    const entries = table.get(key);
    if (entries === undefined) table.set(key, [ordinal]);
    else entries.push(ordinal);
  }
  sensitivePatternIndexes.set(insensitivePlatform, index);
  return index;
}

export function createSensitivePathMatcher(effect: PathEffect = "write", spend?: () => void, canonicalize: (path: string) => string = canonicalizePathForMatch): (absPath: string) => string | null {
  const platformCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const index = sensitivePatternIndex(platformCaseInsensitive);
  const { patterns } = index;
  interface CandidateNode { children: Map<string, CandidateNode>; eligible: number[] }
  const candidateRoot: CandidateNode = { children: new Map(), eligible: index.fallback };
  const candidateParents = new Map<string, CandidateNode>();
  const withSegment = (parent: number[], segment: string): number[] => {
    const exact = index.exact.get(segment);
    const folded = index.folded.get(segment.toLowerCase());
    if (exact === undefined && folded === undefined) return parent;
    return [...new Set([...parent, ...(exact ?? []), ...(folded ?? [])])].sort((left, right) => left - right);
  };
  const candidatesFor = (path: string): number[] => {
    const normalized = normalizePath(path);
    const end = normalized.lastIndexOf("/");
    const parent = normalized.slice(0, end < 0 ? 0 : end);
    let node = candidateParents.get(parent);
    if (node === undefined) {
      node = candidateRoot;
      // Only this incoming parent is a full-path cache key. Unseen parents
      // traverse segments once, without hashing every intermediate prefix.
      for (const segment of parent.split("/")) {
        let child: CandidateNode | undefined = node.children.get(segment);
        if (child === undefined) {
          child = { children: new Map(), eligible: withSegment(node.eligible, segment) };
          node.children.set(segment, child);
        }
        node = child;
      }
      candidateParents.set(parent, node);
    }
    const segment = normalized.slice(end + 1);
    let child: CandidateNode | undefined = node.children.get(segment);
    if (child === undefined) {
      child = { children: new Map(), eligible: withSegment(node.eligible, segment) };
      node.children.set(segment, child);
    }
    return child.eligible;
  };
  type ApplicationPath = { entry: SensitiveEntry; base: string };
  interface ApplicationNode { children: Map<string, ApplicationNode>; directories: ApplicationPath[] }
  let roots: { session?: string; keys: readonly string[] } | undefined;
  let applicationPaths: ApplicationPath[] | undefined;
  let applicationExact: Map<string, ApplicationPath[]> | undefined;
  let applicationRotations: Map<string, ApplicationPath[]> | undefined;
  const applicationRoot: ApplicationNode = { children: new Map(), directories: [] };
  const applicationParents = new Map<string, ApplicationPath[]>();
  const applicationAt = (path: string): ApplicationPath[] => {
    const cached = applicationParents.get(path);
    if (cached !== undefined) return cached;
    let node = applicationRoot;
    const directories: ApplicationPath[] = [];
    for (const segment of path.split("/")) {
      const child = node.children.get(segment);
      if (child === undefined) break;
      node = child;
      directories.push(...node.directories);
    }
    applicationParents.set(path, directories);
    return directories;
  };
  return (absPath) => {
    if (!absPath) return null;
    const candidates = policyMatchPaths(absPath);
    const normalizedPath = candidates[0]!;
    const eligible = candidatesFor(normalizedPath);
    if (effect === "write" && candidates.some((candidate) => {
      const target = caseFoldForMatch(candidate).replace(/\/+$/u, "");
      return [...runtimeSettingsScopes.values()].some((targets) => targets.has(target));
    })) {
      return "runtime-settings-file";
    }
    roots ??= {
      session: effect === "read" ? getConfiguredSessionReadRoot() : undefined,
      keys: getRuntimeSensitiveKeyPaths().map((path) => caseFoldForMatch(foldCanonicalPathSeparators(path))),
    };
    const sessionRoot = roots.session === undefined ? undefined : caseFoldForMatch(roots.session);
    const foldedPath = caseFoldForMatch(normalizedPath);
    const canReadSession = sessionRoot !== undefined
      && (foldedPath === sessionRoot || foldedPath.startsWith(`${sessionRoot}/`))
      && !policyMatchPaths(pathRelative(sessionRoot, normalizedPath)).some((candidate) =>
        candidatesFor(candidate).some((ordinal) => patterns[ordinal]!.readOnly && patterns[ordinal]!.test(candidate)));
    if (roots.keys.some((path) => candidates.includes(path))) return "runtime-secret-key";
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      for (const ordinal of eligible) {
        const { pattern, test, readOnly, insensitive, literal } = patterns[ordinal]!;
        if (!(insensitive ? lower.includes(literal) : candidate.includes(literal))) continue;
        spend?.();
        if (!(canReadSession && readOnly) && test(candidate)) return pattern;
      }
    }
    // A relocated application root need not contain a literal namespace segment.
    if (applicationPaths === undefined) {
      const home = canonicalize(aveHome());
      applicationPaths = SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor === "ave-home").map((entry) => ({
        entry, base: caseFoldForMatch(canonicalize(pathResolve(home, ...entry.segments))),
      }));
      applicationExact = new Map();
      applicationRotations = new Map();
      for (const path of applicationPaths) {
        if (path.entry.kind === "dir") {
          let node = applicationRoot;
          for (const segment of path.base.split("/")) {
            let child = node.children.get(segment);
            if (child === undefined) {
              child = { children: new Map(), directories: [] };
              node.children.set(segment, child);
            }
            node = child;
          }
          node.directories.push(path);
        }
        const exact = applicationExact.get(path.base) ?? [];
        exact.push(path);
        applicationExact.set(path.base, exact);
        if (path.entry.rotations) {
          const parent = path.base.slice(0, path.base.lastIndexOf("/"));
          const entries = applicationRotations.get(parent) ?? [];
          entries.push(path);
          applicationRotations.set(parent, entries);
        }
      }
    }
    const parent = foldedPath.slice(0, foldedPath.lastIndexOf("/"));
    const directories = applicationAt(parent);
    const exact = applicationExact!.get(foldedPath);
    const rotations = applicationRotations!.get(parent);
    if (directories.length === 0 && exact === undefined && rotations === undefined) return null;
    const applicationCandidates = new Set(directories);
    for (const path of exact ?? []) applicationCandidates.add(path);
    for (const path of rotations ?? []) if (foldedPath.startsWith(`${path.base}.`)) applicationCandidates.add(path);
    for (const { entry } of applicationCandidates) {
      if (canReadSession && entry.access === "read-only") continue;
      return `ave-home:${entry.segments.join("/")}`;
    }
    return null;
  };
}

// Internal glob matcher

// Normalize path separators: Windows backslash → forward slash. Leaves POSIX paths intact. Does NOT resolve `..` or symlinks — callers are expected to supply an absolute path already canonicalized via `path.resolve` or similar.
function normalizePath(p: string): string {
  return p.includes("\\") ? p.replace(/\\/g, "/") : p;
}
