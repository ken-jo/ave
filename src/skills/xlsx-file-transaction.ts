import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { XLSX_EDIT_LIMITS } from "../shared/xlsx-panel-edit.js";

export interface WorkbookFileSnapshot { data: Buffer; identity: fs.BigIntStats }
export interface WorkbookEditIo {
  write?: (descriptor: number, bytes: Buffer, offset: number, length: number) => number;
  /** Host callers revalidate their bound authority here; shell callers retain their existing admission. */
  assertCurrent?: () => void;
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
    const parent = fs.realpathSync(dirname(path));
    const identity = fs.lstatSync(parent, { bigint: true });
    if (parent !== location.parent || join(parent, basename(path)) !== location.path || !identity.isDirectory()
      || identity.dev !== location.identity.dev || identity.ino !== location.identity.ino
      || identity.mode !== location.identity.mode) stale();
  } catch { stale(); }
}

/** Trusted readers supply bytes checked against the given descriptor and parent identities; retain this object unchanged. */
export function createWorkbookFileSnapshot(path: string, data: Buffer, identity: fs.BigIntStats,
  parentIdentity: fs.BigIntStats): WorkbookFileSnapshot {
  path = resolve(path);
  requireCondition(extname(path).toLowerCase() === ".xlsx", "Only .xlsx files can be edited.");
  requireCondition(Buffer.isBuffer(data) && data.length <= XLSX_EDIT_LIMITS.maxFileBytes
    && BigInt(data.length) === identity.size, "Invalid workbook snapshot size.");
  requireCondition(identity.isFile() && identity.nlink === 1n && parentIdentity.isDirectory(), "Invalid workbook snapshot identity.");
  const parent = fs.realpathSync(dirname(path));
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
  const parent = fs.realpathSync(dirname(path));
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
function temporaryFile(path: string): { path: string; descriptor: number } {
  const temporary = join(dirname(path), `.ave-xlsx-${randomBytes(12).toString("hex")}.tmp`);
  return { path: temporary, descriptor: fs.openSync(temporary, "wx", 0o600) };
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
  io.assertCurrent?.();
  checkSource(path, snapshot, location);
  const requestedPath = path;
  const backupPath = `${path}.ave-bak`;
  path = location.path;
  let backup: string | null = null;
  if (snapshot.data.length > XLSX_EDIT_LIMITS.backupBytes) {
    backup = backupPath;
    const staged = temporaryFile(path);
    try {
      try { writeAndSync(staged.descriptor, snapshot.data, io); } finally { fs.closeSync(staged.descriptor); }
      verifyStagedBytes(staged.path, snapshot.data, "Backup verification failed.");
      io.assertCurrent?.();
      checkSource(requestedPath, snapshot, location);
      fs.linkSync(staged.path, `${location.path}.ave-bak`);
    } finally { fs.unlinkSync(staged.path); }
  }
  io.assertCurrent?.();
  checkSource(requestedPath, snapshot, location);
  const staged = temporaryFile(path);
  try {
    try { writeAndSync(staged.descriptor, output, io); } finally { fs.closeSync(staged.descriptor); }
    verifyStagedBytes(staged.path, output, "Output verification failed.");
    fs.chmodSync(staged.path, Number(snapshot.identity.mode & 0o7777n));
    replaceStagedFile(staged.path, path, undefined, () => {
      io.assertCurrent?.();
      checkSource(requestedPath, snapshot, location);
    });
  } finally { if (fs.existsSync(staged.path)) fs.unlinkSync(staged.path); }
  return { editedCells, needsRecalculation: true, backup };
}
