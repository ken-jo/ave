import { describe, expect, it } from "vitest";
import {
  _assertPosixDenyOutcomesForTest, _rankPosixContainerRowsForTest,
  PosixContainerPolicyError, rankPosixContainerRows, type PosixPolicyLookups, type PosixPolicyRefusal,
} from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyFloorRow, type PolicyGrantRow } from "../policy-model.js";

const lookups: PosixPolicyLookups = {
  home: "/users/example", foldsCase: false,
  exists: (path) => !path.includes("/missing"),
  canonical: (path) => path.replace(/^\/tmp(?=\/|$)/u, "/private/tmp"),
};

const read = (path: string) => policyGrantRow(path, "ro", "launch-grant", true);
const write = (path: string) => policyGrantRow(path, "rw", "launch-grant", true);
const pierce = (path: string) => policyGrantRow(path, "ro", "floor-pierce", true);
const deny = (path: string, reason: Exclude<PolicyFloorRow["reason"], "protected-name"> = "read-boundary") =>
  policyFloorRow(path, "denied", reason, true);
const protect = (path: string) => policyFloorRow(path, "ro", "protected-name", true);
const model = (floors: PolicyFloorRow[], ...launchGrants: PolicyGrantRow[]) =>
  buildPolicyModel({ floors, launchGrants, userGrants: [], extensionManifests: [] });

describe("POSIX container filesystem ranking", () => {
  it.each(["bubblewrap", "process-container"] as const)("refuses an unmeasured backend rule for %s", (backend) => {
    const rank = () => rankPosixContainerRows(model([]), backend, lookups);
    expect(rank).toThrow(PosixContainerPolicyError);
    expect(rank).toThrow(expect.objectContaining({ code: "backend-unmeasured" }));
  });

  it.each([
    ["~/work/**", "pattern-row"],
    ["/work/.git/[h]ooks", "pattern-row"],
    ["work/relative", "relative-row"],
  ] as const satisfies readonly (readonly [string, PosixPolicyRefusal])[])("refuses unrepresentable spelling %s", (path, code) => {
    expect(() => rankPosixContainerRows(model([protect(path)]), "seatbelt", lookups)).toThrow(expect.objectContaining({ code }));
  });

  it("expands home, canonicalizes paths, drops missing grants and introduces no roots", () => {
    expect(rankPosixContainerRows(model([], read("~/work"), write("/tmp/work/"), read("/missing")), "seatbelt", lookups))
      .toEqual({ readwrite: ["/private/tmp/work"], readonly: ["/users/example/work"], denied: [] });
  });

  it("propagates a canonicalization failure", () => {
    const error = new Error("Cannot inspect the path");
    expect(() => rankPosixContainerRows(model([], read("/work")), "seatbelt", {
      ...lookups, canonical: () => { throw error; },
    })).toThrow(error);
  });

  it("uses path segments and folds aliases only on a case-folding volume", () => {
    const policy = model([deny("/private/tmp/A", "user-deny")], read("/tmp/a/child"), read("/tmp/AB"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups).readonly).toEqual(["/private/tmp/a/child", "/private/tmp/AB"]);
    expect(rankPosixContainerRows(policy, "seatbelt", { ...lookups, foldsCase: true }).readonly).toEqual(["/private/tmp/AB"]);
  });

  it("drops floored reads and keeps a read opened by a host pierce", () => {
    const policy = model([deny("/work/secret", "secrets")],
      read("/work/secret/private"), read("/work/secret/allowed/leaf"), pierce("/work/secret/allowed"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups))
      .toEqual({ readwrite: [], readonly: ["/work/secret/allowed/leaf"], denied: [] });
  });

  it("allows a pierce and a wider grant when the pierce names the secret floor exactly", () => {
    const policy = model([deny("/work/secret", "secrets")], read("/work"), read("/work/secret"), pierce("/work/secret"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups).denied).toEqual([]);
  });

  it("refuses a pierce beneath a user deny after canonicalization", () => {
    const policy = model([deny("/private/tmp/secret", "user-deny")], pierce("/tmp/secret/allowed"));
    expect(() => rankPosixContainerRows(policy, "seatbelt", lookups))
      .toThrow(expect.objectContaining({ code: "user-deny-covers-pierce" }));
  });

  it("keeps the write floor readable whether present or absent and retains enclosing read denies", () => {
    const policy = model([
      protect("/work/.git/hooks"), protect("/work/missing/hooks"),
      protect("/work/blocked/control"), deny("/work/blocked"),
      protect("/elsewhere"), protect("/read-only/control"),
    ], write("/work"), write("/work/.git/hooks/file"), read("/read-only"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups)).toEqual({
      readwrite: ["/work"],
      readonly: ["/read-only", "/work/.git/hooks/file", "/work/.git/hooks", "/work/missing/hooks"],
      denied: ["/work/blocked"],
    });
  });

  it("demotes a grant wholly beneath the write floor", () => {
    const policy = model([protect("/work/control")], write("/work/control/new"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups))
      .toEqual({ readwrite: [], readonly: ["/work/control/new"], denied: [] });
  });

  it("drops a grant equal to a read deny and omits unreached denies", () => {
    const policy = model([deny("/work/private"), deny("/elsewhere", "ave-home")], read("/work/private"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups))
      .toEqual({ readwrite: [], readonly: [], denied: [] });
  });

  it("refuses a surviving grant nested beneath an emitted deny on a deny-wins backend", () => {
    const policy = model([deny("/work/private", "ave-home")], read("/work"), read("/work/private/allowed"));
    expect(() => rankPosixContainerRows(policy, "seatbelt", lookups))
      .toThrow(expect.objectContaining({
        code: "nested-grant-under-deny",
        message: expect.stringMatching(/\/work\/private\/allowed.*\/work\/private/u),
      }));
  });

  it("keeps both rows when the backend gives precedence to the most specific rule", () => {
    const policy = model([deny("/work/private")], read("/work"), write("/work/private/allowed"));
    expect(_rankPosixContainerRowsForTest(policy, "most-specific", lookups)).toEqual({
      readwrite: ["/work/private/allowed"], readonly: ["/work"], denied: ["/work/private"],
    });
  });

  it("refuses a deny that a grant reaches without a stamp", () => {
    expect(() => _assertPosixDenyOutcomesForTest(["/work/private"], [],
      { readwrite: [], readonly: ["/work"], denied: [] }, lookups.foldsCase))
      .toThrow(expect.objectContaining({ code: "deny-without-outcome" }));
  });

  it("deduplicates canonical spellings and removes grants and denies shadowed at the same precedence", () => {
    const policy = model([deny("/work/private/"), deny("/work/private/child"), deny("/Work/Private")],
      write("/work"), read("/work/"), write("/Work"), read("/tmp"), read("/private/tmp/"));
    expect(rankPosixContainerRows(policy, "seatbelt", { ...lookups, foldsCase: true })).toEqual({
      readwrite: ["/work"], readonly: ["/private/tmp"], denied: ["/work/private"],
    });
  });
});
