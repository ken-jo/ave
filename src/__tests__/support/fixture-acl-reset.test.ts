import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetFixtureAcls } from "./fixture-owner.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: vi.fn(),
}));

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  vi.restoreAllMocks();
  vi.mocked(childProcess.execFileSync).mockReset();
  vi.unstubAllEnvs();
});

function windowsFixture(): string {
  Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  return join(tmpdir(), "ave-acl-reset-fixture");
}

it("restores inheritance recursively without following link targets or continuing after errors", () => {
  const root = windowsFixture();
  const exec = vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.alloc(0));
  resetFixtureAcls(root);
  expect(exec).toHaveBeenCalledExactlyOnceWith(win32.join("C:\\Windows", "System32", "icacls.exe"),
    [root, "/reset", "/T", "/L", "/q"], { windowsHide: true, stdio: "pipe" });
});

it("propagates a failed ACL restoration instead of masking cleanup refusal", () => {
  const root = windowsFixture();
  const failure = new Error("ACL reset refused");
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw failure; });
  expect(() => resetFixtureAcls(root)).toThrow(failure);
});

it("refuses to reset the temporary root itself", () => {
  windowsFixture();
  const exec = vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.alloc(0));
  expect(() => resetFixtureAcls(tmpdir())).toThrow(/inside the test temporary directory/);
  expect(exec).not.toHaveBeenCalled();
});

it("leaves non-Windows fixtures to ordinary filesystem teardown", () => {
  Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "darwin" });
  const exec = vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.alloc(0));
  resetFixtureAcls(join(tmpdir(), "ave-acl-reset-fixture"));
  expect(exec).not.toHaveBeenCalled();
});
