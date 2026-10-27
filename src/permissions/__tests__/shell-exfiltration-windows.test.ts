import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { sensitivePathInArgumentText } from "../rules/shell-exfiltration.js";

vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveFs(await original()));

const HOST = process.platform;
beforeEach(() => {
  setProcessPlatform("win32");
  vi.stubEnv("AVE_HOME", "D:\\AveData");
});
afterEach(() => { setProcessPlatform(HOST); vi.unstubAllEnvs(); });

describe("drive-root application glob anchors", () => {
  it.each(["D:/AveDat*/config/policy.json", "D:\\AveDat*\\config\\policy.json", "d:/avedata/*/policy.json"])("protects %s", path => {
    expect(sensitivePathInArgumentText(path, "C:\\work\\project")).toMatch(/ave-home:/);
  });

  it("keeps a drive-relative glob distinct from a drive root", () => {
    expect(sensitivePathInArgumentText("D:AveDat*", "C:\\work\\project")).toBeNull();
  });
});
