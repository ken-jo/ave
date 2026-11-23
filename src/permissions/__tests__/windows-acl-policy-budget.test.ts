// windows-native: exercises the Windows ACL senders with a recording child.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampWindowsAcl, stampWindowsAclAsync } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { t } from "../../i18n/index.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";

vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

const HOST_PLATFORM = process.platform;

describe("Windows ACL stamp budget", () => {
  let root: string;
  let receipt: string;
  let srtWin: { exe: string; prependArgs: string[] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acl-budget-"));
    receipt = join(root, "received.txt");
    const helper = join(root, "helper.mjs");
    writeFileSync(helper, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const input = readFileSync(0);',
      'const { denyRead, denyWrite } = JSON.parse(input.toString("utf8"));',
      `writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([input.length, denyRead.length, denyWrite.length]));`,
    ].join("\n"));
    srtWin = { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [helper] };
  });

  afterEach(() => {
    setProcessPlatform(HOST_PLATFORM);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses the configured list before building the session policy", () => {
    setProcessPlatform("win32");
    const denyWrite = Array.from({ length: 5_000 }, (_, index) => `D:/configured/${index}-`.padEnd(253, "x"));
    expect(Buffer.byteLength(JSON.stringify(denyWrite))).toBe(1_280_001);
    expect(() => buildSandboxConfig({ denyWrite, windows: { externalConfinement: true } }))
      .toThrow(t("sandboxPolicy.configuredDeniesTooLarge"));
  });

  it.each([
    { mode: "synchronous", send: stampWindowsAcl },
    { mode: "asynchronous", send: stampWindowsAclAsync },
  ])("bounds the combined stdin frame and row count for the $mode sender", async ({ send }) => {
    const row = (index: number) => `D:/deny/${index}-`.padEnd(253, "x");
    const denyRead = [row(0)];
    const denyWrite = Array.from({ length: 1_023 }, (_, index) => row(index + 1));
    // Count UTF-8 bytes and JSON escapes as well as the envelope and commas.
    const boundaryRow = `${row(1).slice(0, -36)}é\\😀`;
    denyWrite[0] = boundaryRow;
    const dispatch = async (read: string[], write: string[]) => send({ srtWin, sandboxUserSid: "S-1-5-21-123", denyRead: read, denyWrite: write });
    const bytes = (read: string[], write: string[]) => Buffer.byteLength(JSON.stringify({ denyRead: read, denyWrite: write }));
    const tooWide = [...denyWrite];
    tooWide[0] = `${boundaryRow}x`;
    expect(bytes(denyRead, denyWrite)).toBe(262_144);
    expect(bytes(denyRead, tooWide)).toBe(262_145);
    await expect(dispatch(denyRead, tooWide)).rejects.toMatchObject({ code: "acl_policy_too_large" });
    const shortRows = Array.from({ length: 1_024 }, (_, index) => `D:/short/${index}`);
    await expect(dispatch(denyRead, shortRows)).rejects.toMatchObject({ code: "acl_policy_too_large" });
    expect(existsSync(receipt)).toBe(false);
    await dispatch(denyRead, denyWrite);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([262_144, 1, 1_023]);
  });
});
