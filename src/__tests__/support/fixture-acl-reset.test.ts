import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetFixtureAcls, setFixtureOwner } from "./fixture-owner.js";

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

const CURRENT_SID = "S-1-5-21-100-200-300-1001";
function ownershipResponse(owner = CURRENT_SID): string {
  return JSON.stringify([{
    exists: true, canonical: "\\\\?\\C:\\fixture", volumeSerial: "0x0000000000000001",
    fileId: "0x00000000000000000000000000000001", volumeSerialNumber: "0x0000000000000001",
    fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001", attributes: 16,
    reparseTag: 0, reparseTarget: null, directory: true, ancestors: [],
    currentUserSid: CURRENT_SID, elevated: true, principals: {},
    identity: { volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001" },
    owner, protected: false, nullDacl: false, aces: [],
  }]);
}

it("rechecks native fixture ownership on every call and repairs a changed owner", () => {
  const root = windowsFixture();
  const exec = vi.mocked(childProcess.execFileSync)
    .mockReturnValueOnce(ownershipResponse())
    .mockReturnValueOnce(ownershipResponse("S-1-5-32-544"))
    .mockReturnValueOnce(Buffer.alloc(0));
  setFixtureOwner(root);
  expect(exec).toHaveBeenCalledTimes(1);
  setFixtureOwner(root);
  expect(exec).toHaveBeenCalledTimes(3);
  for (const call of exec.mock.calls.slice(0, 2)) {
    expect(call[0]).toBe(resolve("resources/windows-path-kind", process.arch, "ave-path-kind.exe"));
    expect(call[1]).toEqual(["--dacl", root]);
  }
  expect(exec.mock.calls[2]).toEqual([win32.join("C:\\Windows", "System32", "icacls.exe"),
    [root, "/setowner", `*${CURRENT_SID}`, "/L", "/q"], { windowsHide: true, stdio: "pipe" }]);
});

it.each(["not-json", "[]", ownershipResponse("not-a-sid")])("refuses invalid ownership facts before changing a fixture: %s", output => {
  const root = windowsFixture();
  const exec = vi.mocked(childProcess.execFileSync).mockReturnValue(output);
  expect(() => setFixtureOwner(root)).toThrow();
  expect(exec).toHaveBeenCalledTimes(1);
});

it("propagates a failed native ownership read without attempting a repair", () => {
  const root = windowsFixture();
  const failure = new Error("Ownership read refused");
  const exec = vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw failure; });
  expect(() => setFixtureOwner(root)).toThrow(failure);
  expect(exec).toHaveBeenCalledTimes(1);
});

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
