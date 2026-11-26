/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * ─────────────────────────────────────────────────────────
 *
 * Sensitive path evidence and host credential admission
 *
 * Secret patterns classify reads for the permission pipeline. Only the host
 * credential projection is an admission deny; ordinary secret files remain
 * approvable. Protected controls are separate mandatory approval evidence.
 * Native execution rechecks credential admission and exact directory identity.
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
 *   - Ave-internal sensitive paths: secrets/, audit*, recently-denied,
 *     hooks/ (relocated to ~/.config/ave/hooks). Saved sessions allow reads only.
 */
import { closeSync, constants, fstatSync, readSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep, resolve as pathResolve, relative as pathRelative, posix } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import { globMatch } from "../lib/glob-matcher.js";
import { aveHome } from "../shared/ave-home.js";
import { sessionStorePath } from "../shared/session-store-path.js";
import type { PathEffect } from "./allowed-directories.js";
import { hostScriptWriteDenyPaths } from "../main/host-script-runtime.js";
import { compileSensitivePathGlob } from "./sensitive-path-glob.js";
import { isWindowsNetworkOrDevicePath, localDriveAlias, modelShellPath, withoutStreamSuffixes } from "../shared/shell-native-path.js";
import {
  admitLocalPath, admitLocalRoute, admitRouteAncestor, createRunLocality, type LocalFilesystemFacts, localFs, type LocalityDecision,
  type LocalRoute, unprovenLookup, withLocalityDecision,
} from "../shared/local-path-io.js";
import { classifyWindowsSpelling } from "../shared/windows-path-spelling.js";

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
    canonical = withLocalityDecision(() => localFs.realpathNative(admitLocalRoute(configured).verdict));
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
  { anchor: "ave-home", segments: ["config"], kind: "dir", why: "permission settings, user policy, and legacy secrets" },
  { anchor: "ave-home", segments: ["ave-secrets.json"], kind: "file", rotations: true, why: "legacy consolidated secrets file, and fresh copies preserved by configuration cleanup" },
  { anchor: "ave-home", segments: ["settings.json"], kind: "file", rotations: true, why: "app settings + permission configuration, and fresh copies preserved by configuration cleanup" },
  { anchor: "ave-home", segments: ["permissions.json"], kind: "file", rotations: true, why: "permission settings and protected backup names; staged replacement deletes the previous file" },
  { anchor: "ave-home", segments: ["policy.json"], kind: "file", rotations: true, why: "policy SOT, and fresh copies preserved by configuration cleanup" },
  {
    anchor: "ave-home",
    segments: ["permissions"],
    kind: "dir",
    why: "reviewer cache, denial history, permission state",
  },
  { anchor: "ave-home", segments: ["audit"], kind: "dir", why: "audit log directory (self-tampering)" },
  { anchor: "ave-home", segments: ["diff-cache"], kind: "dir", why: "stored write diffs: changed and surrounding lines of files, any session's, kept for the person's diff cards only" },
  {
    anchor: "ave-home",
    segments: ["audit.log"],
    kind: "file",
    rotations: true,
    why: "audit log and compressed archives created as new files before the original is deleted",
  },
  { anchor: "ave-home", segments: ["sessions"], kind: "dir", access: "read-only", why: "saved conversation integrity" },
  { anchor: "ave-home", segments: ["host-runtime"], kind: "dir", why: "process ownership lock (replacement creates a second writer)" },
  { anchor: "ave-home", segments: ["browser-downloads"], kind: "dir", why: "browser downloads staged until the user picks where to save them (host-only; a page's file, not the agent's)" },
  { anchor: "ave-home", segments: ["routine"], kind: "dir", why: "routine session history" },
  { anchor: "ave-home", segments: ["terminal-state"], kind: "dir", why: "host terminal output kept for restoring a tab: the user's own screen, never an agent's to read" },
  {
    anchor: "ave-home",
    segments: ["plugins", "auth-partitions.json"],
    kind: "file",
    why: "plugin auth-partition state (OAuth partition mapping)",
  },
  // Home content trust inputs: a write Ave did not record makes the item pending review, so tools never touch them; Ave's own
  // host tools (skill resources, memory) read and write them through the verified loaders.
  // `config/.ave-trust-manifest.json` is covered by the `config` row. `runtime` has no row: see the runtime note in
  // ave-home-configuration.test.ts (a deny there would land on the boundary's own Windows DACL).
  // Files, not the `mcp` directory: each server's own sandbox data lives under `mcp/<id>/sandbox` and stays writable to it.
  { anchor: "ave-home", segments: ["mcp", "servers.json"], kind: "file", rotations: true, why: "MCP server definitions, environment, and protected backup names; staged replacement deletes the previous file (home content trust input)" },
  { anchor: "ave-home", segments: ["governance", "mcp-policy.json"], kind: "file", why: "MCP governance policy (home content trust input)" },
  { anchor: "ave-home", segments: ["marketplaces"], kind: "dir", why: "marketplace sources, pins and snapshots (home content trust input)" },
  { anchor: "ave-home", segments: ["plugins", "registry.json"], kind: "file", why: "installed extension registry (home content trust input)" },
  { anchor: "ave-home", segments: ["skills"], kind: "dir", why: "user skills and their approvals (home content trust input)" },
  { anchor: "ave-home", segments: ["agents"], kind: "dir", why: "user agent profiles (home content trust input)" },
  { anchor: "ave-home", segments: ["commands"], kind: "dir", why: "user commands (home content trust input)" },
  { anchor: "ave-home", segments: ["AGENTS.md"], kind: "file", why: "global agent instructions (home content trust input)" },
  { anchor: "ave-home", segments: ["agents.custom.md"], kind: "file", why: "custom agent instructions (home content trust input)" },
  { anchor: "ave-home", segments: ["user-preferences.md"], kind: "file", why: "user preferences document (home content trust input)" },
  { anchor: "ave-home", segments: ["memories", "MEMORY.md"], kind: "file", why: "memory index (home content trust input)" },
  // Not `plugins/.cache` itself: each extension's payload generations live there and its own confined processes read them. A
  // per-extension `install-receipt.json` has no literal row (the table has no wildcard segment); a write Ave did not record
  // still makes it pending review.
  { anchor: "ave-home", segments: ["plugins", ".cache", "plugin-contribution-trust"], kind: "dir", why: "extension hook and MCP contribution approvals (home content trust input)" },
  { anchor: "ave-home", segments: ["agent-plugin-trust"], kind: "dir", why: "agent extension hook and MCP approvals (home content trust input)" },
  { anchor: "ave-home", segments: ["packages", "ledger.json"], kind: "file", why: "installed marketplace content records (home content trust input)" },
  { anchor: "ave-home", segments: ["packages", "mcp-installs.json"], kind: "file", why: "installed marketplace MCP server records (home content trust input)" },
  { anchor: "ave-home", segments: ["skill-approvals.json"], kind: "file", why: "legacy skill approvals (home content trust input)" },
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

// User-authored secret files, matched wherever they sit: reading one asks (the tree's secret-file read edge), it is never admission-denied.
// Every `.env.*` variant counts unless its exact name is a known non-secret one (see ENV_TEMPLATE_NAMES).
// Private keys are matched by their conventional names and by the `.pem` / `.key` extensions; public halves (`id_*.pub`) are not secrets.
const USER_SECRET_FILE_PATTERNS: readonly string[] = Object.freeze([
  "**/.env",
  "**/.env.*",
  // Catches a private key even when dropped outside `.ssh/` (e.g. /tmp staging, ~/Downloads); `~/.ssh` itself is a table row.
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/*.pem",
  "**/*.key",
]);

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
  ...USER_SECRET_FILE_PATTERNS,
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

// Credential stores, the process ownership lock, kept host terminal output and the stored write diffs retain an
// unconditional admission deny. The diffs hold lines of whatever files were changed, a secret file's among them, from
// every session; only the host reads them, for the person's diff cards, so no tool is ever let in, whatever the mode.
// User-authored secret files and configuration are classified separately.
function isAdmissionEntry(entry: SensitiveEntry): boolean {
  const [first, second, third] = entry.segments;
  // `terminal-state` is the user's own terminal screen kept for restoring a tab: no rule, remembered grant, reviewer or mode opens it to a tool.
  if (entry.anchor === "ave-home") return ["secrets", "keys", "subscription-runtimes", "ave-secrets.json", "auth-partitions.json", "host-runtime", "terminal-state", "diff-cache", "browser-downloads"].includes(first!)
    || (first === "plugins" && second === "auth-partitions.json");
  if (entry.anchor === "root") return second === "shadow";
  if (["Library", "AppData", ".mozilla", ".thunderbird", "snap", ".var", ".password-store"].includes(first!)) return true;
  if (first === ".local" && second === "share") return third === "keyrings" || third === "kwalletd";
  return first === ".config" && !["git", "ave", "curlrc"].includes(second!)
    && !["gh", "gcloud"].includes(second!);
}

const ADMISSION_PATH_ENTRIES = SENSITIVE_PATH_ENTRIES.filter(isAdmissionEntry);
const ADMISSION_PATH_PATTERNS = new Set([
  ...sensitiveEntryGlobs(ADMISSION_PATH_ENTRIES),
  ...SENSITIVE_PATH_PATTERNS.filter((pattern) => !sensitiveEntryGlobs().includes(pattern)
    && !USER_SECRET_FILE_PATTERNS.includes(pattern)),
]);

/** Match host credential admission patterns against an already normalized absolute spelling. */
export function isAdmissionDeniedPath(absPath: string, effect: PathEffect = "write", canonicalize?: (path: string) => string): string | null {
  return absPath ? createAdmissionDeniedPathMatcher(effect, undefined, canonicalize)(absPath) : null;
}

export function createAdmissionDeniedPathMatcher(effect: PathEffect = "write", spend?: () => void, canonicalize: (path: string) => string = canonicalizePathForMatch): (absPath: string) => string | null {
  return createPathSensitivityMatcher(effect, spend, canonicalize, true);
}

// Public helpers

type PathResolutionFacts = LocalFilesystemFacts;

// Resolve once, walk existing ancestors with a bounded realpath lookup, normalize separators/Unicode/case and pass the frozen string to all policy layers; resolving again admits symlink TOCTOU. If no ancestor resolves within the bound, treat the resolved path as opaque and deny it in allowed-scope checks.
// `facts` shares a decision-scoped cache across the Step 1 chain walk only, so the common Ave-home prefix is walked once per decision; it never feeds Step 2, so the returned canonical is byte-identical to the uncached call.
export function canonicalizePathForMatch(rawPath: string, spend?: () => void, facts?: PathResolutionFacts): string {
  return withLocalityDecision(() => foldCanonicalPathSeparators(resolvePathForPolicy(rawPath, spend, facts)));
}

const OPAQUE_NATIVE_PATH = "network-or-device-path";

/** A device or share spelling that names no local drive. Permission evidence treats its target as protected. */
function isOpaqueNativePath(path: string): boolean {
  return isWindowsNetworkOrDevicePath(path) && localDriveAlias(path) === undefined;
}

/** Resolve a policy operand while retaining the stored spelling needed for content inspection. */
export function resolvePathForPolicy(rawPath: string, spend?: () => void, facts?: PathResolutionFacts): string {
  if (isOpaqueNativePath(rawPath)) return rawPath;
  return withLocalityDecision(() => resolveLocalPathForPolicy(localDriveAlias(rawPath) ?? rawPath, spend, facts));
}

/** The spelling a path reaches at a link to a network or device target, which nothing past the link has opened. */
function reachedSpelling(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENETWORKSHAREPATH") throw error;
  return "reached" in error && typeof error.reached === "string" ? error.reached : fallback;
}

function resolveLocalPathForPolicy(rawPath: string, spend?: () => void, facts?: PathResolutionFacts): string {
  let canonical = pathResolve(rawPath);
  let route: LocalRoute;
  try { route = admitLocalRoute(canonical, { maxSymlinkHops: MAX_WALK_UP, facts }); }
  catch (error) {
    // Matching stays lexical for opaque network identities, as for direct operands: a link to one is judged by the spelling
    // it reaches, never the local spelling before it. Physical shell resolution separately propagates the error.
    return reachedSpelling(error, canonical);
  }

  // Step 2 — realpath walk-up. Try the path itself first; if missing, walk up to the nearest existing ancestor and compose the unresolved tail.
  spend?.();
  try {
    canonical = localFs.realpathNative(route.verdict);
  } catch {
    let parent = canonical;
    let resolved = false;
    for (let depth = 0; depth < MAX_WALK_UP; depth++) {
      const next = pathResolve(parent, "..");
      if (next === parent) break; // hit filesystem root
      parent = next;
      spend?.();
      try {
        const realParent = localFs.realpathNative(admitRouteAncestor(route, parent));
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

  return canonical;
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
  const resolvePath = (path: string, depth: number, route: LocalRoute): PathFact => {
    const known = paths.get(path);
    if (known !== undefined) return known;
    const parent = dirname(path);
    const parentKnown = paths.get(parent);
    if (parentKnown?.missing) {
      const result = missing(path, parentKnown);
      paths.set(path, result);
      return result;
    }
    // A refused ancestor walk propagates: the path is then judged by the spelling it reaches.
    const verdict = admitRouteAncestor(route, path);
    let canonical: string | undefined;
    if (localFs.exists(verdict)) {
      // A present entry that cannot be canonicalized proves no identity, and is never recorded as missing either.
      try { canonical = localFs.realpathNative(verdict); }
      catch (error) { throw unprovenLookup(path, [], error); }
    }
    const result: PathFact = canonical !== undefined ? { canonical, folded: foldCanonicalPathSeparators(canonical), missing: false }
      : missing(path, parent === path || depth >= MAX_WALK_UP ? undefined : resolvePath(parent, depth + 1, route));
    paths.set(path, result);
    return result;
  };
  // Recorded facts serve only the decision that observed them.
  const locality = createRunLocality();
  let observedIn: LocalityDecision | undefined;
  return (rawPath, normalized = false) => {
    if (isOpaqueNativePath(rawPath)) return foldCanonicalPathSeparators(rawPath);
    const local = localDriveAlias(rawPath);
    const path = local !== undefined ? pathResolve(local) : normalized ? rawPath : pathResolve(rawPath);
    const decision = locality();
    if (decision !== observedIn) {
      paths.clear();
      observedIn = decision;
    }
    return withLocalityDecision(() => {
      try {
        const route = admitLocalRoute(path, {
          maxSymlinkHops: MAX_WALK_UP,
          facts: {
            knownPath: (prefix) => paths.get(prefix),
            onLocalPath: (prefix, canonical, absent) => {
              paths.set(prefix, { canonical, folded: foldCanonicalPathSeparators(canonical), missing: absent });
            },
          },
        });
        return resolvePath(path, 0, route).folded;
      } catch (error) {
        return foldCanonicalPathSeparators(reachedSpelling(error, path));
      }
    }, decision);
  };
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

// Mutations of control paths require fresh approval independently of ordinary secret evidence.
export const PROTECTED_ROOT_ENTRIES = [
  ".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn",
  ".mvn", ".config/git", ".bashrc", ".zshrc", ".zprofile", ".profile",
  ".envrc", ".gitconfig", ".npmrc", ".mcp.json",
  // Agent skills, commands and plugins that several agent hosts load from a project or a home folder (owner decision 2026-11-25).
  ".agents",
] as const;

export function protectedControlEntryFor(path: string, canonicalize: (path: string) => string = canonicalizePathForMatch, options: { inspectHostFiles?: boolean } = {}): string | undefined {
  const local = withoutStreamSuffixes(localDriveAlias(path) ?? path);
  const normalized = normalizePath(local).normalize("NFC").toLowerCase().replace(/\/+$/u, "");
  const segments = normalized.split("/").filter(Boolean);
  const entry = PROTECTED_ROOT_ENTRIES.find((entry) => {
    const parts = entry.split("/");
    return segments.some((_, index) => parts.every((part, offset) => segments[index + offset] === part));
  });
  if (entry) return entry;
  if (options.inspectHostFiles === false) {
    if (segments.includes(".ave")) return "application-home";
    if ([...runtimeSettingsScopes.values()].some(targets => [...targets].some(target =>
      normalizePath(target).normalize("NFC").toLowerCase() === normalized))) return "runtime-settings-file";
    return undefined;
  }
  const homes = [pathResolve(aveHome()), canonicalize(aveHome()), pathResolve(homedir(), ".config", "ave")]
    .map((home) => normalizePath(home).normalize("NFC").toLowerCase().replace(/\/+$/u, ""));
  // The exception keys on the platform's case rule and never applies to an uncollapsed `..` spelling.
  const folded = caseFoldForMatch(normalizePath(local).normalize("NFC")).replace(/\/+$/u, "");
  const workspace = segments.includes("..") ? undefined : [pathResolve(aveHome()), canonicalize(aveHome())]
    .map((home) => caseFoldForMatch(normalizePath(home).normalize("NFC")).replace(/\/+$/u, "") + "/workspace")
    .find((base) => folded === base || folded.startsWith(base + "/"));
  if (!workspace && homes.some((base) => normalized === base || normalized.startsWith(base + "/"))) return "application-home";
  if ([...runtimeSettingsScopes.values()].some((targets) => [...targets].some((target) => {
    const base = normalizePath(target).toLowerCase();
    return normalized === base;
  }))) return "runtime-settings-file";
  // The managed workspace is user data; nested control homes remain protected.
  if ((workspace ? folded.slice(workspace.length).toLowerCase().split("/") : segments).includes(".ave")) return "application-home";
  return undefined;
}

export interface PermissionPathEvidence {
  // Absolute spellings: preserve the operand and resolve its physical target once before calling.
  lexical: string;
  canonical: string;
  effect: PathEffect;
  // Matching secret pattern or host namespace identifier, rather than a permission outcome.
  secret: string | null;
  admissionDenial: string | null;
  // Matching protected entry, including relocated application control namespaces.
  protectedControl: string | undefined;
  // An operand under the project (or using parent traversal) resolves outside it.
  // An ordinary absolute external target alone is not an escape.
  projectEscape: boolean;
  // Shell inspectors set this only for parsed deletion operands; native callers know tool intent.
  deleteIntent?: true;
}

/**
 * Whether a physical target lies in the project. A root reached through a link (macOS `/tmp/x` for `/private/tmp/x`) names
 * the same folder as its real path, so the target is inside when it lies under either spelling. A resolved path never begins
 * with a link's spelling, so the given spelling can only contain a target that was not resolved. The real root is resolved
 * once, and only when the given spelling does not already contain the target.
 */
export function createProjectMembership(projectRoot: string, canonicalize: (path: string) => string = canonicalizePathForMatch): (canonical: string) => boolean {
  const normalize = (value: string) => caseFoldForMatch(normalizePath(value)).replace(/\/+$/u, "");
  const within = (value: string, base: string) => value === base || value.startsWith(`${base}/`);
  const root = normalize(projectRoot);
  // A current-drive or drive-relative root has no independent filesystem identity.
  // Resolving it against the host's drive must not turn it into a project alias.
  const hasNativeRoot = process.platform !== "win32" || modelShellPath(projectRoot, { dialect: "native" }).nativePath !== undefined;
  let realRoot: string | undefined;
  return (canonical) => {
    if (!hasNativeRoot) return false;
    const target = normalize(canonical);
    if (within(target, root)) return true;
    realRoot ??= normalize(canonicalize(projectRoot));
    return within(target, realRoot);
  };
}

/** Snapshot matcher roots once for a decision, while retaining every lexical/canonical target. */
export function createPermissionPathEvidence(
  projectRoot: string,
  canonicalize?: (path: string) => string,
  options: { inspectHostFiles?: boolean; resolveNativePath?: (path: string) => string } = {},
): (path: { lexical: string; canonical: string; runtimePath?: string; effect: PathEffect }) => PermissionPathEvidence {
  const normalize = (value: string) => caseFoldForMatch(normalizePath(value)).replace(/\/+$/u, "");
  const inspectHostFiles = options.inspectHostFiles !== false;
  const matchingCanonicalize = inspectHostFiles ? canonicalize ?? canonicalizePathForMatch : foldCanonicalPathSeparators;
  const requiresInspection = createKeyMaterialPathMatcher();
  const root = normalize(projectRoot);
  const within = (value: string) => value === root || value.startsWith(root + "/");
  const inProject = inspectHostFiles ? createProjectMembership(projectRoot, matchingCanonicalize) : (target: string) => within(normalize(target));
  const matchers = new Map<PathEffect, { secret: (path: string) => string | null; admission: (path: string) => string | null }>();
  const observations = new Map<string, Pick<PermissionPathEvidence, "secret" | "admissionDenial" | "protectedControl" | "projectEscape">>();
  return path => {
    const lexical = normalize(path.lexical);
    const canonical = normalize(path.canonical);
    // A device or share spelling is judged as the drive path it names and, since no spelling proves that identity, also as
    // an opaque target. Only a plain share spelling of another host that names no local drive and lies in the project,
    // whose root may be a share, is ordinary project access; an ambiguous, device, extended or loopback spelling never is.
    // Its content is never inspected.
    const unresolved = (value: string) => {
      if (!isWindowsNetworkOrDevicePath(value)) return false;
      const spelling = classifyWindowsSpelling(value);
      return spelling.kind !== "share" || spelling.loopback || spelling.extended || spelling.driveAlias !== undefined
        || normalize(value).split("/").includes("..") || !inProject(value);
    };
    const opaque = unresolved(path.lexical) || unresolved(path.canonical) ? OPAQUE_NATIVE_PATH : undefined;
    // A spelling that names no local drive cannot be shown to avoid a protected target, so it always needs a person.
    const unmapped = [path.lexical, path.canonical].some(value => unresolved(value) && localDriveAlias(value) === undefined);
    const networked = isWindowsNetworkOrDevicePath(path.lexical) || isWindowsNetworkOrDevicePath(path.canonical);
    const native = inspectHostFiles && !networked && (requiresInspection(path.lexical) || requiresInspection(path.canonical))
      ? (options.resolveNativePath ?? resolvePathForPolicy)(path.lexical) : undefined;
    const sealedNative = native === undefined ? undefined : path.runtimePath;
    if (native !== undefined && (normalize(foldCanonicalPathSeparators(native)) !== normalize(foldCanonicalPathSeparators(path.canonical))
      || sealedNative !== undefined && native !== sealedNative)) {
      throw new Error("Permission path identity changed");
    }
    const key = JSON.stringify([path.effect, path.lexical, path.canonical, native]);
    const previous = native === undefined ? observations.get(key) : undefined;
    if (previous) return { lexical: path.lexical, canonical: path.canonical, effect: path.effect, ...previous };
    let matcher = matchers.get(path.effect);
    if (!matcher) {
      matcher = {
        secret: createSensitivePathMatcher(path.effect, undefined, matchingCanonicalize, { inspectKeyMaterial: inspectHostFiles }),
        admission: createPathSensitivityMatcher(path.effect, undefined, matchingCanonicalize, true, "agent", undefined, 0, undefined, { inspectKeyMaterial: inspectHostFiles }),
      };
      matchers.set(path.effect, matcher);
    }
    // A content lookup binds the lexical name and resolved target to the same verified native operand. Ordinary name
    // evidence still consumes the frozen matching keys without another filesystem resolution.
    const secretMatcher = native === undefined ? matcher.secret
      : createPathSensitivityMatcher(path.effect, undefined, matchingCanonicalize, false, "agent", undefined, 0, sealedNative ?? native);
    const secretLexical = native === undefined ? lexical : path.lexical;
    const secretCanonical = canonical;
    const named = normalize(localDriveAlias(path.lexical) ?? path.lexical);
    const observation = {
      secret: secretMatcher(secretLexical) ?? (secretCanonical === secretLexical ? null : secretMatcher(secretCanonical)) ?? opaque ?? null,
      admissionDenial: matcher.admission(lexical) ?? (canonical === lexical ? null : matcher.admission(canonical)),
      protectedControl: path.effect === "write" ? protectedControlEntryFor(lexical, matchingCanonicalize, { inspectHostFiles }) ?? protectedControlEntryFor(canonical, matchingCanonicalize, { inspectHostFiles }) ?? opaque : undefined,
      projectEscape: unmapped || (within(named) || named.split("/").includes("..")) && !inProject(canonical),
    };
    // Content and inode can change at an unchanged native name; only name-based evidence is reusable.
    if (native === undefined) observations.set(key, observation);
    return { lexical: path.lexical, canonical: path.canonical, effect: path.effect, ...observation };
  };
}

/** Match filesystem roots, the OS home and project roots or their ancestors in either spelling.
 * The caller establishes deletion intent; ordinary mutations do not use this fact. */
export function criticalDeleteTargetFor(
  path: { lexical: string; canonical: string },
  projectRoots: readonly string[],
  options: { inspectHostFiles?: boolean } = {},
): string | undefined {
  const normalize = (value: string) => {
    const normalized = caseFoldForMatch(posix.normalize(normalizePath(value))).replace(/\/+$/u, "");
    return normalized || "/";
  };
  const roots = [...(options.inspectHostFiles === false ? [] : [homedir(), canonicalizePathForMatch(homedir())]), ...projectRoots].map(normalize);
  for (const value of [path.lexical, path.canonical]) {
    const target = normalize(value);
    if (target === "/" || /^[a-z]:$/i.test(target) || /^\/\/[^/]+\/[^/]+$/u.test(normalizePath(value).replace(/\/+$/u, ""))) return value;
    if (roots.some((root) => root === target || root.startsWith(target + "/"))) return value;
  }
  return undefined;
}

// Returns the path-policy tuple `[path, path + "/"]` used by the underlying glob match pass. Exposed for tests and for callers that want to run custom pattern lists against the same normalization. Example: policyMatchPaths("/home/example/.aws") → ["/home/example/.aws", "/home/example/.aws/"]
// Names are matched in NFC, as canonical paths are spelled, whatever normalization the caller's spelling used; the tuple is
// for matching only, and a path is resolved in the caller's own spelling.
export function policyMatchPaths(filePath: string): readonly string[] {
  const slashed = normalizePath(filePath);
  const normalized = NON_ASCII.test(slashed) ? slashed.normalize("NFC") : slashed;
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

// Project the sensitive rules beneath the resolved session root. Shell backends
// that grant session reads enforce these exclusions. Windows shell policy
// withholds the session read grant.
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

/**
 * Who a key-extension file (`*.pem`, `*.key`) is judged for, where the host may look inside it.
 *   "agent"  a file whose content was not seen to hold no key counts as one: a read the agent asks for is fail-closed.
 *   "person" only a file seen to hold a private-key header counts: what the person sees in the folder view, drops on a
 *            chat or opens in another program themselves is hidden or refused only for a confirmed key, so a large
 *            presentation document stays theirs to use. Where the host may not look, the name decides for both.
 */
export type KeyMaterialAudience = "agent" | "person";

/** Match ordinary secret evidence, including host stores, against a normalized absolute spelling. */
export function isSensitivePath(absPath: string, effect: PathEffect = "write", audience: KeyMaterialAudience = "agent"): string | null {
  return absPath ? createPathSensitivityMatcher(effect, undefined, canonicalizePathForMatch, false, audience)(absPath) : null;
}

/**
 * A folder listing reuses the cached pattern index. Each row serially samples the recorded chains for reused policy
 * roots. If only a directory change time moved on a direct chain, that lookup reads its chain again and confirms the
 * directory's next component still resolves to the same spelling. Failed validation, including a missing next component,
 * falls back to live canonicalization.
 * A concurrent change after a sample can leave that row's observation stale. File-tool permission and execution keep
 * their own checks.
 */
export function createSensitivePathCheck(effect: PathEffect = "write", audience: KeyMaterialAudience = "agent"): (absPath: string) => string | null {
  const decision = createRevalidatingCanonicalizer();
  // Rows of one synchronous run share drive answers; the first row after an await reads them again.
  const locality = createRunLocality();
  return (absPath) => absPath
    ? withLocalityDecision(() => createPathSensitivityMatcher(effect, undefined, decision(), false, audience)(absPath), locality())
    : null;
}

// One lstat: identity, type, change time and link target; null when nothing is there; undefined when it cannot vouch for a
// resolution through it (an error or an entry without an identity). The change time moves when the entry or one inside it
// is renamed, which an alias spelling such as an 8.3 name would not otherwise show.
type ChainEntry = { dev: bigint; ino: bigint; type: bigint; changed: bigint; link?: string } | null;

function readChainEntry(path: string): ChainEntry | undefined {
  try {
    // The chain is read from its volume root, so each parent was read first; a refused spelling cannot vouch.
    const verdict = admitLocalPath(path);
    const entry = localFs.lstatBigint(verdict);
    if (entry === undefined) return null;
    if (entry.ino === 0n) return undefined;
    const read = { dev: entry.dev, ino: entry.ino, type: entry.mode & BigInt(constants.S_IFMT), changed: entry.ctimeNs };
    return entry.isSymbolicLink() ? { ...read, link: localFs.readlink(verdict) } : read;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? null : undefined;
  }
}

function sameChainEntry(left: ChainEntry | undefined, right: ChainEntry, compareChangeTime = true): boolean {
  if (left === undefined || left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type && (!compareChangeTime || left.changed === right.changed)
    && left.link === right.link;
}

// Record each entry from the volume root that resolving `path` passes through, and each entry of the targets of links on
// the way. False when the walk meets what it cannot vouch for, or would touch what resolution never touches: a network or
// device location, a drive mapped to one, a target with "..", a drive-relative or root-relative target, or too many links.
function recordResolutionChain(path: string, read: (path: string) => ChainEntry | undefined, entries: Map<string, ChainEntry>, links = { count: 0 }): boolean {
  const resolved = pathResolve(path);
  if (process.platform === "win32" ? !/^[A-Za-z]:\\/u.test(resolved)
    : !resolved.startsWith("/")) return false;
  const { root } = parse(resolved);
  const names = resolved.slice(root.length).split(sep).filter(Boolean);
  let prefix = root;
  for (const name of ["", ...names]) {
    if (name) prefix = join(prefix, name);
    const key = process.platform === "win32" ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : prefix;
    const entry = read(key);
    if (entry === undefined) return false;
    entries.set(key, entry);
    if (entry === null) return true;
    if (entry.link === undefined) continue;
    const target = entry.link;
    if (++links.count > MAX_WALK_UP || target.split(/[\\/]/u).includes("..")) return false;
    const absolute = process.platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(target) : target.startsWith("/");
    if (!absolute && (isAbsolute(target) || /^[A-Za-z]:/u.test(target))) return false;
    if (!recordResolutionChain(absolute ? target : join(dirname(key), target), read, entries, links)) return false;
  }
  return true;
}

// Share witness samples across cache lookups for one row. Validate both the requested and canonical chains.
// Seeding a cache entry compares the recorded witness with a fresh read after resolution.
function createRevalidatingCanonicalizer(): () => (path: string) => string {
  const seen = new Set<string>();
  type ResolutionWitness = { canonical: string; entries: Array<[string, ChainEntry]>; direct: boolean };
  const resolved = new Map<string, ResolutionWitness>();
  return () => {
    const readings = new Map<string, ChainEntry | undefined>();
    const read = (path: string): ChainEntry | undefined => {
      if (!readings.has(path)) readings.set(path, readChainEntry(path));
      return readings.get(path);
    };
    // Many policy roots share a changed directory. Its confirmations serve the row while it reads the same.
    const spellings = new Map<string, { directory: NonNullable<ChainEntry>; confirmed: Map<string, boolean> }>();
    const confirmsSpelling = (changed: string, directory: NonNullable<ChainEntry>, path: string): boolean => {
      let known = spellings.get(changed);
      if (known === undefined || !sameChainEntry(directory, known.directory)) {
        known = { directory, confirmed: new Map() };
        spellings.set(changed, known);
      }
      const recorded = known.confirmed.get(path);
      if (recorded !== undefined) return recorded;
      let confirmed = false;
      try {
        confirmed = foldCanonicalPathSeparators(localFs.realpathNative(admitLocalRoute(path).verdict)) === foldCanonicalPathSeparators(path);
      } catch { /* Unconfirmed spellings require live resolution. */ }
      known.confirmed.set(path, confirmed);
      return confirmed;
    };
    const holds = ({ entries, direct }: ResolutionWitness) => {
      if (entries.every(([path, entry]) => sameChainEntry(read(path), entry))) return true;
      if (!direct) return false;
      // The row's samples may predate a change along this route, so read the whole route again for this lookup.
      return entries.every(([path, entry], index) => {
        const current = readChainEntry(path);
        if (sameChainEntry(current, entry)) return true;
        if (!current || entry?.type !== BigInt(constants.S_IFDIR) || !sameChainEntry(current, entry, false)) return false;
        // A spelling proves only its own prefix, and a missing child of a changed directory may now exist or be a link.
        const next = entries[index + 1];
        return next?.[1] !== null && confirmsSpelling(path, current, next?.[0] ?? path);
      });
    };
    return (path) => {
      const cached = resolved.get(path);
      if (cached !== undefined && holds(cached)) return cached.canonical;
      resolved.delete(path);
      if (!seen.has(path)) {
        seen.add(path);
        return canonicalizePathForMatch(path);
      }
      const entries = new Map<string, ChainEntry>();
      const recorded = !isWindowsNetworkOrDevicePath(path) && recordResolutionChain(path, read, entries);
      const canonical = canonicalizePathForMatch(path);
      // Reuse only a resolution whose entries read the same before and after it.
      if (recorded && recordResolutionChain(canonical, read, entries)) {
        const chain = [...entries];
        if (chain.every(([path, entry]) => sameChainEntry(readChainEntry(path), entry))) {
          const direct = canonical === foldCanonicalPathSeparators(pathResolve(path))
            && chain.every(([path, entry], index) => entry?.link === undefined && (index === 0 || dirname(path) === chain[index - 1]?.[0]));
          resolved.set(path, { canonical, entries: chain, direct });
        }
      }
      return canonical;
    };
  };
}

/**
 * The agent's read of exactly `bytes`, from the start of the file at `absPath` and about to be handed
 * on: the name rules as for `isSensitivePath(absPath, "read")`, and for a key-extension name the content rules applied to
 * these bytes instead of to whatever the path holds now. `size` is the file's full size (by default these bytes are the
 * whole file); a partial read cannot clear a key-extension name.
 */
export function isSensitiveContent(absPath: string, bytes: Buffer, size = bytes.length): string | null {
  return absPath ? createPathSensitivityMatcher("read", undefined, canonicalizePathForMatch, false, "agent", bytes, size)(absPath) : null;
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
const sensitivePatternIndexes = new Map<string, SensitivePatternIndex>();
// `.env.*` names that hold no secrets by convention: templates, and `.env.test`, which is committed test defaults (its secret-bearing sibling `.env.test.local` still asks).
const ENV_TEMPLATE_NAMES: ReadonlySet<string> = new Set([".env.example", ".env.sample", ".env.template", ".env.dist", ".env.test"]);

function isEnvironmentTemplatePath(path: string, insensitive: boolean): boolean {
  const name = basename(normalizePath(path).replace(/\/+$/u, ""));
  return ENV_TEMPLATE_NAMES.has(insensitive ? name.toLowerCase() : name);
}

// Extensions that private keys share with files that are not secret: a certificate, a public key, a presentation document.
// A name alone cannot tell them apart, so these two rows ask what the file holds, where the host may look.
const KEY_MATERIAL_PATTERNS: ReadonlySet<string> = new Set(["**/*.pem", "**/*.key"]);

/** Recognize names whose sensitivity can depend on inspected file content, without filesystem lookup. */
export function createKeyMaterialPathMatcher(): (path: string) => boolean {
  const patterns = [...KEY_MATERIAL_PATTERNS].map(pattern => compileSensitivePathGlob(pattern, process.platform === "darwin" || process.platform === "win32"));
  return path => policyMatchPaths(path).some(candidate => patterns.some(test => test(candidate)));
}
// How much of a file is read to look for a key. A file larger than this is not shown to hold none.
// It covers the certificate bundles systems ship, so those are read whole and seen to hold no key.
export const KEY_MATERIAL_SCAN_BYTES = 1024 * 1024;
// Nothing about a file's format clears bytes that were not read: key readers find a private-key header anywhere in a
// file, and an archive's stored entries hold plain text. A presentation document saved as one archive is read like any
// other file, so a large one is not shown to hold no key.
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

const keyMaterialInspectionGrants = new Set<(canonicalPath: string) => boolean>();

/**
 * Say which key-extension files may be opened to see what they hold. Classifying a path must not read a file the person
 * never brought into Ave, so a `.pem` or `.key` file is looked at only where some registered grant says yes for its
 * canonical, case-folded path: inside a registered project, or a file the person picked or dropped. Everywhere else, and
 * while nothing is registered, such a name is treated as a key on its name alone. Returns the call that withdraws the grant.
 */
export function allowKeyMaterialInspection(grant: (canonicalPath: string) => boolean): () => void {
  keyMaterialInspectionGrants.add(grant);
  return () => { keyMaterialInspectionGrants.delete(grant); };
}

/** `allowKeyMaterialInspection` for whole folders: the files below the folders `roots` names when it is asked. */
export function allowKeyMaterialInspectionUnder(roots: () => readonly string[]): () => void {
  return allowKeyMaterialInspection((canonicalPath) => roots().some((root) => {
    const base = caseFoldForMatch(canonicalizePathForMatch(root)).replace(/\/+$/u, "");
    return canonicalPath.startsWith(`${base}/`);
  }));
}

/**
 * The content rule, for `bytes` read from the start of a file of `size` bytes: a private-key header in the first
 * `KEY_MATERIAL_SCAN_BYTES` is a key; otherwise only a file read whole within that window holds none. Nothing found, but
 * only what was read is known: a longer file has a part nobody looked at, whatever its first bytes say it is.
 */
function keyMaterialEvidenceOf(bytes: Buffer, size: number): "none" | "key" | "unknown" {
  const scanned = Math.min(bytes.length, KEY_MATERIAL_SCAN_BYTES);
  if (PRIVATE_KEY_HEADER.test(bytes.toString("latin1", 0, scanned))) return "key";
  return size <= KEY_MATERIAL_SCAN_BYTES && bytes.length === size ? "none" : "unknown";
}

/**
 * Whether bytes read through a handle open as `opened` (its bigint fstat) came from the file at `judged`, the path whose
 * name and location rules the caller judges for them. Asked after the read and before the bytes are used: `judged` is
 * resolved again and must still resolve to itself, spelled as the rules match it, and the entry there must be that very
 * regular file. A folder or last name that led elsewhere while the file was opened, and was put back, leaves a different
 * file at the path; one that still leads elsewhere resolves to another path. This is also the guard where an open cannot
 * refuse a link in the last name (Windows has no such flag). These are two lookups, since Node cannot name an open
 * handle's path on macOS or Windows: a path switched to another file and back between them is not seen.
 */
export function judgedPathNamesOpenedFile(judged: string, opened: BigIntStats): boolean {
  const spelled = (path: string): string => caseFoldForMatch(foldCanonicalPathSeparators(path));
  return withLocalityDecision(() => {
    let route: LocalRoute;
    let real: string;
    try {
      route = admitLocalRoute(judged);
      real = localFs.realpath(route.verdict);
    } catch { return false; }
    if (spelled(real) !== spelled(judged)) return false;
    let named: BigIntStats | undefined;
    try { named = localFs.lstatBigint(admitRouteAncestor(route, real)); } catch { return false; }
    return named?.isFile() === true && opened.isFile() && sameFileIdentity(named, opened);
  });
}

/**
 * What the file at the canonical path `path` shows about key material, read at most once and at most
 * `KEY_MATERIAL_SCAN_BYTES`:
 *   "none"    nothing exists there yet, it is a folder (a presentation package), or the whole file was read and holds no
 *             private-key header;
 *   "key"     a PEM or OpenSSH private-key header was found;
 *   "unknown" anything else: a link or special file, a file that cannot be opened, one the path no longer names once it
 *             was read, or one with bytes beyond the window that were not read. Unknown is never taken for harmless.
 * The file is opened without following a link in its last name where the platform can refuse one, read through that one
 * handle, and its bytes count only if the path still names that file after the read (`judgedPathNamesOpenedFile`).
 */
function keyMaterialEvidence(path: string): "none" | "key" | "unknown" {
  return withLocalityDecision(() => readKeyMaterialEvidence(path));
}

function readKeyMaterialEvidence(path: string): "none" | "key" | "unknown" {
  let descriptor: number | undefined;
  try {
    // A spelling the walk refuses is unknown, never a missing file.
    const { verdict } = admitLocalRoute(path);
    const named = localFs.lstatBigint(verdict);
    if (named === undefined) return "none";
    if (named.isDirectory()) return "none";
    if (!named.isFile()) return "unknown";
    descriptor = localFs.open(verdict, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) return "unknown";
    const wanted = Number(opened.size > BigInt(KEY_MATERIAL_SCAN_BYTES) ? BigInt(KEY_MATERIAL_SCAN_BYTES) : opened.size);
    const bytes = Buffer.alloc(wanted);
    let filled = 0;
    while (filled < wanted) {
      const read = readSync(descriptor, bytes, filled, wanted - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    if (!judgedPathNamesOpenedFile(path, opened)) return "unknown";
    // A short read is judged on the bytes it gave, as a file with a part nobody looked at.
    return keyMaterialEvidenceOf(bytes.subarray(0, filled),
      filled !== wanted || opened.size > BigInt(KEY_MATERIAL_SCAN_BYTES) ? Number.POSITIVE_INFINITY : Number(opened.size));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "none" : "unknown";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const NON_ASCII = /\P{ASCII}/u;

/**
 * Whether `path` may be looked up on the filesystem: not a network or device path, and reached only through local folders
 * (`admitLocalRoute`), the checks `canonicalizePathForMatch` makes before it touches a path.
 */
function onLocalFilesystem(path: string): boolean {
  if (isWindowsNetworkOrDevicePath(path)) return false;
  try {
    withLocalityDecision(() => admitLocalRoute(pathResolve(path)));
    return true;
  } catch {
    return false;
  }
}

function sensitivePatternIndex(insensitivePlatform: boolean, admissionOnly: boolean): SensitivePatternIndex {
  const key = `${insensitivePlatform}:${admissionOnly}`;
  const cached = sensitivePatternIndexes.get(key);
  if (cached !== undefined) return cached;
  const index: SensitivePatternIndex = { patterns: [], fallback: [], exact: new Map(), folded: new Map() };
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (admissionOnly && !ADMISSION_PATH_PATTERNS.has(pattern)) continue;
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
  sensitivePatternIndexes.set(key, index);
  return index;
}

interface SensitivePathMatcherOptions {
  inspectKeyMaterial?: boolean;
  includeKeyMaterial?: boolean;
  resolveNativePath?: (path: string) => string;
}

export function createSensitivePathMatcher(effect: PathEffect = "write", spend?: () => void, canonicalize: (path: string) => string = canonicalizePathForMatch, options: SensitivePathMatcherOptions = {}): (absPath: string) => string | null {
  return createPathSensitivityMatcher(effect, spend, canonicalize, false, "agent", undefined, 0, undefined, options);
}

function createPathSensitivityMatcher(
  effect: PathEffect,
  spend: (() => void) | undefined,
  canonicalize: (path: string) => string,
  admissionOnly: boolean,
  audience: KeyMaterialAudience = "agent",
  // Content already read from the file being judged; its key evidence is taken from these bytes and the full size.
  content?: Buffer,
  contentSize = content?.length ?? 0,
  // A verified evidence target binds content lookup while the lexical name still contributes its own patterns.
  nativeInspectionPath?: string,
  options: SensitivePathMatcherOptions = {},
): (absPath: string) => string | null {
  const nameOnly = options.inspectKeyMaterial === false || options.includeKeyMaterial === false;
  const matchingCanonicalize = nameOnly ? foldCanonicalPathSeparators : canonicalize;
  const platformCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const index = sensitivePatternIndex(platformCaseInsensitive, admissionOnly);
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
  // Resolve the caller's operand before folding its identity for grants. Only the native resolution names the file to
  // inspect: normalization and case matching must not select a different stored entry. Network and device paths remain
  // opaque, and content is inspected only where a grant covers its resolved identity.
  let boundEvidence: "none" | "key" | "unknown" | undefined;
  const mayHoldPrivateKey = (spelled: string): boolean => {
    if (isWindowsNetworkOrDevicePath(spelled)) return true;
    const local = onLocalFilesystem(nativeInspectionPath ?? spelled);
    const native = local ? nativeInspectionPath ?? (options.resolveNativePath ?? resolvePathForPolicy)(spelled) : undefined;
    const folded = caseFoldForMatch(foldCanonicalPathSeparators(canonicalize(native ?? spelled)));
    const inspectable = [...keyMaterialInspectionGrants].some((grant) => grant(folded));
    if (inspectable && content === undefined && native !== undefined && nativeInspectionPath !== undefined && boundEvidence === undefined) {
      boundEvidence = keyMaterialEvidence(native);
    }
    const evidence = !inspectable ? "unknown"
      : content !== undefined ? keyMaterialEvidenceOf(content, contentSize)
      : native === undefined ? "unknown"
      : nativeInspectionPath === undefined ? keyMaterialEvidence(native) : boundEvidence ?? "unknown";
    const result = !inspectable || evidence === "key" || (audience === "agent" && evidence === "unknown");
    return result;
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
  // `spelled` is the caller's own spelling, in which the path is resolved; `candidates` are for matching names.
  const matchSpelling = (absPath: string, spelled: string): string | null => {
    const candidates = policyMatchPaths(absPath);
    const normalizedPath = candidates[0]!;
    const eligible = candidatesFor(normalizedPath);
    if (!nameOnly && effect === "write") {
      for (const path of hostScriptWriteDenyPaths()) {
        const bases = [canonicalize(path), pathResolve(path)].map((value) => caseFoldForMatch(value).replace(/\/+$/u, ""));
        if (candidates.some((candidate) => bases.some((base) => {
          const folded = caseFoldForMatch(candidate);
          return folded === base || folded.startsWith(`${base}/`);
        }))) return "host-script-resources";
      }
    }
    if (!admissionOnly && effect === "write" && candidates.some((candidate) => {
      const target = caseFoldForMatch(candidate).replace(/\/+$/u, "");
      return [...runtimeSettingsScopes.values()].some((targets) => targets.has(target));
    })) {
      return "runtime-settings-file";
    }
    roots ??= {
      session: !nameOnly && effect === "read" ? getConfiguredSessionReadRoot() : undefined,
      keys: (nameOnly
        ? runtimeSecretKeyPaths?.configured === process.env.AVE_SECRET_KEY_FILE ? runtimeSecretKeyPaths?.paths ?? []
          : process.env.AVE_SECRET_KEY_FILE === undefined ? [] : [pathResolve(process.env.AVE_SECRET_KEY_FILE)]
        : getRuntimeSensitiveKeyPaths()).map((path) => caseFoldForMatch(foldCanonicalPathSeparators(path))),
    };
    const sessionRoot = roots.session === undefined ? undefined : caseFoldForMatch(roots.session);
    const foldedPath = caseFoldForMatch(normalizedPath);
    const canReadSession = sessionRoot !== undefined
      && (foldedPath === sessionRoot || foldedPath.startsWith(`${sessionRoot}/`))
      && !policyMatchPaths(posix.relative(sessionRoot, foldedPath)).some((candidate) =>
        candidatesFor(candidate).some((ordinal) => patterns[ordinal]!.readOnly && patterns[ordinal]!.test(candidate)));
    if (roots.keys.includes(foldedPath)) return "runtime-secret-key";
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      for (const ordinal of eligible) {
        const { pattern, test, readOnly, insensitive, literal } = patterns[ordinal]!;
        if (pattern === "**/.env.*" && isEnvironmentTemplatePath(candidate, insensitive)) continue;
        if (!(insensitive ? lower.includes(literal) : candidate.includes(literal))) continue;
        spend?.();
        if (!(canReadSession && readOnly) && test(candidate)) {
          if (KEY_MATERIAL_PATTERNS.has(pattern)) {
            if (options.includeKeyMaterial === false) continue;
            if (options.inspectKeyMaterial !== false && !mayHoldPrivateKey(spelled)) continue;
          }
          return pattern;
        }
      }
    }
    if (nameOnly) return null;
    // A relocated application root need not contain a literal namespace segment.
    if (applicationPaths === undefined) {
      const home = matchingCanonicalize(aveHome());
      applicationPaths = (admissionOnly ? ADMISSION_PATH_ENTRIES : SENSITIVE_PATH_ENTRIES).filter((entry) => entry.anchor === "ave-home").map((entry) => ({
        entry, base: caseFoldForMatch(matchingCanonicalize(pathResolve(home, ...entry.segments))),
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
  // A stream names data of its file, and a device or loopback share alias the drive path, which are judged as well.
  return (absPath) => {
    if (!absPath) return null;
    const named = withoutStreamSuffixes(localDriveAlias(absPath) ?? absPath);
    return matchSpelling(absPath, absPath) ?? (named === absPath ? null : matchSpelling(named, absPath));
  };
}

// Internal glob matcher

// Normalize path separators: Windows backslash → forward slash. Leaves POSIX paths intact. Does NOT resolve `..` or symlinks — callers are expected to supply an absolute path already canonicalized via `path.resolve` or similar.
function normalizePath(p: string): string {
  return p.includes("\\") ? p.replace(/\\/g, "/") : p;
}
