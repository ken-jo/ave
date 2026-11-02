// The narrow root repair (owner decision 2026-11-02): Ave repairs only the root shape its own pre-fix mkdir produced.
// The native helper re-checks this predicate on the pinned handle; the SDDL parity test runs both on Windows.
import { describe, expect, it } from "vitest";
import { isWindowsHomeRootRepairable } from "../windows-home-boundary.js";
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
