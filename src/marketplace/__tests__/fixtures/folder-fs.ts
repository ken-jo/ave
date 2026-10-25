/** Records filesystem calls and models link-following and case sensitivity. */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { isMarketplaceError, type MarketplaceError } from "../../errors.js";
import { joinFolderPath, resolveLinkText, splitFolderPath } from "../../net/source-input.js";
import { createNodeFolderFs, type FolderFileHandle, type FolderFs, type FolderStat } from "../../sources/folder-fs.js";

export const TEST_FOLDER_LIMITS = {
  maxFiles: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxEntryCount,
  maxBytes: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS.maxTotalUncompressedBytes,
};

/** Only the system temp drive is modeled as local; other drives fail the test. */
export function nodeFolders(platform: NodeJS.Platform = process.platform) {
  const tempDrive = tmpdir().slice(0, 2).toUpperCase();
  return {
    fs: createNodeFolderFs({
      platform,
      queryDosDevice: async (drive: string): Promise<string | null> => {
        if (drive.toUpperCase() === tempDrive) return "\\Device\\HarddiskVolume1";
        throw new Error(`no drive mapping in tests: ${drive}`);
      },
    }),
    platform,
    limits: TEST_FOLDER_LIMITS,
  };
}

export function writeFolderFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export async function marketplaceRefusal(run: Promise<unknown>): Promise<MarketplaceError> {
  try {
    await run;
  } catch (error) {
    if (isMarketplaceError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** `unlisted`: a Windows 8.3 short name, reachable by name but never listed by `readdir`. */
type Node = (
  | { kind: "directory"; name: string; ino: bigint; children: Map<string, Node> }
  | { kind: "file"; name: string; ino: bigint; data: Buffer; executable: boolean }
  | { kind: "link"; name: string; ino: bigint; text: string }
  | { kind: "special"; name: string; ino: bigint }
) & { unlisted?: true };

export interface FolderCall {
  op: "lstat" | "readlink" | "readdir" | "open" | "fstat" | "read" | "close" | "queryDosDevice";
  path: string;
}

interface FakeHandle extends FolderFileHandle {
  node: Node & { kind: "file" };
}

function fsError(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export class FakeVolume implements FolderFs {
  readonly calls: FolderCall[] = [];
  /** Runs before each call is answered, after it is recorded: a test swaps entries here. */
  hook: ((call: FolderCall) => void) | null = null;
  private readonly roots = new Map<string, Node & { kind: "directory" }>();
  private nextIno = 100n;
  readonly caseSensitive: boolean;
  readonly dev: bigint;
  private readonly drives: Record<string, string>;
  private readonly failing = new Map<string, string>();

  constructor(
    readonly platform: NodeJS.Platform,
    options: { caseSensitive?: boolean; dev?: bigint; drives?: Record<string, string> } = {},
  ) {
    this.caseSensitive = options.caseSensitive ?? platform !== "win32";
    this.dev = options.dev ?? 7n;
    this.drives = options.drives ?? {};
  }

  private root(root: string): Node & { kind: "directory" } {
    const key = this.caseSensitive ? root : root.toLowerCase();
    let node = this.roots.get(key);
    if (!node) {
      node = { kind: "directory", name: root, ino: this.nextIno++, children: new Map() };
      this.roots.set(key, node);
    }
    return node;
  }

  private key(name: string): string {
    return this.caseSensitive ? name : name.toLowerCase();
  }

  /** Creates parents without traversing links. */
  private parentOf(path: string): { parent: Node & { kind: "directory" }; name: string } {
    const split = splitFolderPath(path, this.platform);
    let dir = this.root(split.root);
    const segments = split.segments;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.children.get(this.key(segment));
      if (!next) {
        next = { kind: "directory", name: segment, ino: this.nextIno++, children: new Map() };
        dir.children.set(this.key(segment), next);
      }
      if (next.kind !== "directory") throw new Error(`fixture: ${segment} in ${path} is not a directory`);
      dir = next;
    }
    const name = segments[segments.length - 1];
    if (name === undefined) throw new Error(`fixture: ${path} names a root`);
    return { parent: dir, name };
  }

  private put(path: string, make: (name: string, ino: bigint) => Node): this {
    const { parent, name } = this.parentOf(path);
    parent.children.set(this.key(name), make(name, this.nextIno++));
    return this;
  }

  dir(path: string): this {
    return this.put(path, (name, ino) => ({ kind: "directory", name, ino, children: new Map() }));
  }

  file(path: string, data: string | Buffer, options: { executable?: boolean } = {}): this {
    return this.put(path, (name, ino) => ({ kind: "file", name, ino, data: Buffer.from(data), executable: options.executable ?? false }));
  }

  link(path: string, text: string): this {
    return this.put(path, (name, ino) => ({ kind: "link", name, ino, text }));
  }

  special(path: string): this {
    return this.put(path, (name, ino) => ({ kind: "special", name, ino }));
  }

  remove(path: string): this {
    const { parent, name } = this.parentOf(path);
    parent.children.delete(this.key(name));
    return this;
  }

  /** Both paths share one node, as with a hard link. */
  alias(path: string, existing: string): this {
    const node = this.walk(existing, true, 0);
    const { parent, name } = this.parentOf(path);
    parent.children.set(this.key(name), { ...node, name } as Node);
    return this;
  }

  /** A short-name alias that readdir does not list. */
  shortName(path: string, existing: string): this {
    const node = this.walk(existing, false, 0);
    const { parent, name } = this.parentOf(path);
    parent.children.set(this.key(name), { ...node, name, unlisted: true } as Node);
    return this;
  }

  fail(path: string, code: string): this {
    this.failing.set(path, code);
    return this;
  }

  paths(op?: FolderCall["op"]): string[] {
    return this.calls.filter((call) => op === undefined || call.op === op).map((call) => call.path);
  }

  private walk(path: string, followFinal: boolean, depth: number): Node {
    if (depth > 64) throw fsError("ELOOP", path);
    const split = splitFolderPath(path, this.platform);
    const root = this.roots.get(this.key(split.root));
    if (!root) throw fsError("ENOENT", path);
    let node: Node = root;
    for (const [index, segment] of split.segments.entries()) {
      if (node.kind !== "directory") throw fsError("ENOTDIR", path);
      const child: Node | undefined = node.children.get(this.key(segment));
      if (!child) throw fsError("ENOENT", path);
      const final = index === split.segments.length - 1;
      if (child.kind === "link" && (!final || followFinal)) {
        const dir = joinFolderPath({ root: split.root, segments: split.segments.slice(0, index) }, this.platform);
        const target = resolveLinkText(dir, child.text, this.platform);
        if (target === null) throw fsError("ENOENT", path);
        const rest = split.segments.slice(index + 1);
        const targetSplit = splitFolderPath(target, this.platform);
        return this.walk(joinFolderPath({ root: targetSplit.root, segments: [...targetSplit.segments, ...rest] }, this.platform), followFinal, depth + 1);
      }
      node = child;
    }
    return node;
  }

  private stat(node: Node): FolderStat {
    return {
      kind: node.kind,
      dev: this.dev,
      ino: node.ino,
      size: node.kind === "file" ? node.data.length : 0,
      executable: node.kind === "file" && this.platform !== "win32" && node.executable,
    };
  }

  private record(op: FolderCall["op"], path: string): void {
    const call = { op, path };
    this.calls.push(call);
    this.hook?.(call);
    const code = this.failing.get(path);
    if (code !== undefined && op !== "queryDosDevice") throw fsError(code, path);
  }

  async lstat(path: string): Promise<FolderStat> {
    this.record("lstat", path);
    return this.stat(this.walk(path, false, 0));
  }

  async readlink(path: string): Promise<string> {
    this.record("readlink", path);
    const node = this.walk(path, false, 0);
    if (node.kind !== "link") throw fsError("EINVAL", path);
    return node.text;
  }

  async readdir(path: string): Promise<string[]> {
    this.record("readdir", path);
    const node = this.walk(path, true, 0);
    if (node.kind !== "directory") throw fsError("ENOTDIR", path);
    return [...node.children.values()].filter((child) => !child.unlisted).map((child) => child.name);
  }

  async open(path: string): Promise<FolderFileHandle> {
    this.record("open", path);
    // O_NOFOLLOW on macOS and Linux; Windows follows a final reparse point.
    const node = this.walk(path, this.platform === "win32", 0);
    if (node.kind === "link") throw fsError("ELOOP", path);
    if (node.kind === "directory") throw fsError("EISDIR", path);
    if (node.kind !== "file") throw fsError("ENXIO", path);
    const handle: FakeHandle = { path, node };
    return handle;
  }

  async fstat(handle: FolderFileHandle): Promise<FolderStat> {
    this.record("fstat", handle.path);
    return this.stat((handle as FakeHandle).node);
  }

  async read(handle: FolderFileHandle, maxBytes: number): Promise<Buffer> {
    this.record("read", handle.path);
    return (handle as FakeHandle).node.data.subarray(0, maxBytes + 1);
  }

  async close(handle: FolderFileHandle): Promise<void> {
    this.record("close", handle.path);
  }

  async queryDosDevice(drive: string): Promise<string | null> {
    this.record("queryDosDevice", drive);
    return this.drives[drive.toUpperCase()] ?? null;
  }
}
