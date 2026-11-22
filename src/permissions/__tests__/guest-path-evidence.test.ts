import { accessSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectShellPermissionPaths } from "../rules/literal-shell-inspection.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn(actual.accessSync), lstatSync: vi.fn(actual.lstatSync), statSync: vi.fn(actual.statSync) };
});

it.each([
  ["printf x > result.pem", "/app/result.pem"],
  ["printf x > result.key", "/app/result.key"],
  ["printf x > result.txt", "/app/result.txt"],
  ["printf x > \"$PWD/result.pem\"", "/app/result.pem"],
  ["cd certs && printf x > result.pem", "/app/certs/result.pem"],
  ["cd certs && bash -c 'printf x > result.key'", "/app/certs/result.key"],
  ["env -C certs bash -c 'printf x > result.pem'", "/app/certs/result.pem"],
  ["cd && printf x > result.pem", "/home/alice/result.pem"],
])("uses the issued guest cwd without controller probes: %s", (command, expected) => {
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectShellPermissionPaths(command, process.cwd(), { dialect: "bash", environment: { HOME: "/home/alice" }, guestPosixPaths: true, guestCwd: "/app" });
  expect(result.paths).toContainEqual(expect.objectContaining({ canonical: expected, effect: "write" }));
  expect([...realpaths.mock.calls, ...vi.mocked(lstatSync).mock.calls, ...vi.mocked(statSync).mock.calls, ...vi.mocked(accessSync).mock.calls]).toEqual([]);
});

it("retains both logical cd outcomes without assuming the guest directory exists", () => {
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectShellPermissionPaths("cd certs; printf x > result.pem", process.cwd(), { dialect: "bash", environment: {}, guestPosixPaths: true, guestCwd: "/app" });
  expect(result.paths).toContainEqual(expect.objectContaining({ canonical: "/app/certs/result.pem", effect: "write" }));
  expect(result.paths).toContainEqual(expect.objectContaining({ canonical: "/app/result.pem", effect: "write" }));
  expect([...realpaths.mock.calls, ...vi.mocked(lstatSync).mock.calls, ...vi.mocked(statSync).mock.calls, ...vi.mocked(accessSync).mock.calls]).toEqual([]);
});

it.each([
  ["printf x > result.pem", undefined],
  ["printf x > result.key", "C:\\controller"],
  ["cd -P certs; printf x > result.pem", "/app"],
  ["env -C certs/../other bash -c 'printf x > result.pem'", "/app"],
])("keeps an unresolved guest working directory unproven: %s", (command, guestCwd) => {
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectShellPermissionPaths(command, process.cwd(), { dialect: "bash", environment: {}, guestPosixPaths: true, guestCwd });
  expect(result.unproven).not.toBeNull();
  expect([...realpaths.mock.calls, ...vi.mocked(lstatSync).mock.calls, ...vi.mocked(statSync).mock.calls, ...vi.mocked(accessSync).mock.calls]).toEqual([]);
});

it("keeps ordinary host resolution when an unconfirmed fact supplies a guest cwd", () => {
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectShellPermissionPaths("printf x > ordinary.txt", process.cwd(), { dialect: "bash", environment: {}, guestCwd: "/app" });
  expect(result.paths).toContainEqual(expect.objectContaining({ canonical: join(process.cwd(), "ordinary.txt"), effect: "write" }));
  expect(realpaths).toHaveBeenCalled();
});

it.each(["pem", "key", "txt"])("keeps relative command-shell guest %s paths opaque", extension => {
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectPowerShellPermissionPaths(`Get-Content result.${extension}`, "/app", {}, undefined, { inspectHostFiles: false });
  expect(result.paths).toContainEqual(expect.objectContaining({ canonical: `/app/result.${extension}`, effect: "read" }));
  expect([...realpaths.mock.calls, ...vi.mocked(lstatSync).mock.calls, ...vi.mocked(statSync).mock.calls, ...vi.mocked(accessSync).mock.calls]).toEqual([]);
});

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(["pem", "key", "txt"])("collects a guest %s operand without looking it up on the host", extension => {
  const guest = `/logs/result.${extension}`;
  const realpaths = vi.spyOn(realpathSync, "native");
  const result = inspectShellPermissionPaths(`printf x > ${guest}`, process.cwd(), { dialect: "bash", environment: {}, guestPosixPaths: true });
  expect(result.paths).toContainEqual(expect.objectContaining({ lexical: guest, canonical: guest, effect: "write" }));
  const probes = [...realpaths.mock.calls, ...vi.mocked(lstatSync).mock.calls].map(([path]) => String(path).replaceAll("\\", "/"));
  expect(probes.filter(path => path.includes("/logs"))).toEqual([]);
});
