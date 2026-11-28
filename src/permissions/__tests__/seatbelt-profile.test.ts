import { describe, expect, it } from "vitest";
import { rankPosixContainerRows, type PosixPolicyLookups } from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel, type PolicyRow } from "../policy-model.js";
import { _seatbeltDenyGlobForTest, buildSeatbeltHolderProfile, buildSeatbeltShellProfile, isSeatbeltProfileTooLarge, seatbeltProfileAllowsOnlyProxyIpEgress, splitSeatbeltPolicyRows } from "../seatbelt-profile.js";

const lookups: PosixPolicyLookups = {
  home: "/users/example", foldsCase: true, canonical: path => path,
  exists: () => true, children: () => [], readable: () => true, directoryIdentity: () => undefined,
};

function fixture(paths = lookups) {
  const model = buildPolicyModel({
    userGrants: [], extensionManifests: [],
    floors: [
      policyFloorRow("/private/etc/hosts", "denied", "secrets", true),
      policyFloorRow("/vault", "denied", "read-boundary", true),
      policyFloorRow("/workspace/secret", "denied", "user-deny", true),
      policyFloorRow("/workspace/.ave/commands", "ro", "protected-name", true),
      policyFloorRow("/vault/open/**/*.key", "denied", "read-boundary", false),
    ],
    launchGrants: [
      policyGrantRow("/workspace", "rw", "launch-grant", true),
      policyGrantRow("/vault/open", "ro", "launch-grant", true),
    ],
  });
  const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", paths);
  return { model, grants, lookups: paths, unixSocketRoots: [], proxyPort: 9000 };
}

describe("Seatbelt shell profile", () => {
  it.each([
    ["/sessions/**/*.key", "^/sessions/(.*/)?[^/]*\\.key(/.*)?$"],
    ["/sessions/**/.env.*", "^/sessions/(.*/)?\\.env\\.[^/]*(/.*)?$"],
    ["/sessions/key?.pem", "^/sessions/key[^/]\\.pem(/.*)?$"],
    ["/sessions/**", "^/sessions(/.*)?$"],
    ["/.config/**/Login Data", "^/\\.config/(.*/)?Login Data(/.*)?$"],
    ["/**/.[gG][iI][tT]/[hH][oO][oO][kK][sS]", "^/(.*/)?\\.[gG][iI][tT]/[hH][oO][oO][kK][sS](/.*)?$"],
  ])("compiles %s with the existing deny semantics", (glob, expected) => {
    expect(_seatbeltDenyGlobForTest(glob, true)).toBe(expected);
  });

  it("renders the pinned baseline, allowances and denies for ranked rows", () => {
    expect(buildSeatbeltShellProfile(fixture())).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow process-fork)
      (allow process-exec)
      (allow signal (target same-sandbox))
      (allow sysctl-read)
      (allow mach-lookup
          (global-name "com.apple.system.notification_center")
          (global-name "com.apple.system.logger")
          (global-name "com.apple.distributed_notifications@Uv3")
          (global-name "com.apple.CoreServices.coreservicesd")
          (global-name "com.apple.FSEvents"))
      (allow file-read-metadata)
      (allow file-read-data (literal "/"))
      (allow file-read*
          (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin")
          (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share") (subpath "/System")
          (subpath "/Library") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld")
          (subpath "/private/var/select") (subpath "/private/etc"))
      (allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
      (allow file-read* (subpath "/dev/fd"))
      (allow file-read* file-write* (subpath "/workspace"))
      (allow file-read* (subpath "/vault/open"))
      (allow file-read* (subpath "/workspace/.ave/commands"))
      (allow network-outbound (remote ip "localhost:9000"))
      (deny file-write* file-write-create file-write-unlink network-bind network-outbound (subpath "/workspace/.ave/commands"))
      (deny file-read* file-read-metadata file-write* file-write-create file-write-unlink network-bind network-outbound (subpath "/workspace/secret"))
      (deny file-read* file-read-metadata file-write* file-write-create file-write-unlink network-bind network-outbound (require-all (subpath "/vault") (require-not (subpath "/vault/open")) (require-not (literal "/vault"))))
      (deny file-read* file-read-metadata file-write* file-write-create file-write-unlink network-bind network-outbound (subpath "/private/etc/hosts"))
      (deny file-write* file-write-create file-write-unlink (regex #"^/workspace/(\\.[aA][gG][eE][nN][tT][sS]|\\.[aA][vV][eE]/[cC][oO][mM][mM][aA][nN][dD][sS]|\\.[aA][vV][eE]/[hH][oO][oO][kK][sS])(/|$)"))
      (deny file-write-create file-write-unlink (regex #"^/workspace/(\\.[aA][vV][eE])$"))
      (deny file-write-create file-write-unlink (regex #"/\\.[gG][iI][tT]$"))
      (deny file-write* (require-all (regex #"/\\.[gG][iI][tT]$") (vnode-type REGULAR-FILE)))
      (deny file-write* file-write-create file-write-unlink (regex #"/srt-sock-[^/]*(/|$)"))
      (deny file-read* file-read-metadata file-write* file-write-create file-write-unlink network-bind network-outbound (regex #"^/vault/open/(.*/)?[^/]*\\.key(/.*)?$"))
      (deny file-write-unlink file-write-create (literal "/workspace/.ave") (literal "/workspace") (literal "/vault/open") (literal "/vault"))
      "
    `);
  });

  it("names the allowed operations in its denies and emits all allows before the deny block", () => {
    const profile = buildSeatbeltShellProfile(fixture());
    const topLevel = profile.split("\n").filter(line => /^\((allow|deny) /u.test(line)).slice(1);
    const firstDeny = topLevel.findIndex(line => line.startsWith("(deny "));
    expect(firstDeny).toBeGreaterThan(0);
    expect(topLevel.slice(firstDeny).every(line => line.startsWith("(deny "))).toBe(true);
    for (const input of ['(subpath "/workspace/secret")', '(subpath "/private/etc/hosts")',
      '(require-all (subpath "/vault")', '(regex #"^/vault/open/']) {
      const deny = topLevel.find(line => line.includes(input));
      expect(deny).toMatch(/^\(deny file-read\* file-read-metadata file-write\* file-write-create file-write-unlink network-bind network-outbound /u);
    }
    expect(profile).toContain('(require-not (subpath "/vault/open")) (require-not (literal "/vault"))');
    expect(profile).toContain('(deny file-write* file-write-create file-write-unlink network-bind network-outbound (subpath "/workspace/.ave/commands"))');
  });

  it("pins an alternate-case carrier on a case-sensitive volume", () => {
    const profile = buildSeatbeltShellProfile(fixture({ ...lookups, foldsCase: false }));
    expect(profile).toContain('(deny file-write-create file-write-unlink (regex #"^/workspace/(\\.[aA][vV][eE])$"))');
    expect(profile).toContain('[cC][oO][mM][mM][aA][nN][dD][sS](/.*)?$');
  });

  it("emits Unix socket allows only for explicitly listed paths", () => {
    expect(buildSeatbeltShellProfile(fixture())).not.toContain("unix-socket");
    const profile = buildSeatbeltShellProfile({ ...fixture(), unixSocketRoots: ["/test/socket-root"] });
    expect(profile).toContain('(allow network-bind (local unix-socket (subpath "/test/socket-root")))\n');
    expect(profile).toContain('(allow network-outbound (remote unix-socket (subpath "/test/socket-root")))\n');
  });

  it.each([
    ["/unsafe\npath", "profile-control-character"],
    [`/${"é".repeat(500)}`, "profile-string-too-long"],
    ["/com.microsoft.mxc.run.reserved", "profile-reserved-name"],
  ])("refuses invalid profile strings with a named reason", (path, code) => {
    expect(() => buildSeatbeltShellProfile({ ...fixture(), unixSocketRoots: [path] }))
      .toThrow(expect.objectContaining({ code }));
  });

  it("partitions the model itself and refuses a pattern grant", () => {
    const model = buildPolicyModel({
      userGrants: [], extensionManifests: [], floors: [],
      launchGrants: [policyGrantRow("/workspace/*", "ro", "launch-grant", false)],
    });
    expect(() => buildSeatbeltShellProfile({ ...fixture(), model }))
      .toThrow(expect.objectContaining({ code: "pattern-row" }));
  });
  it("keeps marked metacharacters literal and refuses an undecidable user class", () => {
    const literal = policyFloorRow("/sessions/[archive]", "denied", "read-boundary", true);
    const pattern = policyFloorRow("/sessions/[a-z].key", "denied", "user-deny", false);
    const model = buildPolicyModel({ floors: [literal, pattern], launchGrants: [], userGrants: [], extensionManifests: [] });
    expect(splitSeatbeltPolicyRows(model)).toEqual({ literalModel: { rows: [literal] }, patternRows: [pattern] });
    expect(() => buildSeatbeltShellProfile({ ...fixture(), model }))
      .toThrow(expect.objectContaining({ code: "pattern-undecidable" }));
  });
  it.each([true, false])("refuses a row whose reason the model does not know (literal %s), before it can read as a grant", (literal) => {
    const unknown = { path: "/workspace", literal, access: "rw", reason: "plugin-grant" } as unknown as PolicyRow;
    const model = { rows: [unknown] } as unknown as PolicyModel;
    expect(() => splitSeatbeltPolicyRows(model)).toThrow(expect.objectContaining({ code: "unknown-row" }));
    expect(() => buildSeatbeltShellProfile({ ...fixture(), model })).toThrow(expect.objectContaining({ code: "unknown-row" }));
  });
  it("still accepts every known grant and floor reason", () => {
    const rows: PolicyRow[] = [
      ...(["user-grant", "extension-manifest", "launch-grant"] as const).map(reason => policyGrantRow(`/g/${reason}`, "ro", reason, true)),
      policyGrantRow("/g/pierce", "ro", "floor-pierce", true),
      ...(["secrets", "ave-home", "read-boundary", "protected-name", "user-deny"] as const)
        .map(reason => policyFloorRow(`/f/${reason}`, "denied", reason, true)),
      policyFloorRow("/f/required", "ro", "required-write-deny", true),
    ];
    expect(splitSeatbeltPolicyRows({ rows } as unknown as PolicyModel).literalModel.rows).toEqual(rows);
  });
});

describe("Seatbelt structural IP egress evidence", () => {
  const built = (unixSocketRoots: string[] = []) => buildSeatbeltShellProfile({ ...fixture(), unixSocketRoots });

  it("holds for the profile the builder writes, with or without Unix-socket roots", () => {
    expect(seatbeltProfileAllowsOnlyProxyIpEgress(built(), 9000)).toBe(true);
    expect(seatbeltProfileAllowsOnlyProxyIpEgress(built(["/test/socket-root"]), 9000)).toBe(true);
  });

  it("judges the rules, not the text: a rule's words inside a path literal open nothing", () => {
    const quoted = `${built()}\n(allow file-read* (literal "/x (allow network* (remote ip \\"*:*\\"))"))`;
    expect(seatbeltProfileAllowsOnlyProxyIpEgress(quoted, 9000)).toBe(true);
  });

  it.each([
    ["another proxy port", (profile: string) => profile, 9001],
    ["a second IP allow", (profile: string) => `${profile}\n(allow network* (remote ip "*:*"))`, 9000],
    ["an IP allow split across lines", (profile: string) => `${profile}\n(allow network-outbound\n    (remote ip "*:*"))`, 9000],
    ["an unfiltered network allow", (profile: string) => `${profile}\n(allow network-outbound)`, 9000],
    ["a TCP filter", (profile: string) => `${profile}\n(allow network-outbound (remote tcp "*:443"))`, 9000],
    ["the proxy filter beside another one", (profile: string) =>
      profile.replace('(allow network-outbound (remote ip "localhost:9000"))', '(allow network-outbound (remote ip "localhost:9000") (remote ip "*:*"))'), 9000],
    ["an allow default", (profile: string) => `${profile}\n(allow default)`, 9000],
    ["no default deny", (profile: string) => profile.replace("(deny default)", ""), 9000],
    ["no proxy allow", (profile: string) => profile.replace('(allow network-outbound (remote ip "localhost:9000"))', ""), 9000],
    ["two proxy allows", (profile: string) => `${profile}\n(allow network-outbound (remote ip "localhost:9000"))`, 9000],
    ["an unbalanced form", (profile: string) => `${profile}\n(allow network-outbound (remote ip "*:*")`, 9000],
    ["an unterminated string", (profile: string) => `${profile}\n(allow file-read* (literal "/x))`, 9000],
    ["an allow nested in another form", (profile: string) => `${profile}\n(if #t (allow network* (remote ip "*:*")))`, 9000],
    ["an import", (profile: string) => `${profile}\n(import "system.sb")`, 9000],
    ["a top-level atom", (profile: string) => `${profile}\nallow`, 9000],
    ["a Unix-socket filter with an IP third item", (profile: string) =>
      `${profile}\n(allow network-outbound (remote unix-socket (remote ip "*:*")))`, 9000],
    ["a Unix-socket filter with a bare third item", (profile: string) => `${profile}\n(allow network-outbound (remote unix-socket any))`, 9000],
  ])("does not hold with %s", (_name, edit, port) => {
    expect(seatbeltProfileAllowsOnlyProxyIpEgress(edit(built()), port)).toBe(false);
  });
});

describe("Seatbelt shell and holder profile size", () => {
  const labels = { holder: "dev.ave.holder.i0.b0.h1", boot: "dev.ave.holder.i0.b0.all", instance: "dev.ave.holder.i0.any" };
  const withDenies = (count: number) => {
    const model = buildPolicyModel({
      userGrants: [], extensionManifests: [],
      floors: Array.from({ length: count }, (_, index) => policyFloorRow(`/vault/folder-${String(index).padStart(5, "0")}/with/some/depth`, "denied", "secrets", true)),
      launchGrants: [policyGrantRow("/workspace", "rw", "launch-grant", true)],
    });
    const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", lookups);
    return { model, grants, lookups, unixSocketRoots: [], proxyPort: null, labels };
  };

  it("builds a profile within the bound and refuses one past it by name, before the kernel compiles it", () => {
    expect(Buffer.byteLength(buildSeatbeltHolderProfile(withDenies(100)))).toBeLessThan(128 * 1024);
    expect(() => buildSeatbeltHolderProfile(withDenies(3_000))).toThrow(expect.objectContaining({ code: "profile-string-too-long" }));
  });

  it("bounds a shell profile the same way: a policy within the bound builds, one past it is refused by name", () => {
    const shell = (count: number) => ({ ...withDenies(count), proxyPort: 4100 });
    expect(Buffer.byteLength(buildSeatbeltShellProfile(shell(100)))).toBeLessThan(128 * 1024);
    expect(() => buildSeatbeltShellProfile(shell(3_000))).toThrow(expect.objectContaining({ code: "profile-string-too-long", message: expect.stringContaining("shell") }));
  });

  it("names an over-cap profile for the shell's user-facing refusal, and nothing else", () => {
    const shell = (count: number) => ({ ...withDenies(count), proxyPort: 4100 });
    let refusal: unknown;
    try { buildSeatbeltShellProfile(shell(3_000)); } catch (error) { refusal = error; }
    expect(isSeatbeltProfileTooLarge(refusal)).toBe(true);
    let other: unknown;
    try { buildSeatbeltShellProfile({ ...shell(1), proxyPort: 0 }); } catch (error) { other = error; }
    expect(other).toBeDefined();
    expect(isSeatbeltProfileTooLarge(other)).toBe(false);
    expect(isSeatbeltProfileTooLarge(new Error("Container shell profile exceeds the size limit"))).toBe(false);
  });
});
