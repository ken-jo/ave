import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { queryDriveIdentity, setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

// The shared setup answers every drive as local; this file checks the classifier itself.
vi.unmock("../windows-drive-locality.js");

const MAPPINGS: Record<string, string | null> = {
  "C:": String.raw`\Device\HarddiskVolume3`,
  "D:": String.raw`\??\C:`,
  "S:": String.raw`\??\C:\work\market`,
  "T:": String.raw`\??\Z:\team`,
  "Z:": String.raw`\Device\Mup\;LanmanRedirector\;Z:0000000000012345\files.example\share`,
  "Y:": String.raw`\Device\LanmanRedirector\;Y:0000000000012345\files.example\share\sub`,
  "W:": String.raw`\Device\WebDavRedirector\;W:0000000000012345\files.example@SSL\DavWWWRoot`,
  "R:": String.raw`\Device\Mup\;RdpDr\;:1\tsclient\C`,
  "U:": String.raw`\??\UNC\files.example\share`,
  "V:": String.raw`\Device\VirtualShare\;V:\files.example`,
  "Q:": null,
};
const mapped = (drive: string) => {
  const mapping = MAPPINGS[drive];
  if (mapping === undefined) throw new Error(`unexpected drive ${drive}`);
  return mapping;
};
const opaque = (root: string, absent = false) => ({ local: false, root, absent });

afterEach(() => setWindowsDriveQueryForTest());

describe("queryDriveIdentity", () => {
  it.each([
    ["C:", { local: true }],
    ["c:", { local: true }],
    // A substitute is opaque, for a whole drive or a folder: its backing path is not walked, so nothing proves it local.
    ["D:", opaque(String.raw`\\?\GLOBALROOT\??\C:`)],
    ["S:", opaque(String.raw`\\?\GLOBALROOT\??\C:\work\market`)],
    ["T:", opaque(String.raw`\\?\GLOBALROOT\??\Z:\team`)],
    ["Z:", opaque(String.raw`\\files.example\share`)],
    ["Y:", opaque(String.raw`\\files.example\share\sub`)],
    ["W:", opaque(String.raw`\\files.example@SSL\DavWWWRoot`)],
    ["R:", opaque(String.raw`\\tsclient\C`)],
    ["U:", opaque(String.raw`\\files.example\share`)],
    ["V:", opaque(String.raw`\\?\GLOBALROOT\Device\VirtualShare\;V:\files.example`)],
    ["Q:", opaque(String.raw`\\?\GLOBALROOT\??\Q:`, true)],
  ] as const)("classifies %s from its mapping alone", (drive, expected) => {
    setWindowsDriveQueryForTest(mapped);
    expect(queryDriveIdentity(drive)).toEqual(expected);
  });

  it("treats a drive the classifier cannot answer for as opaque but present", () => {
    setWindowsDriveQueryForTest(() => { throw new Error("helper unavailable"); });
    expect(queryDriveIdentity("C:")).toEqual(opaque(String.raw`\\?\GLOBALROOT\??\C:`));
  });

  it("keeps no answer: every call reads the mapping again", () => {
    let calls = 0;
    setWindowsDriveQueryForTest(drive => { calls++; return mapped(drive); });
    expect([queryDriveIdentity("C:"), queryDriveIdentity("c:"), queryDriveIdentity("Z:")])
      .toEqual([{ local: true }, { local: true }, opaque(String.raw`\\files.example\share`)]);
    expect(calls).toBe(3);
  });
});

describe.runIf(process.platform === "win32")("queryDriveIdentity through the shipped helper", () => {
  it("finds the system drive local", () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    expect(queryDriveIdentity(process.env.SystemDrive ?? "C:")).toEqual({ local: true });
  });

  it("keeps every drive opaque when the helper is missing", () => {
    configureHostResources({ resourcePath: mkdtempSync(join(tmpdir(), "no-helper-")), isPackaged: false });
    expect(queryDriveIdentity(process.env.SystemDrive ?? "C:")).toMatchObject({
      local: false, absent: false, root: expect.stringMatching(/^\\\\\?\\GLOBALROOT\\\?\?\\[A-Z]:$/u),
    });
  });
});
