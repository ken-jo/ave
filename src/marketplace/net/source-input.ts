/** Lexical parsing, classification and consent precede all folder access.
 * Resolution fences every filesystem call, including canonical spellings and paths reached through links. */
import { fileURLToPath } from "node:url";
import { scrubDiagnosticSecrets } from "../../shared/dlp.js";
import { errorMessage } from "../../shared/error-message.js";
import { ConfirmationRequiredError, MarketplaceError, type MarketplaceErrorDetail } from "../errors.js";
import type { FolderFs, FolderStat } from "../sources/folder-fs.js";
import { isFolderPathInput, normalizeSourceUrl, type NormalizedSourceUrl } from "./source-url.js";
import { MARKETPLACE_INDEX_FILE } from "../catalog/types.js";

export type SourceInput =
  | { kind: "git"; url: NormalizedSourceUrl }
  | { kind: "folder"; path: string; input: string };

export type FolderNetwork = { network: false } | { network: true; server: string | null };

/** A directory's identity: `dev` and `ino`, zero where the filesystem reports none. */
export interface FolderIdentity {
  dev: bigint;
  ino: bigint;
}

/** Ancestor identities detect nested sources through aliases, not just lexical paths. */
export interface FolderRoot extends FolderIdentity {
  path: string;
  ancestors: FolderIdentity[];
}

export const MAX_LINKS_PER_RESOLUTION = 40;

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const DRIVE_ANY = /^[A-Za-z]:/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

type UrlReason = Extract<MarketplaceErrorDetail<"SOURCE_URL_REJECTED">, { reason: string }>["reason"];

function refuse(input: string, reason: UrlReason, why: string): never {
  throw new MarketplaceError("SOURCE_URL_REJECTED", `folder path rejected (${why}): ${scrubDiagnosticSecrets(input)}`, { detail: { reason } as MarketplaceErrorDetail<"SOURCE_URL_REJECTED"> });
}

export function normalizeSourceInput(input: string, platform: NodeJS.Platform, home: string): SourceInput {
  const text = input.trim();
  if (!isFolderPathInput(text)) return { kind: "git", url: normalizeSourceUrl(input) };
  return { kind: "folder", path: normalizeFolderPath(text, platform, home), input: text };
}

export function normalizeFolderPath(text: string, platform: NodeJS.Platform, home: string): string {
  if (CONTROL.test(text)) refuse(text, "format", "control character");
  let path = text;
  if (/^file:/iu.test(path)) path = fromFileUrl(path, platform);
  else if (path.startsWith("~")) path = expandHome(path, platform, home);
  return platform === "win32" ? normalizeWindows(path, text) : normalizePosix(path, text);
}

function fromFileUrl(text: string, platform: NodeJS.Platform): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse(text, "format", "not a file URL");
  }
  if (url.search !== "" || url.hash !== "") refuse(text, "format", "query or fragment");
  // WHATWG parsing already turns `file://localhost/` into an empty host.
  if (platform !== "win32" && url.hostname !== "") refuse(text, "network-file-url", `a file URL naming ${url.hostname}`);
  try {
    return fileURLToPath(url, { windows: platform === "win32" });
  } catch (error) {
    // `file:///m` on Windows names no drive; an encoded separator is not a path.
    if ((error as NodeJS.ErrnoException).code === "ERR_INVALID_FILE_URL_PATH" && /absolute/iu.test((error as Error).message)) {
      return refuse(text, "relative-path", "a file URL without a drive");
    }
    return refuse(text, "format", (error as Error).message);
  }
}

function expandHome(text: string, platform: NodeJS.Platform, home: string): string {
  if (text === "~") return home;
  const separated = platform === "win32" ? /^~[\\/]/u : /^~\//u;
  if (!separated.test(text)) refuse(text, "relative-path", "~ followed by a name");
  return `${home}${platform === "win32" ? "\\" : "/"}${text.slice(2)}`;
}

/** Input traversal above root is refused; link text clamps at root as the OS does. */
function lexicalSegments(raw: readonly string[], input: string | null): string[] {
  const out: string[] = [];
  for (const segment of raw) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) {
        if (input !== null) refuse(input, "outside-root", ".. above the root");
        continue;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

function normalizeWindows(raw: string, input: string): string {
  let path = raw;
  const extended = /^[\\/]{2}([?.])[\\/](.*)$/su.exec(path);
  if (extended) {
    const [, kind, rest] = extended as unknown as [string, string, string];
    if (kind === "?" && DRIVE_ABSOLUTE.test(rest)) path = rest;
    else if (kind === "?" && /^UNC[\\/]/iu.test(rest)) path = `\\\\${rest.slice(4)}`;
    else refuse(input, "device-path", "a Windows device path");
  }
  if (/^[\\/]{2}/u.test(path)) return normalizeUnc(path, input);
  if (DRIVE_ABSOLUTE.test(path)) {
    const segments = lexicalSegments(path.slice(3).split(/[\\/]+/u), input);
    return `${path[0]!.toUpperCase()}:\\${segments.join("\\")}`;
  }
  return refuse(input, "relative-path", "a relative path");
}

/** WebDAV TLS and port spellings are the only allowed @ forms in a UNC server. */
const WEBDAV_SERVER = /^[^@]+@(?:SSL(?:@\d+)?|\d+)$/iu;

function normalizeUnc(path: string, input: string): string {
  const [server, share, ...rest] = path.slice(2).split(/[\\/]+/u);
  if (!server || !share) refuse(input, "unc-without-share", "a network path without a share");
  // Reject credentials in server text before carrying it as a path.
  if (server.includes(":") || (server.includes("@") && !WEBDAV_SERVER.test(server))) {
    refuse(input, "unc-credentials", "a user name or password in a network path");
  }
  if (server === "." || share === ".") refuse(input, "device-path", "a Windows device path");
  if (server === ".." || share === "..") refuse(input, "outside-root", ".. above the share");
  const segments = lexicalSegments(rest, input);
  return `\\\\${server}\\${share}${segments.length > 0 ? `\\${segments.join("\\")}` : ""}`;
}

function normalizePosix(path: string, input: string): string {
  if (/^[\\/]{2}[?.][\\/]/u.test(path)) refuse(input, "device-path", "a Windows device path");
  if (/^[\\/]{2}/u.test(path) || path.startsWith("\\") || DRIVE_ABSOLUTE.test(path)) refuse(input, "windows-path", "a Windows path");
  if (!path.startsWith("/")) refuse(input, "relative-path", "a relative path");
  return `/${lexicalSegments(path.slice(1).split("/"), input).join("/")}`;
}

interface SplitPath {
  root: string;
  segments: string[];
}

export function splitFolderPath(path: string, platform: NodeJS.Platform): SplitPath {
  if (platform === "win32") {
    if (path.startsWith("\\\\")) {
      const [server, share, ...rest] = path.slice(2).split("\\");
      return { root: `\\\\${server}\\${share}\\`, segments: rest.filter(Boolean) };
    }
    return { root: `${path.slice(0, 2)}\\`, segments: path.slice(3).split("\\").filter(Boolean) };
  }
  return { root: "/", segments: path.slice(1).split("/").filter(Boolean) };
}

export function joinFolderPath(split: SplitPath, platform: NodeJS.Platform): string {
  if (split.segments.length === 0) {
    // A share root is named without its trailing separator; a drive root and `/` keep theirs.
    return platform === "win32" && split.root.startsWith("\\\\") ? split.root.slice(0, -1) : split.root;
  }
  return `${split.root}${split.segments.join(platform === "win32" ? "\\" : "/")}`;
}

/** Unresolved subst chains count as network folders rather than guessing local. */
const MAX_SUBST_DEPTH = 8;

/** Query only drive mappings on Windows; unknown devices count as network.
 * Unix root counts as network because it contains automount roots. */
export async function classifyFolder(path: string, platform: NodeJS.Platform, fs: FolderFs): Promise<FolderNetwork> {
  const at = await networkLocation(path, platform, fs);
  if (at !== null) return { network: true, server: at.server };
  if (platform !== "win32" && path === "/") return { network: true, server: null };
  return { network: false };
}

interface NetworkLocation {
  key: string;
  server: string | null;
}

async function networkLocation(path: string, platform: NodeJS.Platform, fs: FolderFs): Promise<NetworkLocation | null> {
  if (platform === "win32") {
    if (path.startsWith("\\\\")) {
      const [server = "", share = ""] = path.slice(2).split("\\");
      return { key: `\\\\${server}\\${share}`.toLowerCase(), server: server === "" ? null : server };
    }
    const drive = path.slice(0, 2).toUpperCase();
    const network = await classifyDrive(drive, fs, 0, path);
    return network.network ? { key: drive, server: network.server } : null;
  }
  return automountLocation(path, platform);
}

/** Unknown mappings count as network; helper failure is an error, never a guessed classification. */
async function classifyDrive(drive: string, fs: FolderFs, depth: number, subject: string): Promise<FolderNetwork> {
  let mapping: string | null;
  try {
    mapping = await fs.queryDosDevice(drive);
  } catch (error) {
    throw new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `cannot classify ${subject}: ${errorMessage(error)}`, {
      cause: error,
      detail: { reason: "classifier-unavailable", path: subject },
    });
  }
  if (mapping === null) return { network: true, server: null };
  return classifyDosDeviceMapping(mapping, fs, depth, subject);
}

/** Only known local devices and subst chains ending at one count as local. */
export async function classifyDosDeviceMapping(mapping: string, fs: FolderFs, depth: number, subject: string): Promise<FolderNetwork> {
  if (/^\\Device\\(?:HarddiskVolume|CdRom|Floppy)\d+$/iu.test(mapping)) return { network: false };
  const subst = /^\\\?\?\\([A-Za-z]:)(?:\\.*)?$/su.exec(mapping);
  if (subst) return depth >= MAX_SUBST_DEPTH ? { network: true, server: null } : classifyDrive(subst[1]!.toUpperCase(), fs, depth + 1, subject);
  return { network: true, server: serverOfMapping(mapping) };
}

function serverOfMapping(mapping: string): string | null {
  const unc = /^\\\?\?\\UNC\\([^\\]+)/iu.exec(mapping);
  if (unc) return unc[1]!;
  const redirector = /^\\Device\\(?:Mup|LanmanRedirector|WebDavRedirector)\\(.*)$/isu.exec(mapping);
  if (!redirector) return null;
  // `;Z:0000…` and `;LanmanRedirector` are the redirector's own prefixes, not the server.
  const server = redirector[1]!.split("\\").find((segment) => segment !== "" && !segment.startsWith(";"));
  return server ? server.replace(/@(?:SSL)?(?:@?\d+)?$/iu, "") || null : null;
}

/** Classify automount paths lexically; fold case on macOS to catch equivalent spellings. */
function automountLocation(path: string, platform: NodeJS.Platform): NetworkLocation | null {
  const fold = (name: string) => (platform === "darwin" ? folded(name) : name);
  const [first, second, third] = path.split("/").filter(Boolean);
  if (first === undefined) return null;
  if (platform === "darwin" && fold(first) === "network") {
    if (second !== undefined && fold(second) === "servers" && third !== undefined) return { key: `/network/servers/${fold(third)}`, server: third };
    return { key: "/network", server: null };
  }
  if (fold(first) !== "net") return null;
  return second === undefined ? { key: "/net", server: null } : { key: `/net/${fold(second)}`, server: second };
}

/** Reject network link text before dereferencing it, including device and automount forms. */
export async function isNetworkLinkText(text: string, platform: NodeJS.Platform, fs: FolderFs): Promise<boolean> {
  const extendedDrive = /^(?:[\\/]{2}\?|\\\?\?)[\\/]([A-Za-z]:)(?:[\\/]|$)/u.exec(text);
  if (extendedDrive) return platform === "win32" ? (await classifyDrive(extendedDrive[1]!.toUpperCase(), fs, 0, text)).network : true;
  if (/^[\\/]{2}/u.test(text) || /^\\\?\?\\/u.test(text)) return true;
  if (platform === "win32") return DRIVE_ANY.test(text) ? (await classifyDrive(text.slice(0, 2).toUpperCase(), fs, 0, text)).network : false;
  return text.startsWith("/") && automountLocation(text, platform) !== null;
}

/** Relative links may leave their share; links remaining on the same network location do not. */
export async function linkLeavesForNetwork(linkDir: string, target: string, platform: NodeJS.Platform, fs: FolderFs): Promise<boolean> {
  const to = await networkLocation(target, platform, fs);
  if (to === null) return false;
  const from = await networkLocation(linkDir, platform, fs);
  return from === null || from.key !== to.key;
}

/** Classify every filesystem path before access and require network-folder consent.
 * Cache drive classification per fence; cross-network links remain forbidden even with consent. */
export function fenceFolderFs(fs: FolderFs, platform: NodeJS.Platform, consent: { consented: boolean; address: string }): FolderFs {
  if (consent.consented) return fs;
  const drives = new Map<string, Promise<string | null>>();
  const classifier: FolderFs = {
    ...fs,
    queryDosDevice: (drive) => {
      let answer = drives.get(drive);
      if (!answer) {
        answer = fs.queryDosDevice(drive);
        drives.set(drive, answer);
      }
      return answer;
    },
  };
  const check = async (path: string): Promise<void> => {
    const at = await networkLocation(path, platform, classifier);
    if (at === null) return;
    throw new ConfirmationRequiredError(`${path} is on another computer; reading ${consent.address} needs the network-folder confirmation`, [
      { warning: "network-folder", host: at.server, address: consent.address },
    ]);
  };
  return {
    ...classifier,
    lstat: async (path) => (await check(path), fs.lstat(path)),
    readlink: async (path) => (await check(path), fs.readlink(path)),
    readdir: async (path) => (await check(path), fs.readdir(path)),
    open: async (path) => (await check(path), fs.open(path)),
    fstat: (handle) => fs.fstat(handle),
    read: (handle, maxBytes) => fs.read(handle, maxBytes),
    close: (handle) => fs.close(handle),
  };
}

/** Resolve link text lexically with root clamping; drive-relative text cannot name a target. */
export function resolveLinkText(linkDir: string, text: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    const stripped = text.replace(/^(?:[\\/]{2}\?|\\\?\?)[\\/](?=[A-Za-z]:)/u, "");
    if (DRIVE_ABSOLUTE.test(stripped)) {
      return joinFolderPath({ root: `${stripped[0]!.toUpperCase()}:\\`, segments: lexicalSegments(stripped.slice(3).split(/[\\/]+/u), null) }, platform);
    }
    if (DRIVE_ANY.test(stripped)) return null;
    const base = splitFolderPath(linkDir, platform);
    // `\x` is the root of the link's own drive or share.
    const segments = /^[\\/]/u.test(stripped) ? [] : base.segments;
    return joinFolderPath({ root: base.root, segments: lexicalSegments([...segments, ...stripped.split(/[\\/]+/u)], null) }, platform);
  }
  if (text.startsWith("/")) return `/${lexicalSegments(text.slice(1).split("/"), null).join("/")}`;
  const base = splitFolderPath(linkDir, platform);
  return joinFolderPath({ root: "/", segments: lexicalSegments([...base.segments, ...text.split("/")], null) }, platform);
}

type UnreadableReason = MarketplaceErrorDetail<"SOURCE_LOCAL_UNREADABLE">["reason"];

export function folderUnreadable(path: string, error: unknown): MarketplaceError {
  if (error instanceof MarketplaceError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = errorMessage(error);
  const detail: MarketplaceErrorDetail<"SOURCE_LOCAL_UNREADABLE"> = code === "ENOENT"
    ? { reason: "not-found", path }
    : code === "ENOTDIR"
      ? { reason: "not-a-directory", path }
      : code === "EACCES" || code === "EPERM"
        ? { reason: "permission", path, message }
        : { reason: "io", path, message };
  return new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `${path}: ${message}`, { cause: error, detail });
}

export function unreadable(reason: Exclude<UnreadableReason, "permission" | "io" | "moved">, path: string, message: string): MarketplaceError;
export function unreadable(reason: "permission" | "io", path: string, message: string): MarketplaceError;
export function unreadable(reason: UnreadableReason, path: string, message: string): MarketplaceError {
  const detail = (reason === "permission" || reason === "io" ? { reason, path, message } : { reason, path }) as MarketplaceErrorDetail<"SOURCE_LOCAL_UNREADABLE">;
  return new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `${path}: ${message}`, { detail });
}

/** A changed directory identity is moved; never read the replacement at the stored path. */
export function folderMoved(path: string, target: string): MarketplaceError {
  return new MarketplaceError("SOURCE_LOCAL_UNREADABLE", `${path} now leads to ${target}, not the folder that was added`, {
    detail: { reason: "moved", path, target },
  });
}

function folded(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Prefer exact spelling; fold only when the volume resolves that spelling, rejecting ambiguous matches. */
async function onDiskSpelling(entries: readonly string[], name: string, at: string, folder: string, platform: NodeJS.Platform, fs: FolderFs): Promise<string> {
  if (entries.includes(name)) return name;
  try {
    await fs.lstat(at);
  } catch (error) {
    // A refusal (the network fence) is the caller's.
    if (error instanceof MarketplaceError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") throw unreadable("not-found", folder, `${at} does not exist`);
    throw folderUnreadable(folder, error);
  }
  const wanted = folded(name);
  const matches = entries.filter((entry) => folded(entry) === wanted);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw unreadable("ambiguous-case", folder, `${at} matches ${matches.length} entries that differ only in case`);
  const long = await shortNameSpelling(entries, name, at, platform, fs);
  if (long !== null) return long;
  throw unreadable("not-found", folder, `${at} does not exist`);
}

/** Windows short names are absent from readdir; match dev and ino to recover the long spelling. */
async function shortNameSpelling(entries: readonly string[], name: string, at: string, platform: NodeJS.Platform, fs: FolderFs): Promise<string | null> {
  if (platform !== "win32" || !name.includes("~")) return null;
  let alias: FolderStat;
  try {
    alias = await fs.lstat(at);
  } catch (error) {
    // A refusal (the network fence) is the caller's; only the OS's "not there" means no alias.
    if (error instanceof MarketplaceError) throw error;
    return null;
  }
  if (alias.ino === 0n) return null;
  const parent = at.slice(0, at.length - name.length);
  for (const entry of entries) {
    let stat: FolderStat;
    try {
      stat = await fs.lstat(`${parent}${entry}`);
    } catch (error) {
      if (error instanceof MarketplaceError) throw error;
      continue;
    }
    if (stat.dev === alias.dev && stat.ino === alias.ino) return entry;
  }
  return null;
}


/** Walk with fenced lstat calls to recover spelling and identity without ungated realpath access.
 * Network link targets are rejected before access; marketplace.json selects its parent directory. */
export async function resolveFolderRoot(path: string, platform: NodeJS.Platform, unfenced: FolderFs, networkConsented: boolean): Promise<FolderRoot> {
  const fs = fenceFolderFs(unfenced, platform, { consented: networkConsented, address: path });
  const start = splitFolderPath(path, platform);
  let current: SplitPath = { root: start.root, segments: [] };
  let queue = [...start.segments];
  let links = 0;
  const lstatAt = async (at: string): Promise<FolderStat> => {
    try {
      return await fs.lstat(at);
    } catch (error) {
      throw folderUnreadable(path, error);
    }
  };
  let last = await lstatAt(joinFolderPath(current, platform));
  if (last.kind !== "directory") throw unreadable("not-a-directory", path, `${current.root} is not a directory`);
  let chain: FolderIdentity[] = [last];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const dir = joinFolderPath(current, platform);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      throw folderUnreadable(path, error);
    }
    const spelled = await onDiskSpelling(entries, name, joinFolderPath({ root: current.root, segments: [...current.segments, name] }, platform), path, platform, fs);
    const next: SplitPath = { root: current.root, segments: [...current.segments, spelled] };
    const candidate = joinFolderPath(next, platform);
    const entry = await lstatAt(candidate);
    if (entry.kind === "link") {
      links += 1;
      if (links > MAX_LINKS_PER_RESOLUTION) throw unreadable("io", path, `more than ${MAX_LINKS_PER_RESOLUTION} links: a link loop`);
      let text: string;
      try {
        text = await fs.readlink(candidate);
      } catch (error) {
        throw folderUnreadable(path, error);
      }
      const target = resolveLinkText(dir, text, platform);
      if ((await isNetworkLinkText(text, platform, fs)) || (target !== null && (await linkLeavesForNetwork(dir, target, platform, fs)))) {
        throw new MarketplaceError("CONTENT_RULE_VIOLATION", `${candidate} links to a network location (${text})`, {
          detail: { reason: "link-to-network", path: candidate, target: text },
        });
      }
      if (target === null) throw unreadable("io", path, `${candidate} links to ${text}, which names no folder here`);
      const split = splitFolderPath(target, platform);
      current = { root: split.root, segments: [] };
      queue = [...split.segments, ...queue];
      last = await lstatAt(joinFolderPath(current, platform));
      chain = [last];
      continue;
    }
    if (entry.kind === "directory") {
      current = next;
      last = entry;
      chain = [...chain, entry];
      continue;
    }
    if (entry.kind === "file" && queue.length === 0 && spelled === MARKETPLACE_INDEX_FILE) break;
    throw unreadable("not-a-directory", path, `${candidate} is not a folder`);
  }
  const identity = ({ dev, ino }: FolderIdentity): FolderIdentity => ({ dev, ino });
  return { path: joinFolderPath(current, platform), dev: last.dev, ino: last.ino, ancestors: chain.slice(0, -1).map(identity) };
}
