import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { win32SystemBinary } from "../ave-home.js";
import { configureHostResources } from "../../main/host-resources.js";
import { resolve } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { readWindowsReadDenyEvidence, recheckWindowsReadDenyEvidence, windowsReadDenyEvidence, windowsReadDenyKey, type WindowsReadDenySnapshot } from "../windows-read-deny-evidence.js";
import * as windowsPathFacts from "../windows-path-facts.js";

describe.runIf(process.platform === "win32")("Windows read deny native evidence", () => {
  let fixture: string;
  let snapshot: WindowsReadDenySnapshot;
  let beforeNames: string[];
  let beforeAcl: string;

  beforeAll(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
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
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "everyone")))).toMatchObject({ status: "readable", principals: ["Everyone"] });
  });

  it("reports the private control without a broad read grant", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "control")))).toMatchObject({ status: "private" });
  });

  it("reports built-in users read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "users")))).toMatchObject({ status: "readable", principals: ["Users"] });
  });

  it("reports authenticated users read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "authenticated")))).toMatchObject({ status: "readable", principals: ["Authenticated Users"] });
  });

  it("reports interactive read grants", () => {
    expect(snapshot.get(windowsReadDenyKey(join(fixture, "interactive")))).toMatchObject({ status: "readable", principals: ["INTERACTIVE"] });
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

  it("matches native volume and file identity to no-follow bigint stats on this host", () => {
    const file = join(fixture, "control");
    const directory = join(fixture, "inherited");
    const fileStat = lstatSync(file, { bigint: true });
    const directoryStat = lstatSync(directory, { bigint: true });
    expect(snapshot.get(windowsReadDenyKey(file))?.identity).toEqual({ volumeSerialNumber: fileStat.dev.toString(), fileId: fileStat.ino.toString() });
    expect(snapshot.get(windowsReadDenyKey(directory))?.identity).toEqual({ volumeSerialNumber: directoryStat.dev.toString(), fileId: directoryStat.ino.toString() });
    expect(windowsReadDenyEvidence(file, snapshot).status).toBe("private");
    expect(windowsReadDenyEvidence(join(fixture, "missing"), snapshot).status).toBe("missing");
  });

  it("batches descriptor reads and use-time pins without retaining checked verdicts", async () => {
    const paths = [join(fixture, "control"), join(fixture, "everyone"), join(fixture, "missing")];
    const reads = vi.spyOn(windowsPathFacts, "readWindowsDacls");
    const pins = vi.spyOn(windowsPathFacts, "pinWindowsPaths");
    try {
      const fresh = await readWindowsReadDenyEvidence(paths);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledWith(paths);
      const checked = recheckWindowsReadDenyEvidence(paths, fresh);
      expect(pins).toHaveBeenCalledTimes(1);
      expect(checked.get(windowsReadDenyKey(paths[0]!))?.status).toBe("private");
      expect(checked.get(windowsReadDenyKey(paths[1]!))?.status).toBe("readable");
      expect(checked.get(windowsReadDenyKey(paths[2]!))?.status).toBe("missing");
      const target = paths[0]!;
      renameSync(target, target + ".old");
      try {
        writeFileSync(target, "replacement");
        expect(recheckWindowsReadDenyEvidence(paths, fresh).get(windowsReadDenyKey(target))?.status).toBe("error");
      } finally {
        fs.unlinkSync(target);
        renameSync(target + ".old", target);
      }
      const mixed = recheckWindowsReadDenyEvidence([target, join(fixture, "invalid|target")], new Map([
        [windowsReadDenyKey(target), fresh.get(windowsReadDenyKey(target))!],
        [windowsReadDenyKey(join(fixture, "invalid|target")), fresh.get(windowsReadDenyKey(target))!],
      ]));
      expect(mixed.get(windowsReadDenyKey(target))?.status).toBe("private");
      expect(mixed.get(windowsReadDenyKey(join(fixture, "invalid|target")))?.status).toBe("error");
    } finally {
      reads.mockRestore();
      pins.mockRestore();
    }
  });
});

describe("Windows read deny evidence admission", () => {
  it("keeps a private target whose path is now missing", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-missing-private-"));
    try {
      const path = join(fixture, "secret");
      const snapshot: WindowsReadDenySnapshot = new Map([[windowsReadDenyKey(path), {
        status: "private", identity: { volumeSerialNumber: "1", fileId: "1" },
      }]]);
      expect(windowsReadDenyEvidence(path, snapshot).status).toBe("error");
    } finally {
      await cleanupTmpDir(fixture);
    }
  });

  it("keeps a target when a no-follow identity check fails", () => {
    const path = join(tmpdir(), "stat-denied-secret");
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw Object.assign(new Error("Access denied"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    try {
      expect(windowsReadDenyEvidence(path, new Map([[windowsReadDenyKey(path), { status: "missing" }]])).status).toBe("error");
      expect(windowsReadDenyEvidence(path, new Map([[windowsReadDenyKey(path), { status: "private" }]])).status).toBe("error");
      expect(stat).toHaveBeenCalledWith(path, { bigint: true, throwIfNoEntry: false });
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("fails closed when a target is omitted from an injected snapshot", () => {
    expect(windowsReadDenyEvidence(join(tmpdir(), "omitted-secret"), new Map()).status).toBe("error");
  });

  it("returns an empty snapshot without a native process for no targets", async () => {
    expect(await readWindowsReadDenyEvidence([])).toEqual(new Map());
  });
});
