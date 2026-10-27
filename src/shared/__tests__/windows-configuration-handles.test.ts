import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { matchesWindowsConfigurationFacts, openWindowsConfigurationHandles, type WindowsConfigurationHandleEntry } from "../windows-configuration-handles.js";

const temporary = useTempDirs("configuration-facts-");

function entry(path: string, fileSystemName: string | null | undefined): WindowsConfigurationHandleEntry {
  const stat = lstatSync(path, { bigint: true });
  return { path, changeTimeRequired: true, facts: {
    volumeSerialNumber: `0x${stat.dev.toString(16)}`, fileIndex: `0x${stat.ino.toString(16)}`,
    changeTime: `0x${(stat.ctimeNs / 100n + 116444736000000000n).toString(16)}`,
    directory: stat.isDirectory(), ...(fileSystemName === undefined ? {} : { fileSystemName }),
  } };
}

describe("configuration handle filesystem admission", () => {
  it.each(["ReFS", "exFAT", null, undefined])("refuses warm handles for filesystem %s despite matching runtime IDs", fileSystemName => {
    const path = join(temporary(), "configuration.json");
    writeFileSync(path, "{}");
    expect(matchesWindowsConfigurationFacts(lstatSync(path, { bigint: true }), entry(path, fileSystemName))).toBe(false);
  });

  it("requires the certified volume serial to match the retained handle", () => {
    const path = join(temporary(), "configuration.json");
    writeFileSync(path, "{}");
    const certified = entry(path, "NTFS");
    expect(matchesWindowsConfigurationFacts(lstatSync(path, { bigint: true }), { ...certified,
      facts: { ...certified.facts, volumeSerialNumber: `0x${(BigInt(certified.facts.volumeSerialNumber!) + 1n).toString(16)}` } })).toBe(false);
  });

  it("requires every retained directory to have a certified filesystem", () => {
    const directory = join(temporary(), "boundary");
    mkdirSync(directory);
    const path = join(directory, "configuration.json");
    writeFileSync(path, "{}");
    const entries = [entry(directory, null), entry(path, "NTFS")];
    expect(entries.every(value => matchesWindowsConfigurationFacts(lstatSync(value.path, { bigint: true }), value))).toBe(false);
  });

  it.runIf(process.platform === "win32")("does not observe a file whose open fails", () => {
    const path = join(temporary(), "configuration.json");
    writeFileSync(path, "{}");
    const certified = entry(path, "NTFS");
    expect(openWindowsConfigurationHandles([{ ...certified, path: `${path}.missing` }]))
      .toEqual({ handles: undefined, fileOpened: false });
  });
});
