// windows-permission
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { takeWindowsHelperLaunches } from "../../__tests__/support/windows-helper-spawns.js";
import { configureHostResources } from "../../main/host-resources.js";
import { withLocalityDecision } from "../../shared/local-path-io.js";
import { admitObligations, admitWindowsLookupPaths } from "../admitted-obligation.js";

const failNextPin = vi.hoisted(() => ({ armed: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const counted = (await import("../../__tests__/support/windows-helper-spawns.js")).countingChildProcess(actual);
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const argv = args[1];
    if (failNextPin.armed && Array.isArray(argv) && argv[0] === "--pin") {
      failNextPin.armed = false;
      // The helper exits 4 when it cannot open or read a requested path.
      throw Object.assign(new Error("Command failed"), { status: 4 });
    }
    return counted.execFileSync(...args);
  }) as typeof actual.execFileSync;
  return { ...counted, execFileSync, default: { ...counted, execFileSync } };
});

describe.runIf(process.platform === "win32")("pin facts within one decision", () => {
  let root: string;
  let a: string;
  let b: string;
  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "pin-memo-")));
    a = join(root, "a.txt");
    b = join(root, "b.txt");
    writeFileSync(a, "");
    writeFileSync(b, "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => { takeWindowsHelperLaunches(); });
  const pins = () => takeWindowsHelperLaunches()["--pin"] ?? 0;
  const lookUp = (path: string) => admitWindowsLookupPaths([path], "preview").get(path);

  it("pins a spelling once per decision and every other spelling on its own", () => {
    withLocalityDecision(() => {
      expect(lookUp(a)?.kind).toBe("file");
      expect(pins()).toBe(1);
      expect(lookUp(a)?.kind).toBe("file");
      expect(pins()).toBe(0);
      expect(lookUp(b)?.kind).toBe("file");
      expect(pins()).toBe(1);
    });
  });

  it("pins again in the next decision", () => {
    withLocalityDecision(() => lookUp(a));
    withLocalityDecision(() => lookUp(a));
    expect(pins()).toBe(2);
  });

  it("does not keep a failed pin", () => {
    withLocalityDecision(() => {
      failNextPin.armed = true;
      expect(lookUp(a)).toBeUndefined();
      pins();
      expect(lookUp(a)?.kind).toBe("file");
      expect(pins()).toBe(1);
    });
  });

  it("pins grants afresh within a decision", () => {
    const grant = () => admitObligations({ purpose: "worker-grant", principal: "srt-sandbox", rows: [{ spelling: a, polarity: { effect: "allow", access: "read" }, source: "worker-request" }] });
    withLocalityDecision(() => { grant(); grant(); });
    expect(pins()).toBe(2);
  });
});
