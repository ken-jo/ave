import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, extname, join, resolve, win32 } from "node:path";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { XLSX_EDIT_LIMITS } from "../shared/xlsx-edit.js";

export interface WorkbookFileSnapshot { data: Buffer; identity: fs.BigIntStats }
export interface WorkbookEditIo {
  write?: (descriptor: number, bytes: Buffer, offset: number, length: number) => number;
  readAccessRules?: WindowsAccessRulesReader;
}
export interface WorkbookEditResult { editedCells: number; needsRecalculation: true; backup: string | null }

interface WorkbookLocation { path: string; parent: string; identity: fs.BigIntStats }
const snapshotLocations = new WeakMap<WorkbookFileSnapshot, WorkbookLocation>();

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"] as const).every((key) => left[key] === right[key]);
}
function stale(): never {
  throw Object.assign(new Error("Workbook changed before publication."), { code: "ESTALE" });
}
function checkParent(path: string, location: WorkbookLocation): void {
  try {
    const parent = fs.realpathSync.native(dirname(path));
    const identity = fs.lstatSync(parent, { bigint: true });
    if (parent !== location.parent || join(parent, basename(path)) !== location.path || !identity.isDirectory()
      || identity.dev !== location.identity.dev || identity.ino !== location.identity.ino
      || identity.mode !== location.identity.mode) stale();
  } catch { stale(); }
}

function createWorkbookFileSnapshot(path: string, data: Buffer, identity: fs.BigIntStats,
  parentIdentity: fs.BigIntStats): WorkbookFileSnapshot {
  path = resolve(path);
  requireCondition(extname(path).toLowerCase() === ".xlsx", "Only .xlsx files can be edited.");
  requireCondition(Buffer.isBuffer(data) && data.length <= XLSX_EDIT_LIMITS.maxFileBytes
    && BigInt(data.length) === identity.size, "Invalid workbook snapshot size.");
  requireCondition(identity.isFile() && identity.nlink === 1n && parentIdentity.isDirectory(), "Invalid workbook snapshot identity.");
  const parent = fs.realpathSync.native(dirname(path));
  const location = { path: join(parent, basename(path)), parent, identity: parentIdentity };
  checkParent(path, location);
  if (!sameIdentity(identity, fs.lstatSync(location.path, { bigint: true }))) stale();
  const snapshot = { data, identity };
  snapshotLocations.set(snapshot, location);
  return snapshot;
}

/** Reads bounded source bytes and binds their descriptor identity to a canonical parent. */
export function readWorkbookSnapshot(path: string): WorkbookFileSnapshot {
  path = resolve(path);
  requireCondition(extname(path).toLowerCase() === ".xlsx", "Only .xlsx files can be edited.");
  const parent = fs.realpathSync.native(dirname(path));
  const location = { path: join(parent, basename(path)), parent, identity: fs.lstatSync(parent, { bigint: true }) };
  requireCondition(location.identity.isDirectory(), "Workbook parent must be a directory.");
  const before = fs.lstatSync(location.path, { bigint: true });
  requireCondition(before.isFile() && before.nlink === 1n, "Workbook must be a singly linked regular file.");
  requireCondition(before.size <= BigInt(XLSX_EDIT_LIMITS.maxFileBytes), "Workbook exceeds 20 MiB.");
  const descriptor = fs.openSync(location.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let data: Buffer;
  try {
    requireCondition(sameIdentity(before, fs.fstatSync(descriptor, { bigint: true })), "Workbook changed before reading.");
    data = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, null);
      if (!count) break;
      offset += count;
    }
    requireCondition(offset === Number(before.size) && sameIdentity(before, fs.fstatSync(descriptor, { bigint: true }))
      && sameIdentity(before, fs.lstatSync(location.path, { bigint: true })), "Workbook changed while reading.");
    data = data.subarray(0, offset);
  } finally { fs.closeSync(descriptor); }
  checkParent(path, location);
  return createWorkbookFileSnapshot(path, data, before, location.identity);
}

function checkSource(path: string, snapshot: WorkbookFileSnapshot, location: WorkbookLocation): void {
  checkParent(path, location);
  try {
    const current = readWorkbookSnapshot(path);
    if (!sameIdentity(snapshot.identity, current.identity) || !current.data.equals(snapshot.data)) stale();
  } catch { stale(); }
  checkParent(path, location);
}
function temporaryFile(path: string): { path: string; descriptor: number; identity: fs.BigIntStats } {
  const temporary = join(dirname(path), `.ave-xlsx-${randomBytes(12).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { return { path: temporary, descriptor, identity: fs.fstatSync(descriptor, { bigint: true }) }; }
  catch (error) { fs.closeSync(descriptor); fs.unlinkSync(temporary); throw error; }
}
function writeAndSync(descriptor: number, bytes: Buffer, io: WorkbookEditIo): void {
  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(64 * 1024, bytes.length - offset);
    const written = (io.write ?? fs.writeSync)(descriptor, bytes, offset, length);
    requireCondition(Number.isInteger(written) && written > 0 && written <= length, "Incomplete file write.");
    offset += written;
  }
  fs.fsyncSync(descriptor);
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function verifyStagedBytes(path: string, bytes: Buffer, message: string): void {
  const saved = fs.readFileSync(path);
  requireCondition(saved.length === bytes.length && sha256(saved) === sha256(bytes), message);
}

const ACCESS_RULES_SCRIPT = "$ErrorActionPreference = 'Stop'; foreach ($path in @($env:AVE_XLSX_ACCESS_SOURCE, $env:AVE_XLSX_ACCESS_COPY)) "
  + "{ (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm('Access') }";
const ACCESS_RULES_REFUSALS = {
  backup: { text: "The workbook has its own access rules; Ave cannot keep them on its backup.", differs: "backup-acl-differs", unreadable: "backup-acl-unreadable" },
  workbook: { text: "The workbook has its own access rules; Ave cannot keep them on the edited file.", differs: "workbook-acl-differs", unreadable: "workbook-acl-unreadable" },
} as const;

/** Windows access lists in SDDL, source first. Any failure or malformed answer is no answer. */
type WindowsAccessRulesReader = (source: string, copy: string) => readonly string[];
const readWindowsAccessRules: WindowsAccessRulesReader = (source, copy) => {
  // Node exposes the Windows directory only through the environment.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const shell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(ACCESS_RULES_SCRIPT, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, AVE_XLSX_ACCESS_SOURCE: source, AVE_XLSX_ACCESS_COPY: copy },
  });
  return output.split(/\r?\n/).filter((line) => line.length > 0);
};

function accessRulesRefusal(kind: keyof typeof ACCESS_RULES_REFUSALS, reason: "differs" | "unreadable"): Error {
  const refusal = ACCESS_RULES_REFUSALS[kind];
  return Object.assign(new Error(`${refusal.text} [${refusal[reason]}]`), { code: refusal[reason] });
}

/** A created file only inherits its folder's access list; before any byte lands in it, it must equal the workbook's. */
function requireSameAccessRules(kind: keyof typeof ACCESS_RULES_REFUSALS, source: string, copy: string, io: WorkbookEditIo): void {
  if (process.platform !== "win32") return;
  let rules: readonly string[];
  try { rules = (io.readAccessRules ?? readWindowsAccessRules)(source, copy); } catch { throw accessRulesRefusal(kind, "unreadable"); }
  if (rules.length !== 2 || !rules.every((rule) => rule.startsWith("D:"))) throw accessRulesRefusal(kind, "unreadable");
  if (rules[0] !== rules[1]) throw accessRulesRefusal(kind, "differs");
}

/** Exclusive create keeps any existing entry, links included, and needs no hard-link right. A copy that fails verification is removed. */
function writeRecoveryCopy(source: string, path: string, bytes: Buffer, io: WorkbookEditIo, verifySource: () => void): void {
  if (fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw Object.assign(new Error(`Recovery path already exists: ${path}`), { code: "EEXIST" });
  }
  const descriptor = fs.openSync(path, "wx", 0o600);
  let created: fs.BigIntStats | undefined;
  try {
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const named = fs.lstatSync(path, { bigint: true });
      requireCondition(named.isFile() && named.dev === opened.dev && named.ino === opened.ino, "Recovery path changed while opening.");
      created = opened;
      requireSameAccessRules("backup", source, path, io);
      writeAndSync(descriptor, bytes, io);
    } finally { fs.closeSync(descriptor); }
    verifyStagedBytes(path, bytes, "Backup verification failed.");
    verifySource();
  } catch (error) {
    try {
      const current = fs.lstatSync(path, { bigint: true });
      if (created && current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(path);
    } catch { /* leave whatever now holds the name */ }
    throw error;
  }
}

/** Callers validate the output package before publication. A completed recovery copy remains on later failure.
 * The final path check and rename still have a same-user race; this is not a power-loss transaction. */
export function publishWorkbookEdit(path: string, snapshot: WorkbookFileSnapshot, output: Buffer,
  editedCells: number, io: WorkbookEditIo = {}): WorkbookEditResult {
  path = resolve(path);
  const location = snapshotLocations.get(snapshot);
  requireCondition(location, "Workbook snapshot has no bound parent identity.");
  requireCondition(Buffer.isBuffer(output) && output.length > 0 && output.length <= XLSX_EDIT_LIMITS.maxFileBytes,
    "Edited workbook exceeds the file limit.");
  requireCondition(Number.isSafeInteger(editedCells) && editedCells > 0 && editedCells <= 500, "Invalid edit count.");
  checkSource(path, snapshot, location);
  const requestedPath = path;
  const backupPath = `${path}.ave-bak`;
  path = location.path;
  let backup: string | null = null;
  if (snapshot.data.length > XLSX_EDIT_LIMITS.backupBytes) {
    backup = backupPath;
    checkSource(requestedPath, snapshot, location);
    writeRecoveryCopy(location.path, `${location.path}.ave-bak`, snapshot.data, io, () => checkSource(requestedPath, snapshot, location));
  }
  checkSource(requestedPath, snapshot, location);
  const staged = temporaryFile(path);
  try {
    try {
      requireSameAccessRules("workbook", path, staged.path, io);
      writeAndSync(staged.descriptor, output, io);
    } finally { fs.closeSync(staged.descriptor); }
    verifyStagedBytes(staged.path, output, "Output verification failed.");
    fs.chmodSync(staged.path, Number(snapshot.identity.mode & 0o7777n));
    replaceStagedFile(staged.path, path, undefined, () => {
      checkSource(requestedPath, snapshot, location);
    });
  } finally {
    const current = fs.lstatSync(staged.path, { bigint: true, throwIfNoEntry: false });
    if (current?.dev === staged.identity.dev && current.ino === staged.identity.ino) fs.unlinkSync(staged.path);
  }
  return { editedCells, needsRecalculation: true, backup };
}
