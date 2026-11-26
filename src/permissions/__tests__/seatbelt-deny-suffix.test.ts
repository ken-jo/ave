import { describe, expect, it } from "vitest";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";
import { _seatbeltDenyGlobForTest, buildSeatbeltDenySuffix, splitSeatbeltPolicyRows } from "../seatbelt-deny-suffix.js";
import { parseSeatbeltProfile } from "../mxc-macos.js";

const lookups = { home: "/users/example", canonical: (path: string) => path, foldsCase: true };

describe("Seatbelt deny suffix", () => {
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

  it("emits only deny forms, pins every protected ancestor below root and quotes literals", () => {
    const suffix = buildSeatbeltDenySuffix({
      literals: [
        policyFloorRow('/project/a"b/quoted\\path/secret', "denied", "secrets", true),
        policyFloorRow("/project/.git/hooks", "ro", "protected-name", true),
        policyFloorRow("/elsewhere/private", "denied", "user-deny", true),
      ],
      patterns: [
        policyFloorRow("/sessions/**/*.key", "denied", "read-boundary", false),
        policyFloorRow("/**/.[gG][iI][tT]/[cC]onfig", "ro", "protected-name", false),
      ],
      writeRoots: ["/project"], lookups,
    });
    expect(suffix.trimEnd().split("\n")).toEqual([
      '(deny file-write-unlink file-write-create (literal "/project/a\\"b/quoted\\\\path") (literal "/project/a\\"b") (literal "/project") (literal "/project/.git"))',
      "(deny network-outbound (remote unix-socket))",
      "(deny network-bind (local unix-socket))",
      '(deny file-read* file-read-metadata (regex #"^/sessions/(.*/)?[^/]*\\.key(/.*)?$"))',
      '(deny file-write* (regex #"^/(.*/)?\\.[gG][iI][tT]/[cC]onfig(/.*)?$"))',
    ]);
    expect(suffix.trimEnd().split("\n").every(line => line.startsWith("(deny "))).toBe(true);
  });

  it("adds case-variant write-floor denies for a case-sensitive volume", () => {
    expect(buildSeatbeltDenySuffix({
      literals: [policyFloorRow("/project/.agents", "ro", "protected-name", true)],
      patterns: [], writeRoots: ["/project"], lookups: { ...lookups, foldsCase: false },
    })).toContain('^/project/\\.[aA][gG][eE][nN][tT][sS](/.*)?$');
  });

  it("splits pattern denies before ranking and refuses a pattern grant or an undecidable class", () => {
    const literal = policyFloorRow("/sessions/[archive]", "denied", "read-boundary", true);
    const pattern = policyFloorRow("/sessions/**/*.key", "denied", "read-boundary", false);
    const model = buildPolicyModel({ floors: [literal, pattern], launchGrants: [], userGrants: [], extensionManifests: [] });
    expect(splitSeatbeltPolicyRows(model)).toEqual({ literalModel: { rows: [literal] }, patternRows: [pattern] });
    const badGrant = buildPolicyModel({
      floors: [], launchGrants: [policyGrantRow("/work/*", "ro", "launch-grant", false)],
      userGrants: [], extensionManifests: [],
    });
    expect(() => splitSeatbeltPolicyRows(badGrant)).toThrow(expect.objectContaining({ code: "pattern-row" }));
    expect(() => buildSeatbeltDenySuffix({
      literals: [], patterns: [policyFloorRow("/sessions/[a-z].key", "denied", "user-deny", false)],
      writeRoots: [], lookups,
    })).toThrow(expect.objectContaining({ code: "pattern-undecidable" }));
  });
});

describe("Seatbelt profile extraction", () => {
  const begin = "Seatbelt: --- begin generated profile ---\n";
  const end = "Seatbelt: --- end generated profile ---\n";
  const body = "(version 1)\n(deny default)\n(allow process-exec)\n";

  it("extracts exactly one generated profile with a closed default", () => {
    expect(parseSeatbeltProfile(`debug\n${begin}${body}${end}done\n`)).toBe(body);
  });

  it.each([body, begin + body, end + body + begin, begin + begin + body + end, begin + body + end + end,
    `${begin}(version 1)\n(allow default)\n${end}`])("refuses unexpected output %#", (output) => {
    expect(() => parseSeatbeltProfile(output)).toThrow(expect.objectContaining({ code: "profile-unreadable" }));
  });
});
