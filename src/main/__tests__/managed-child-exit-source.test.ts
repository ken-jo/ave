import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Missing source section: ${from}`);
  return source.slice(start, end);
}

function appearsInOrder(source: string, ...fragments: string[]): boolean {
  let previous = -1;
  for (const fragment of fragments) {
    const position = source.indexOf(fragment);
    if (position <= previous) return false;
    previous = position;
  }
  return true;
}

const offline = readRepoFile("src/permissions/offline-process-sandbox.ts");
const scanner = section(offline, "async function runOfflineScan", "function within");
const confirmScanner = "if (!confirmed) throw new OfflineScanExitUnconfirmedError()";
const returnScan = "if (scan.ok) return scan.value";

function scannerWaitsForVerdict(source: string): boolean {
  return appearsInOrder(source, "const child = start(acquired =>", "acquired.once(\"close\"", "observeManagedWindowsJobExit(acquired",
    "await waitForManagedProcessGroupExit", confirmScanner, returnScan);
}

describe("managed process exit source contracts", () => {
  it("acquires the scanner and waits on the managed verdict before success or scratch cleanup", () => {
    expect(scanner.match(/\bspawnManaged\(/gu)).toHaveLength(2);
    expect(scanner.match(/\brunWithCeiling\(/gu)).toHaveLength(1);
    expect(scannerWaitsForVerdict(scanner)).toBe(true);
    expect(appearsInOrder(offline, "await runOfflineScan", "if (error instanceof OfflineScanExitUnconfirmedError)",
      "if (!unconfirmedExit) await rm(scanDirectory", "throw unconfirmedExit ?? error")).toBe(true);
  });

  it("rejects a scanner that returns success ahead of the termination verdict", () => {
    const earlyReturn = scanner.replace(confirmScanner, `${returnScan};\n    ${confirmScanner}`);
    expect(earlyReturn).not.toBe(scanner);
    expect(scannerWaitsForVerdict(earlyReturn)).toBe(false);
  });

  it("acquires the managed process before registering it and requires group absence", () => {
    const managed = readRepoFile("src/main/managed-child-processes.ts");
    const launch = section(managed, "export function spawnManaged(", "export function trackManagedChildProcess");
    expect(appearsInOrder(launch, "assertManagedChildProcessAdmissionOpen(label)", "const child = spawn(",
      "onSpawn?.(child)", "trackChild(child", "return child")).toBe(true);
    const posix = section(managed, "export async function waitForManagedProcessGroupExit", "export function forceKillManagedChildProcess");
    expect(appearsInOrder(posix, "await closed", "while (processExists(-pid))", "return result.ok")).toBe(true);
  });

  it("requires managed launch for direct hooks and group confirmation on the POSIX path", () => {
    const hook = readRepoFile("src/hooks/script-hook-runner.ts");
    expect(hook).not.toMatch(/\bspawn\(/u);
    const group = section(hook, "async function runPosixHook", "async function runContainedHook");
    const afterAcquisition = group.slice(group.indexOf("const { child, closed } = owned"));
    expect(appearsInOrder(afterAcquisition, "if (!await waitForManagedProcessGroupExit", "terminationUnverified",
      "input.release()", "return input.outcome")).toBe(true);
  });

  it("registers the confined relay child before starting its handshake", () => {
    const confined = readRepoFile("src/permissions/confined-child.ts");
    const launch = section(confined, "export async function spawnConfinedChild", "function assertRelayableSpec");
    expect(appearsInOrder(launch, "assertStillValid();", "child = spawn(program", "trackManagedChildProcess(child",
      "relayStdioOverLoopback(")).toBe(true);
  });

  it("keeps document runtime cleanup behind its lifetime checks", () => {
    const engine = readRepoFile("src/observation/libreoffice-process.ts");
    const startup = section(engine, "private async createRuntime", "private baseArguments");
    const release = section(engine, "async releaseSession", "async dispose");
    expect(appearsInOrder(startup, "await this.stopRuntime(runtime)", "if (!runtime.unconfirmedExit) await rm(directory")).toBe(true);
    expect(appearsInOrder(release, "await session.tail", "if (session.runtime?.unconfirmedExit) throw", "await rm(session.runtime.directory")).toBe(true);
    expect(appearsInOrder(engine, "await wrapOfflineProcess", "const child = spawnManaged(",
      "runtime.unconfirmedExit = error", "const pid = running.child.pid", "if (gone) break", "running.release()")).toBe(true);
  });
});
