/**
 * Stage 1 of a folder input (design §18.4.1), on both path families: what
 * normalizes, what is refused with which reason, and what stays a git
 * address. Pure string work: no filesystem call is possible here.
 */
import { describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { FakeVolume } from "../../__tests__/fixtures/folder-fs.js";
import {
  classifyDosDeviceMapping,
  classifyFolder,
  isNetworkLinkText,
  normalizeSourceInput,
  resolveLinkText,
} from "../source-input.js";

const POSIX_HOME = "/Users/example";
const WIN_HOME = "C:\\Users\\example";

function folder(input: string, platform: NodeJS.Platform, home = platform === "win32" ? WIN_HOME : POSIX_HOME): string {
  const result = normalizeSourceInput(input, platform, home);
  if (result.kind !== "folder") throw new Error(`${input} read as a git address`);
  return result.path;
}

function refusal(input: string, platform: NodeJS.Platform): string {
  try {
    normalizeSourceInput(input, platform, platform === "win32" ? WIN_HOME : POSIX_HOME);
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    const failure = error as MarketplaceError;
    expect(failure.code).toBe("SOURCE_URL_REJECTED");
    return (failure.detail as { reason: string } | undefined)?.reason ?? "(no reason)";
  }
  throw new Error(`${input} was accepted`);
}

describe("stage 1 on macOS and Linux (path.posix)", () => {
  it.each([
    ["/opt/acme/market", "/opt/acme/market"],
    ["/opt//acme/./market/", "/opt/acme/market"],
    ["/opt/acme/x/../market", "/opt/acme/market"],
    ["~", POSIX_HOME],
    ["~/market", `${POSIX_HOME}/market`],
    ["file:///opt/acme/market", "/opt/acme/market"],
    ["file://localhost/opt/acme/market", "/opt/acme/market"],
    ["file:///opt/acme/my%20market", "/opt/acme/my market"],
  ])("%s → %s", (input, expected) => {
    expect(folder(input, "darwin")).toBe(expected);
    expect(folder(input, "linux")).toBe(expected);
  });

  it.each([
    ["./market", "relative-path"],
    ["../market", "relative-path"],
    ["~ada/market", "relative-path"],
    ["/opt/../../etc", "outside-root"],
    ["C:\\market", "windows-path"],
    ["C:/market", "windows-path"],
    ["C:foo", "relative-path"],
    ["\\\\server\\share\\m", "windows-path"],
    ["//server/share/m", "windows-path"],
    ["\\\\.\\PhysicalDrive0", "device-path"],
    ["\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\m", "device-path"],
    ["file://server/share/m", "network-file-url"],
    ["file:///opt/m?x=1", "format"],
    ["/opt/acme\u0000/m", "format"],
  ])("%s is refused (%s)", (input, reason) => {
    expect(refusal(input, "linux")).toBe(reason);
  });

  it("keeps owner/repo as the GitHub shorthand and every URL a git address", () => {
    for (const input of ["acme/market", "https://github.com/acme/market", "git@github.com:acme/market.git", "ssh://git@host/a/b"]) {
      expect(normalizeSourceInput(input, "linux", POSIX_HOME).kind).toBe("git");
      expect(normalizeSourceInput(input, "win32", WIN_HOME).kind).toBe("git");
    }
    const shorthand = normalizeSourceInput("a/b", "darwin", POSIX_HOME);
    expect(shorthand).toMatchObject({ kind: "git", url: { host: "github.com", path: "/a/b" } });
  });

  it("keeps what was typed beside the normal path, for \"resolved from\"", () => {
    expect(normalizeSourceInput("  ~/market/  ", "darwin", POSIX_HOME)).toEqual({ kind: "folder", path: `${POSIX_HOME}/market`, input: "~/market/" });
  });
});

describe("stage 1 on Windows (path.win32)", () => {
  it.each([
    ["C:\\acme\\market", "C:\\acme\\market"],
    ["c:/acme/market/", "C:\\acme\\market"],
    ["C:\\acme\\x\\..\\market", "C:\\acme\\market"],
    ["~", WIN_HOME],
    ["~\\market", `${WIN_HOME}\\market`],
    ["~/market", `${WIN_HOME}\\market`],
    ["\\\\server\\share\\market", "\\\\server\\share\\market"],
    ["//server/share/market", "\\\\server\\share\\market"],
    ["\\\\?\\C:\\acme\\market", "C:\\acme\\market"],
    ["\\\\?\\UNC\\server\\share\\market", "\\\\server\\share\\market"],
    ["file:///C:/acme/market", "C:\\acme\\market"],
    ["file://server/share/market", "\\\\server\\share\\market"],
  ])("%s → %s", (input, expected) => {
    expect(folder(input, "win32")).toBe(expected);
  });

  it.each([
    ["C:foo", "relative-path"],
    ["C:", "relative-path"],
    ["\\acme", "relative-path"],
    [".\\market", "relative-path"],
    ["./market", "relative-path"],
    ["\\\\.\\PhysicalDrive0", "device-path"],
    ["\\\\?\\Volume{0b1c2d3e-0000-0000-0000-000000000000}\\m", "device-path"],
    ["\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1", "device-path"],
    ["\\\\server", "unc-without-share"],
    ["\\\\server\\", "unc-without-share"],
    ["C:\\..\\x", "outside-root"],
    ["\\\\server\\share\\..\\..\\x", "outside-root"],
    ["file:///market", "relative-path"],
  ])("%s is refused (%s)", (input, reason) => {
    expect(refusal(input, "win32")).toBe(reason);
  });
});

describe("stage 2: network classification without touching the path", () => {
  it("classifies UNC and automount paths from the text alone", async () => {
    const volume = new FakeVolume("win32");
    expect(await classifyFolder("\\\\files.corp\\share\\m", "win32", volume)).toEqual({ network: true, server: "files.corp" });
    const posix = new FakeVolume("darwin");
    expect(await classifyFolder("/net/nas/export/m", "linux", posix)).toEqual({ network: true, server: "nas" });
    expect(await classifyFolder("/Network/Servers/nas/m", "darwin", posix)).toEqual({ network: true, server: "nas" });
    expect(await classifyFolder("/Volumes/share/m", "darwin", posix)).toEqual({ network: false });
    expect(volume.calls).toEqual([]);
    expect(posix.calls).toEqual([]);
  });

  it("classifies a drive letter by its MS-DOS device mapping only, failing toward network", async () => {
    const volume = new FakeVolume("win32", {
      drives: {
        "C:": "\\Device\\HarddiskVolume3",
        "D:": "\\Device\\CdRom0",
        "S:": "\\??\\C:\\work\\market",
        "T:": "\\??\\Z:\\nested",
        // `subst R: Z:\` is reported without the trailing separator.
        "R:": "\\??\\Z:",
        "Z:": "\\Device\\Mup\\;LanmanRedirector\\;Z:000000000001a2b3\\files.corp\\share",
        "W:": "\\Device\\WebDavRedirector\\dav.corp@SSL\\DavWWWRoot",
        "U:": "\\??\\UNC\\nas.corp\\share",
      },
    });
    expect(await classifyFolder("C:\\m", "win32", volume)).toEqual({ network: false });
    expect(await classifyFolder("D:\\m", "win32", volume)).toEqual({ network: false });
    expect(await classifyFolder("S:\\m", "win32", volume)).toEqual({ network: false });
    expect(await classifyFolder("T:\\m", "win32", volume)).toEqual({ network: true, server: "files.corp" });
    expect(await classifyFolder("R:\\m", "win32", volume)).toEqual({ network: true, server: "files.corp" });
    expect(await classifyFolder("Z:\\m", "win32", volume)).toEqual({ network: true, server: "files.corp" });
    expect(await classifyFolder("W:\\m", "win32", volume)).toEqual({ network: true, server: "dav.corp" });
    expect(await classifyFolder("U:\\m", "win32", volume)).toEqual({ network: true, server: "nas.corp" });
    // An unknown drive, or a failed call, is a network folder: a wrong guess only warns.
    expect(await classifyFolder("Q:\\m", "win32", volume)).toEqual({ network: true, server: null });
    expect(await classifyDosDeviceMapping("\\Device\\Unknown7", volume)).toEqual({ network: true, server: null });
    // Only the drive letters were asked about; no path was touched.
    expect(volume.calls.every((call) => call.op === "queryDosDevice")).toBe(true);
    expect(volume.paths("queryDosDevice")).toEqual(["C:", "D:", "S:", "C:", "T:", "Z:", "R:", "Z:", "Z:", "W:", "U:", "Q:"]);
  });

  it("judges a link's text for a network location before anything resolves it (§18.4.5 rule 1)", async () => {
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3", "Z:": "\\Device\\Mup\\x\\y" } });
    for (const text of ["\\\\attacker\\share", "//attacker/share", "\\??\\UNC\\attacker\\share", "\\\\?\\UNC\\attacker\\share", "Z:\\x", "\\\\?\\Z:\\x"]) {
      expect(await isNetworkLinkText(text, "win32", volume), text).toBe(true);
    }
    for (const text of ["C:\\inside", "..\\b", "sub\\file", "\\\\?\\C:\\inside"]) {
      expect(await isNetworkLinkText(text, "win32", volume), text).toBe(false);
    }
    const posix = new FakeVolume("linux");
    for (const text of ["//attacker/share", "/net/attacker/x"]) expect(await isNetworkLinkText(text, "linux", posix), text).toBe(true);
    for (const text of ["/opt/x", "../b", "b"]) expect(await isNetworkLinkText(text, "linux", posix), text).toBe(false);
  });

  it("resolves a link's text lexically against its own directory, stopping .. at the root", () => {
    expect(resolveLinkText("/root/a", "../b", "linux")).toBe("/root/b");
    expect(resolveLinkText("/root/a", "/opt/x", "linux")).toBe("/opt/x");
    expect(resolveLinkText("/root", "../../../../etc", "linux")).toBe("/etc");
    expect(resolveLinkText("C:\\root\\a", "..\\b", "win32")).toBe("C:\\root\\b");
    expect(resolveLinkText("C:\\root\\a", "\\x", "win32")).toBe("C:\\x");
    expect(resolveLinkText("C:\\root\\a", "\\\\?\\D:\\x", "win32")).toBe("D:\\x");
    expect(resolveLinkText("C:\\root\\a", "D:x", "win32")).toBeNull();
  });
});
