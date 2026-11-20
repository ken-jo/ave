import { resolve, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { windowsCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT } from "../windows-command-line.js";
import * as nativeHost from "../windows-native-host.js";
import { pinWindowsPaths, readWindowsDacls } from "../windows-path-facts.js";

type OutputEncoding = BufferEncoding | "buffer" | null | undefined;

const { execute, helper } = vi.hoisted(() => ({
  execute: vi.fn<(file: string, args: string[], options: { input?: Buffer; encoding?: OutputEncoding }) => string | Buffer>(),
  helper: "C:\\path kind\\helper.exe",
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: execute }));
vi.mock("../../main/windows-path-kind-launcher.js", () => ({ resolveWindowsPathKindHelper: () => helper }));

const MISSING = {
  exists: false, canonical: null, volumeSerial: null, fileId: null, volumeSerialNumber: null, fileIndex: null,
  changeTime: null, attributes: 0, reparseTag: 0, reparseTarget: null, directory: false, ancestors: [],
  currentUserSid: "S-1-5-21-1-2-3-1001", elevated: false, principals: {}, identity: null, parent: null,
};

function stdoutWithEncoding(bytes: Buffer, encoding: OutputEncoding): string | Buffer {
  return encoding && encoding !== "buffer" ? bytes.toString(encoding) : bytes;
}

function replyOnce(bytes: Buffer): void {
  execute.mockImplementationOnce((_file, _args, { encoding }) => stdoutWithEncoding(bytes, encoding));
}

describe("Windows path facts transport", () => {
  beforeEach(() => {
    execute.mockReset();
    vi.spyOn(nativeHost, "runWindowsNative").mockImplementation(operation => operation());
  });

  it("delivers all ordered operands when the quoted argv would exceed the Windows limit", () => {
    const prefix = `${resolve("path facts")}${sep}`;
    const paths = Array.from({ length: 160 }, (_, index) => `${prefix}${index}-😀`.padEnd(253, "x"));
    expect(paths.every(path => path.length === 253)).toBe(true);
    const oldUnits = windowsCommandLineLength(helper, ["--dacl", "--parent", ...paths]);
    expect(oldUnits).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);

    execute.mockImplementation((file, args, options) => {
      if (windowsCommandLineLength(file, args) > WINDOWS_COMMAND_LINE_LIMIT) throw new Error("CreateProcessW argument limit");
      expect(args).toEqual(["--dacl", "--parent", "--stdin"]);
      const input = options.input;
      if (!input) throw new Error("Missing DACL stdin frame");
      expect(input.readUInt32LE(0)).toBe(input.length - 4);
      expect(input.readUInt32LE(4)).toBe(paths.length);
      let offset = 8;
      const requests = paths.map(() => {
        const length = input.readUInt32LE(offset);
        offset += 4 + length;
        return input.toString("utf8", offset - length, offset);
      });
      expect(offset).toBe(input.length);
      expect(requests).toEqual(paths);
      const reply = Buffer.from(JSON.stringify(requests.map(requestPath => ({ ...MISSING, requestPath }))));
      return stdoutWithEncoding(reply, options.encoding);
    });

    const rows = readWindowsDacls(paths, { parent: true });
    expect(rows).toHaveLength(paths.length);
    expect(rows.every(row => row.exists === false && row.parent === null)).toBe(true);
    expect(() => readWindowsDacls(paths)).toThrow(/command line exceeds the process limit/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects oversized or lossy frames before opening the helper", () => {
    const target = resolve("protected");
    const long = `${target}${"x".repeat(800)}`;
    expect(() => readWindowsDacls(Array.from({ length: 2_049 }, () => target), { parent: true })).toThrow(/size limit/);
    expect(() => readWindowsDacls(Array.from({ length: 1_400 }, () => long), { parent: true })).toThrow(/size limit/);
    for (const path of [`${target}\0suffix`, `${target}\ud800`]) {
      expect(() => readWindowsDacls([path], { parent: true })).toThrow(/invalid path/);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses the entire verification reply if a later row is missing, substituted or malformed", () => {
    const paths = [resolve("parent first"), resolve("parent second")];
    const rows = paths.map(requestPath => ({ ...MISSING, requestPath }));
    replyOnce(Buffer.from(JSON.stringify([rows[0], rows[0]])));
    expect(() => readWindowsDacls(paths, { parent: true })).toThrow(/request path mismatch/);
    replyOnce(Buffer.from(JSON.stringify(rows.slice(0, 1))));
    expect(() => readWindowsDacls(paths, { parent: true })).toThrow(/response/);
    replyOnce(Buffer.from(JSON.stringify([rows[0], { ...rows[1], parent: true }])));
    expect(() => readWindowsDacls(paths, { parent: true })).toThrow(/parent DACL/);
  });

  it("rejects malformed UTF-8 that could decode to the exact request path", () => {
    const path = resolve("target-\ufffd");
    const valid = Buffer.from(JSON.stringify([{ ...MISSING, requestPath: path }]));
    const replacement = Buffer.from("\ufffd");
    const offset = valid.lastIndexOf(replacement);
    expect(offset).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xff]), valid.subarray(offset + replacement.length)]);
    expect(malformed.toString("utf8")).toBe(valid.toString("utf8"));

    replyOnce(valid);
    expect(readWindowsDacls([path], { parent: true })).toMatchObject([{ exists: false, parent: null }]);
    replyOnce(malformed);
    expect(() => readWindowsDacls([path], { parent: true })).toThrow(/encoding utf-8/i);
  });

  it.each([
    ["path pin", pinWindowsPaths],
    ["DACL", readWindowsDacls],
    ["DACL with content", (paths: readonly string[]) => readWindowsDacls(paths, { content: true })],
    ["parent DACL with content", (paths: readonly string[]) => readWindowsDacls(paths, { parent: true, content: true })],
  ] as const)("rejects malformed UTF-8 in a %s reply", (_mode, request) => {
    const path = resolve("target-\ufffd");
    const volumeSerial = "0x0000000000000001";
    const fileId = "0x00000000000000000000000000000001";
    const valid = Buffer.from(JSON.stringify([{
      ...MISSING, exists: true, canonical: path, volumeSerial, fileId,
      volumeSerialNumber: volumeSerial, fileIndex: volumeSerial, changeTime: volumeSerial,
      identity: { volumeSerial, fileId }, owner: MISSING.currentUserSid, protected: true, nullDacl: false, aces: [], contentHex: "41",
    }]));
    const replacement = Buffer.from("\ufffd");
    const offset = valid.lastIndexOf(replacement);
    expect(offset).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xff]), valid.subarray(offset + replacement.length)]);
    expect(malformed.toString("utf8")).toBe(valid.toString("utf8"));

    replyOnce(valid);
    expect(request([path])).toMatchObject([{ exists: true, canonical: path }]);
    replyOnce(malformed);
    expect(() => request([path])).toThrow(/encoding utf-8/i);
  });
});
