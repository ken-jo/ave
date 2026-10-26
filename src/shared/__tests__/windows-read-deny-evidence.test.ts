import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { win32SystemBinary } from "../ave-home.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { readWindowsReadDenyEvidence, windowsReadDenyEvidence, windowsReadDenyKey, type WindowsReadDenySnapshot } from "../windows-read-deny-evidence.js";

describe.runIf(process.platform === "win32")("Windows read deny native evidence", () => {
  let fixture: string;
  let snapshot: WindowsReadDenySnapshot;
  let beforeNames: string[];
  let beforeAcl: string;

  beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), "ave-read-deny-"));
    const identity = execFileSync(win32SystemBinary("whoami"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-1-[0-9-]+/)?.[0];
    if (sid === undefined) throw new Error("Fixture owner SID unavailable");
    const icacls = win32SystemBinary("icacls");
    execFileSync(icacls, [fixture, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true });
    for (const name of ["everyone", "control", "users", "authenticated", "interactive", "execute-only", "generic-read", "generic-all"]) {
      writeFileSync(join(fixture, name), "fixture");
    }
    execFileSync(icacls, [join(fixture, "everyone"), "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "users"), "/grant", "*S-1-5-32-545:(R)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "authenticated"), "/grant", "*S-1-5-11:(R)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "interactive"), "/grant", "*S-1-5-4:(R)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "execute-only"), "/grant", "*S-1-1-0:(X)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "generic-read"), "/grant", "*S-1-1-0:(GR)"], { windowsHide: true });
    execFileSync(icacls, [join(fixture, "generic-all"), "/grant", "*S-1-1-0:(GA)"], { windowsHide: true });
    mkdirSync(join(fixture, "inherited"));
    execFileSync(icacls, [join(fixture, "inherited"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { windowsHide: true });
    writeFileSync(join(fixture, "inherited", "child"), "fixture");
    symlinkSync(join(fixture, "inherited"), join(fixture, "junction"), "junction");
    beforeNames = readdirSync(fixture);
    beforeAcl = execFileSync(icacls, [fixture, "/T"], { encoding: "utf8", windowsHide: true });
    snapshot = await readWindowsReadDenyEvidence([
      ...beforeNames.map(name => join(fixture, name)), join(fixture, "inherited", "child"), join(fixture, "missing"),
      join(fixture, "invalid|target"),
    ]);
  }, 30_000);

  afterAll(async () => {
    if (fixture !== undefined) await cleanupTmpDir(fixture);
  });

  it("reports an explicit world read grant", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "everyone")))).toEqual({ status: "readable", reason: "S-1-1-0" });
  });

  it("reports the private control without a broad read grant", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "control")))).toEqual({ status: "private" });
  });

  it("reports built-in users read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "users")))).toEqual({ status: "readable", reason: "S-1-5-32-545" });
  });

  it("reports authenticated users read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "authenticated")))).toEqual({ status: "readable", reason: "S-1-5-11" });
  });

  it("reports interactive read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "interactive")))).toEqual({ status: "readable", reason: "S-1-5-4" });
  });

  it("maps generic read to file data access", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "generic-read")))?.status).toBe("readable");
  });

  it("maps generic all to file data access", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "generic-all")))?.status).toBe("readable");
  });

  it("does not treat execute access as read data", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "execute-only")))?.status).toBe("private");
  });

  it("counts inherited read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "inherited", "child")))?.status).toBe("readable");
  });

  it("opens the target junction without following it", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "junction")))?.status).toBe("reparse");
    expect(lstatSync(join(fixture, "junction")).isSymbolicLink()).toBe(true);
  });

  it("reports a missing target without creating it", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "missing")))?.status).toBe("missing");
    expect(readdirSync(fixture)).toEqual(beforeNames);
  });

  it("keeps native failures distinct from missing targets", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "invalid|target")))?.status).toBe("error");
  });

  it("does not change fixture security descriptors", () => {
    expect(execFileSync(win32SystemBinary("icacls"), [fixture, "/T"], { encoding: "utf8", windowsHide: true })).toBe(beforeAcl);
  });
});

describe("Windows read deny evidence admission", () => {
  it("fails closed when a target is omitted from an injected snapshot", () => {
    expect(windowsReadDenyEvidence(join(tmpdir(), "omitted-secret"), new Map()).status).toBe("error");
  });

  it("returns an empty snapshot without a native process for no targets", async () => {
    expect(await readWindowsReadDenyEvidence([])).toEqual(new Map());
  });
});
