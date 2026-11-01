import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export function createMxcNativeProcess() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (value: { exitCode: number; timedOut: boolean }) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((yes, no) => { resolve = yes; reject = no; });
  const accesses: string[] = [];
  const native = {
    id: 42,
    get standardInput() { accesses.push("stdin"); return stdin; },
    get standardOutput() { accesses.push("stdout"); return stdout; },
    get standardError() { accesses.push("stderr"); return stderr; },
    wait: vi.fn(() => { accesses.push("wait"); return completion; }),
    kill: vi.fn(() => { stdout.end(); stderr.end(); resolve({ exitCode: 1, timedOut: false }); }),
    dispose: vi.fn(),
  };
  return { native, accesses, resolve, reject, stdin, stdout, stderr };
}


export function createMxcExtensionRequest(): ContainerRequest {
  return {
    command: '"C:\\Ave\\runtime.exe" "C:\\Ave\\staging\\entry.js"',
    containment: { type: "processcontainer", config: { filesystem: { enumeratePaths: ["C:\\"] } } },
    workingDirectory: "C:\\Ave\\staging",
    environment: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\Ave\\staging", HOME: "C:\\Ave\\staging", TEMP: "C:\\Ave\\staging", TMP: "C:\\Ave\\staging", ELECTRON_RUN_AS_NODE: "1" },
    inheritDefaultEnvironment: false,
    filesystem: { readwritePaths: ["C:\\Ave\\staging"], readonlyPaths: ["C:\\Ave", "C:\\Windows"], deniedPaths: [], clearPolicyOnExit: true },
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: "http://127.0.0.1:12345" } },
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
  };
}
