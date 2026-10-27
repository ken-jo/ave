import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { configureHostResources } from "../../main/host-resources.js";
import { win32SystemBinary } from "../ave-home.js";
import { pinWindowsPaths } from "../windows-path-facts.js";
import { openWindowsConfigurationHandles, windowsConfigurationDirectoryEntries } from "../windows-configuration-handles.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
const paths = useTempPaths("configuration-stat-", "settings.json");

describe.skipIf(process.platform !== "win32")("configuration handle identity", () => {
  it("maps the native identity and change clock and detects file mutations", () => {
    const path = paths();
    writeFileSync(path, "original");
    const observe = (label: string) => {
      const fd = openSync(path, "r");
      try {
        const stat = fstatSync(fd, { bigint: true });
        const facts = pinWindowsPaths([path])[0]!;
        const nativeIndex = BigInt(facts.fileIndex!);
        const high = nativeIndex >> 32n, low = nativeIndex & 0xffffffffn;
        process.stdout.write(`${JSON.stringify({ label, path, runtime: process.version, dev: String(stat.dev), ino: String(stat.ino),
          ctimeNs: String(stat.ctimeNs), birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs),
          volumeSerialNumber: facts.volumeSerialNumber, fileIndex: facts.fileIndex, changeTime: facts.changeTime,
          high: String(high), low: String(low), reverseWords: String((low << 32n) | high) })}\n`);
        expect(stat.dev).toBe(BigInt(facts.volumeSerialNumber!));
        expect(stat.ino).toBe((high << 32n) | low);
        expect(stat.ino).not.toBe((low << 32n) | high);
        expect(stat.ctimeNs).toBe((BigInt(facts.changeTime!) - 116444736000000000n) * 100n);
        expect(readFileSync(fd, "utf8")).toBe(readFileSync(path, "utf8"));
        return stat;
      } finally { closeSync(fd); }
    };
    const before = observe("initial");
    const directory = dirname(path);
    const entries = windowsConfigurationDirectoryEntries(directory, pinWindowsPaths([directory])[0]!);
    const { handles } = openWindowsConfigurationHandles(entries);
    try {
      process.stdout.write(`${JSON.stringify({ directoryHandlePaths: entries.map(entry => entry.path), matched: handles !== undefined })}\n`);
      expect(handles).toBeDefined();
      expect(handles?.matches()).toBe(true);
    } finally { handles?.close(); }
    execFileSync(win32SystemBinary("icacls"), [path, "/grant", "*S-1-1-0:(R)", "/q"], { windowsHide: true, stdio: "pipe" });
    const acl = observe("acl-only");
    expect(acl.dev).toBe(before.dev);
    expect(acl.ino).toBe(before.ino);
    expect(acl.birthtimeNs).toBe(before.birthtimeNs);
    expect(acl.mtimeNs).toBe(before.mtimeNs);
    expect(acl.ctimeNs).toBeGreaterThan(before.ctimeNs);
    const replacement = join(resolve(path, ".."), "replacement.json");
    writeFileSync(replacement, "replacement");
    renameSync(path, `${path}.old`);
    renameSync(replacement, path);
    const swapped = observe("rename-swap");
    expect(swapped.dev === acl.dev && swapped.ino === acl.ino && swapped.ctimeNs === acl.ctimeNs).toBe(false);
    expect(swapped.ino).not.toBe(acl.ino);
    writeFileSync(path, "rewritten content");
    const rewritten = observe("content-rewrite");
    expect(rewritten.dev).toBe(swapped.dev);
    expect(rewritten.ino).toBe(swapped.ino);
    expect(rewritten.ctimeNs).toBeGreaterThan(swapped.ctimeNs);
  });
});
