// The narrow root repair (owner decision 2026-11-02): Ave repairs only the root shape its own pre-fix mkdir produced.
// The native helper re-checks this predicate on the pinned handle; the SDDL parity test runs both on Windows.
import { describe, expect, it } from "vitest";
import { isWindowsHomeRootRepairable, isWindowsHomeRootSafe, isWindowsWorkspaceForeignWriter } from "../windows-home-boundary.js";
import type { WindowsDaclFacts } from "../windows-path-facts.js";

const USER = "S-1-5-21-1004336348-11-77-1417";
const INHERITED = 0x10 | 0x3;
const ace = (sid: string, flags: number, type = 0, mask = 0x1f01ff) => ({ type, flags, mask, sid });

function root(aces: ReturnType<typeof ace>[], over: { owner?: string; protected?: boolean; attributes?: number; reparseTag?: number; elevated?: boolean } = {}): WindowsDaclFacts {
  const identity = { volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001" };
  return { exists: true, canonical: "C:\\Users\\example\\ave", ...identity, volumeSerialNumber: "0x0000000000000001",
    fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001", attributes: over.attributes ?? 16, reparseTag: over.reparseTag ?? 0,
    reparseTarget: null, directory: true, ancestors: [], currentUserSid: USER, elevated: over.elevated ?? false, principals: {},
    dacl: { identity, owner: over.owner ?? USER, group: USER, protected: over.protected ?? false, nullDacl: false, aces } } as WindowsDaclFacts;
}
const profileInherited = [ace(USER, INHERITED), ace("S-1-5-18", INHERITED), ace("S-1-5-32-544", INHERITED)];

describe("isWindowsHomeRootRepairable", () => {
  it("repairs the inherited-only profile shape (SYSTEM, Administrators, the user)", () => {
    expect(isWindowsHomeRootRepairable(root(profileInherited))).toBe(true);
  });
  it("refuses an explicit foreign allow", () => {
    expect(isWindowsHomeRootRepairable(root([...profileInherited, ace("S-1-1-0", 0, 0, 0x1200a9)]))).toBe(false);
  });
  it("refuses an explicit deny, even for the user", () => {
    expect(isWindowsHomeRootRepairable(root([ace("S-1-5-32-545", 0, 1), ...profileInherited]))).toBe(false);
    expect(isWindowsHomeRootRepairable(root([ace(USER, 0, 1), ...profileInherited]))).toBe(false);
  });
  it("refuses another owner, including Administrators on an elevated token", () => {
    expect(isWindowsHomeRootRepairable(root(profileInherited, { owner: "S-1-5-18" }))).toBe(false);
    expect(isWindowsHomeRootRepairable(root(profileInherited, { owner: "S-1-5-32-544", elevated: true }))).toBe(false);
  });
  it("refuses a link or junction", () => {
    expect(isWindowsHomeRootRepairable(root(profileInherited, { attributes: 16 | 0x400, reparseTag: 0xa0000003 }))).toBe(false);
    expect(isWindowsHomeRootRepairable(root(profileInherited, { attributes: 16 | 0x400 }))).toBe(false);
  });
  it("leaves an already protected root untouched, safe or not", () => {
    expect(isWindowsHomeRootRepairable(root([ace(USER, 0x3)], { protected: true }))).toBe(false);
    expect(isWindowsHomeRootRepairable(root([ace(USER, 0x3), ace("S-1-5-18", 0x3)], { protected: true }))).toBe(false);
    expect(isWindowsHomeRootRepairable(root(profileInherited, { protected: true }))).toBe(false);
  });
  it.each([
    ["Users", "S-1-5-32-545"],
    ["Authenticated Users", "S-1-5-11"],
    ["Everyone", "S-1-1-0"],
    ["CREATOR OWNER", "S-1-3-0"],
    ["a domain group", "S-1-5-21-1004336348-11-77-513"],
    ["another user", "S-1-5-21-1004336348-11-77-1500"],
  ])("refuses an inherited %s entry: only SYSTEM and Administrators may be dropped", (_name, sid) => {
    expect(isWindowsHomeRootRepairable(root([...profileInherited, ace(sid, INHERITED, 0, 0x1200a9)]))).toBe(false);
  });
  it("refuses a root with no entry for the user", () => {
    expect(isWindowsHomeRootRepairable(root([ace("S-1-5-18", INHERITED), ace("S-1-5-32-544", INHERITED)]))).toBe(false);
  });
  it("keeps an explicit owner-only entry for the user eligible", () => {
    expect(isWindowsHomeRootRepairable(root([ace(USER, 0x3), ace("S-1-5-18", INHERITED)]))).toBe(true);
  });
});

// Native run 3: an inheritable foreign read entry on the root flows into every unprotected child, so the root accepts a foreign
// read-only entry only when it applies to the root alone (lead decision 2026-11-02, stricter only).
describe("isWindowsHomeRootSafe and foreign read-only root entries", () => {
  const OWNER_ONLY = ace(USER, 0x3);
  it.each([
    ["root-only read", 0, true],
    ["object inherit", 0x1, false],
    ["container inherit", 0x2, false],
    ["object and container inherit", 0x3, false],
    ["inherit-only container", 0x2 | 0x8, false],
  ])("Everyone read-only, %s (ACE flags %i): accepted %s", (_name, flags, accepted) => {
    expect(isWindowsHomeRootSafe(root([OWNER_ONLY, ace("S-1-1-0", flags, 0, 0x1200a9)], { protected: true }))).toBe(accepted);
  });
  it("still refuses a root-only foreign write", () => {
    expect(isWindowsHomeRootSafe(root([OWNER_ONLY, ace("S-1-1-0", 0, 0, 0x2)], { protected: true }))).toBe(false);
  });
});

describe("isWindowsWorkspaceForeignWriter", () => {
  const writer = (sid: string, fileSystemRights: number, accessControlType = 0) => ({ sid, accessControlType, fileSystemRights });
  it.each([
    ["the user's own FullControl", false, writer(USER, 0x1f01ff)],
    ["SYSTEM FullControl", false, writer("S-1-5-18", 0x1f01ff)],
    ["Administrators FullControl", false, writer("S-1-5-32-544", 0x1f01ff)],
    ["Users read and execute", false, writer("S-1-5-32-545", 0x1200a9)],
    ["Users generic read", false, writer("S-1-5-32-545", -2147483648)],
    ["a deny of write for Users", false, writer("S-1-5-32-545", 0x2, 1)],
    ["Users modify", true, writer("S-1-5-32-545", 0x1301bf)],
    ["Everyone write data", true, writer("S-1-1-0", 0x2)],
    ["Authenticated Users append", true, writer("S-1-5-11", 0x4)],
    ["CREATOR OWNER FullControl", true, writer("S-1-3-0", 0x1f01ff)],
    ["another user generic all", true, writer("S-1-5-21-1-2-3-1001", 0x10000000)],
  ])("%s: foreign writer %s", (_name, expected, rule) => {
    expect(isWindowsWorkspaceForeignWriter(rule, USER)).toBe(expected);
  });
});
