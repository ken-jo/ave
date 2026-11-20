import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertAveHomeRuntimeBoundary, AVE_HOME_RUNTIME_DIRECTORY, getAveHomePrivacyFailure, posixHomeProtectionFailure } from "../shared/ave-home.js";
import { createNamespaceRecordSync, openFeatureNamespace, syncNamespaceDirectorySync } from "../main/storage/feature-namespace.js";
import { fileIdentityKey, sameFileIdentity } from "../lib/file-identity.js";
import { _srtWinLedgerRootForTest } from "./srt-win-copy-owner.js";

const namespace = openFeatureNamespace(AVE_HOME_RUNTIME_DIRECTORY);
const RECORD_NAME = /^srt-win-allocation-([a-f0-9]{32})\.jsonl$/u;
const ID = /^[a-f0-9]{32}$/u;
const IDENTITY = /^[0-9]+:[1-9][0-9]*:-?[0-9]+$/u;

export interface SrtWinAllocation {
  readonly record: string;
  readonly id: string;
  readonly pid: number;
  readonly path: string;
  readonly retired: string;
  identity?: string;
  disposing: boolean;
}

function ledgerRoot(): string {
  const fixture = _srtWinLedgerRootForTest();
  if (fixture !== undefined) return fixture;
  const dir = namespace.dir;
  const home = dirname(dir);
  if (getAveHomePrivacyFailure() !== undefined || posixHomeProtectionFailure(home) !== undefined) {
    throw new Error("Helper allocation ledger requires a protected home");
  }
  assertAveHomeRuntimeBoundary();
  const directory = lstatSync(dir);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || (uid !== undefined && (directory.uid !== uid || (directory.mode & 0o077) !== 0))) {
    throw new Error("Helper allocation ledger is outside private storage");
  }
  return dir;
}

export function allocationIdentity(info: BigIntStats): string {
  if (info.ino === 0n) throw new Error("Private helper identity unavailable");
  return `${fileIdentityKey(info)}:${info.birthtimeNs}`;
}

export function beginSrtWinAllocation(id: string, path: string, retired: string): SrtWinAllocation {
  const dir = ledgerRoot();
  const name = `srt-win-allocation-${id}.jsonl`;
  const initial = { id, path, retired, pid: process.pid };
  const fd = createNamespaceRecordSync({ dir }, name);
  try {
    writeRecordLine(fd, JSON.stringify(initial));
  } finally { closeSync(fd); }
  syncNamespaceDirectorySync({ dir });
  return { ...initial, record: join(dir, name), disposing: false };
}

function openRecord(path: string, flags: number): number {
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile() || named.nlink !== 1n) throw new Error("Invalid helper allocation record");
  const fd = openSync(path, flags | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    if (!sameFileIdentity(named, fstatSync(fd, { bigint: true }))) throw new Error("Helper allocation record changed");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function append(record: string, data: string): void {
  const fd = openRecord(record, constants.O_WRONLY | constants.O_APPEND);
  try {
    writeRecordLine(fd, data);
  } finally { closeSync(fd); }
}

function writeRecordLine(fd: number, line: string): void {
  const bytes = Buffer.from(`${line}\n`);
  if (writeSync(fd, bytes) !== bytes.length) throw new Error("Incomplete helper allocation record");
  fsyncSync(fd);
}

export function confirmSrtWinAllocation(allocation: SrtWinAllocation, identity: string): void {
  append(allocation.record, `outer ${identity}`);
  allocation.identity = identity;
}

export function retireSrtWinAllocation(allocation: SrtWinAllocation): void {
  if (allocation.disposing) return;
  append(allocation.record, "dispose");
  allocation.disposing = true;
}

export function forgetSrtWinAllocation(allocation: SrtWinAllocation): void {
  try { unlinkSync(allocation.record); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  syncNamespaceDirectorySync({ dir: dirname(allocation.record) });
}

function readAllocation(record: string, id: string): SrtWinAllocation | undefined {
  const fd = openRecord(record, constants.O_RDONLY);
  let content: string;
  try { content = readFileSync(fd, "utf8"); }
  finally { closeSync(fd); }
  // Only completed journal records can confer ownership.
  const lines = content.split("\n");
  lines.pop();
  if (lines.length === 0) return undefined;
  const plan = JSON.parse(lines[0] ?? "");
  if (plan?.id !== id || typeof plan.path !== "string" || !isAbsolute(plan.path) || resolve(plan.path) !== plan.path
    || basename(plan.path) !== `ave-srt-win-${id}` || typeof plan.retired !== "string" || dirname(plan.retired) !== dirname(plan.path)
    || !basename(plan.retired).startsWith(`${basename(plan.path)}.delete-`) || !ID.test(plan.retired.slice(-32))
    || plan.retired.length !== plan.path.length + 40 || !Number.isSafeInteger(plan.pid) || plan.pid <= 0) return undefined;
  const allocation: SrtWinAllocation = { id, path: plan.path, retired: plan.retired, pid: plan.pid, record, disposing: false };
  for (const line of lines.slice(1)) {
    if (line === "dispose") { allocation.disposing = true; continue; }
    if (!line.startsWith("outer ") || allocation.identity !== undefined || !IDENTITY.test(line.slice(6))) return undefined;
    allocation.identity = line.slice(6);
  }
  return allocation;
}

export function srtWinAllocations(): SrtWinAllocation[] {
  const dir = ledgerRoot();
  const allocations: SrtWinAllocation[] = [];
  for (const name of readdirSync(dir)) {
    const id = RECORD_NAME.exec(name)?.[1];
    if (id === undefined) continue;
    try {
      const allocation = readAllocation(join(dir, name), id);
      if (allocation !== undefined) allocations.push(allocation);
    } catch { /* An unverified record never authorizes deletion. */ }
  }
  return allocations;
}

export function allocationOwnerIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
