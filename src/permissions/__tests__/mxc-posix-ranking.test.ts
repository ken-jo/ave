import type { ContainerBackend } from "../../shared/container-platform.js";
import { describe, expect, it } from "vitest";
import {
  _assertPosixDenyOutcomesForTest, _rankPosixContainerRowsForTest,
  PosixContainerPolicyError, rankPosixContainerRows, type PosixPolicyLookups, type PosixPolicyRefusal,
} from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyFloorRow, type PolicyGrantRow } from "../policy-model.js";

const lookups: PosixPolicyLookups = {
  home: "/users/example", foldsCase: false,
  children: () => [],
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

  it.each(["constructor", "toString", "__proto__"])("refuses inherited backend name %s", (backend) => {
    expect(() => rankPosixContainerRows(model([], read("/work")), backend as ContainerBackend, lookups))
      .toThrow(expect.objectContaining({ code: "backend-unmeasured" }));
  });

  it.each([
    ["~/work/**", "pattern-row"],
    ["/work/.git/[h]ooks", "pattern-row"],
    ["work/relative", "relative-row"],
  ] as const satisfies readonly (readonly [string, PosixPolicyRefusal])[])("refuses unrepresentable spelling %s", (path, code) => {
    expect(() => rankPosixContainerRows(model([policyFloorRow(path, "ro", "protected-name", false)]), "seatbelt", lookups)).toThrow(expect.objectContaining({ code }));
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

  it("does not keep write access beneath a read-only floor pierce", () => {
    const policy = model([deny("/sealed", "secrets")], write("/sealed/history"), pierce("/sealed/history"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups))
      .toEqual({ readwrite: [], readonly: ["/sealed/history"], denied: [] });
  });

  it("keeps a precisely pierced floor read-only under a wider write grant", () => {
    const policy = model([deny("/work/sealed", "secrets")],
      write("/work"), read("/work/sealed"), pierce("/work/sealed"));
    expect(rankPosixContainerRows(policy, "seatbelt", lookups))
      .toEqual({ readwrite: ["/work"], readonly: ["/work/sealed"], denied: [] });
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

  it("opens a narrower grant without emitting its enclosing deny", () => {
    const policy = model([deny("/work/private", "ave-home")], read("/work"), read("/work/private/allowed"));
    expect(rankPosixContainerRows(policy, "seatbelt", {
      ...lookups, children: (path) => path === "/work" ? ["private", "public"] : [],
    })).toEqual({ readwrite: [], readonly: ["/work/private/allowed", "/work/public"], denied: [] });
  });

  it("carves broad reads and writes around private roots and resolves aliases before granting children", () => {
    const home = "/private/tmp/home";
    const ave = `${home}/.ave`;
    const folders: Record<string, string[]> = {
      "/": ["bin", "dev", "tmp", "dangling", "private", "work"],
      "/private": ["tmp", "var"],
      "/private/tmp": ["home", "alias", "notes"],
      [home]: [".ave", ".ssh", "Documents", "public.txt"],
    };
    const policy = model([
      deny(ave, "ave-home"), deny(`${home}/.ssh`, "secrets"),
      deny(`${ave}/sessions`, "secrets"), deny("/work/blocked", "user-deny"),
      protect("/work/.git/hooks"),
    ], read("/"), write(home), write("/work"), write(`${ave}/sandbox/own`),
    read(`${ave}/plugin`), read(`${ave}/sessions/access`), pierce(`${ave}/sessions/access`));
    const result = rankPosixContainerRows(policy, "seatbelt", {
      ...lookups,
      children: (path) => {
        if (path === ave || path.startsWith(`${ave}/`)) throw new Error("Do not enumerate the denied subtree");
        return folders[path] ?? [];
      },
      canonical: (path) => {
        if (path === "/dangling") throw Object.assign(new Error("Dangling link"), { code: "ENOENT" });
        if (path === "/private/tmp/alias") return home;
        return lookups.canonical(path);
      },
    });
    expect(result).toEqual({
      readwrite: ["/work", `${ave}/sandbox/own`, `${home}/Documents`, `${home}/public.txt`],
      readonly: [
        `${ave}/plugin`, `${ave}/sessions/access`, "/bin", "/private/var", "/private/tmp/notes",
        "/work/.git/hooks",
      ],
      denied: ["/work/blocked"],
    });
  });

  it.each([401, 2001])("withholds the whole folder that exceeds the carve budget with %i entries", (count) => {
    const result = rankPosixContainerRows(model([], read("/"), write("/work")), "seatbelt", {
      ...lookups, children: () => Array.from({ length: count }, (_, index) => `entry-${index}`),
    });
    expect(result).toEqual({ readwrite: ["/work"], readonly: [], denied: [], carvedReadLimitedAt: ["/"] });
  });

  it("refuses 401 distinct admitted leaves and names the first grant over the cap", () => {
    const leaves = Array.from({ length: 401 }, (_, index) => read(`/admitted/leaf-${index}`));
    expect(() => rankPosixContainerRows(model([], ...leaves), "seatbelt", lookups))
      .toThrow(expect.objectContaining({ code: "grant-limit-exceeded", message: expect.stringContaining("/admitted/leaf-400") }));
  });

  it("counts required read-only floor rows and deduplicates them against admitted grants", () => {
    const floor = "/work/control";
    const leaves = Array.from({ length: 399 }, (_, index) => read(`/admitted/leaf-${index}`));
    const full = rankPosixContainerRows(model([protect(floor)], write("/work"), ...leaves.slice(1), read(floor)), "seatbelt", lookups);
    expect(full.readonly).toHaveLength(399);
    expect(full.readwrite).toEqual(["/work"]);
    expect(() => rankPosixContainerRows(model([protect(floor)], write("/work"), ...leaves), "seatbelt", lookups))
      .toThrow(expect.objectContaining({ code: "grant-limit-exceeded", message: expect.stringContaining(floor) }));
  });

  it("uses the last grant slot when a retained deny already enforces a write floor", () => {
    const leaves = Array.from({ length: 398 }, (_, index) => read(`/admitted/leaf-${index}`));
    const policy = model([protect("/work/blocked/control"), deny("/work/blocked")], read("/"), write("/work"), ...leaves);
    const result = rankPosixContainerRows(policy, "seatbelt", {
      ...lookups, children: () => ["public"],
    });
    expect(result.readonly).toHaveLength(399);
    expect(result.readonly).toContain("/public");
    expect(result.denied).toEqual(["/work/blocked"]);
    expect(result.carvedReadLimitedAt).toBeUndefined();
  });

  it("refuses an unreadable chain by name", () => {
    const policy = model([deny("/work/private", "ave-home")], read("/work"), read("/work/private/open"));
    expect(() => rankPosixContainerRows(policy, "seatbelt", {
      ...lookups, children: () => { throw new Error("Cannot enumerate directory"); },
    })).toThrow(expect.objectContaining({ code: "chain-unreadable", message: expect.stringContaining("/work") }));
  });

  it("keeps both rows when the backend gives precedence to the most specific rule", () => {
    const policy = model([deny("/work/private")], read("/work"), write("/work/private/allowed"));
    expect(_rankPosixContainerRowsForTest(policy, "most-specific", lookups)).toEqual({
      readwrite: ["/work/private/allowed"], readonly: ["/work"], denied: ["/work/private"],
    });
  });

  it("keeps an inner deny when a nearer grant outranks its ancestor deny", () => {
    const outer = "/work/private";
    const inner = "/work/private/reopened/secret";
    const policy = model([deny(inner), deny(outer), deny(`${inner}/nested`)],
      read("/work"), read("/work/private/reopened"));
    const ranked = _rankPosixContainerRowsForTest(policy, "most-specific", lookups);
    expect(ranked.denied).toEqual([inner, outer]);
  });

  it("refuses an effective deny lost beneath a nearer grant", () => {
    expect(() => _assertPosixDenyOutcomesForTest(["/work/private/reopened/secret"], [], {
      readwrite: [], readonly: ["/work", "/work/private/reopened"], denied: ["/work/private"],
    }, lookups.foldsCase, "most-specific")).toThrow(expect.objectContaining({
      code: "deny-without-outcome", message: expect.stringContaining("/work/private/reopened/secret"),
    }));
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
