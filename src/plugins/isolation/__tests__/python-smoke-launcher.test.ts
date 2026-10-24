/**
 * The cross-language smoke's launcher, run the way the host runs it
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P5, decision 46).
 *
 * `bin/plugin` is the plugin's whole contract with its interpreter: the host
 * hands it `PLUGIN_ROOT` and `PLUGIN_DATA` and nothing Python-specific, and
 * `PYTHONPATH` is a name the host reserves. So the launcher must point the
 * interpreter at `<root>/vendor` itself. The provisioning check cannot show
 * that — it sets `PYTHONPATH` on its own — so this runs the real launcher
 * under `env -i`, with no `PYTHONPATH`, `PYTHONHOME` or `PYTHONUSERBASE` from
 * the harness, and asks where `mcp` was imported from. A launcher that dropped
 * `PYTHONPATH` fails either way the defect shows: `ModuleNotFoundError` where
 * the interpreter has no `mcp` of its own, an origin outside `<root>/vendor`
 * where it has one (and `-s` keeps a user site directory from being it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { installPythonSmoke, provisionPythonSmoke, removeAppleDoubleSidecars } from "./python-smoke-harness.js";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "python-smoke-launcher-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the python smoke's cached vendor directory", () => {
  it("loses the AppleDouble sidecars a bsdtar-made cache leaves, and nothing else", () => {
    const vendor = mkdtempSync(join(scratch, "vendor-"));
    const distInfo = join(vendor, "mcp-2.2.0.dist-info");
    mkdirSync(distInfo);
    writeFileSync(join(distInfo, "METADATA"), "Metadata-Version: 2.4\nName: mcp\nVersion: 2.2.0\n");
    // The first 48 bytes of the sidecar macOS bsdtar wrote for this directory:
    // the AppleDouble header, whose byte 0xa3 at offset 45 is what
    // importlib.metadata failed to decode as UTF-8.
    const header = Buffer.from(
      "00051607000200004d6163204f5320582020202020202020"
        + "000200000009000000320000007100000002000000a30000",
      "hex",
    );
    expect(header[45]).toBe(0xa3);
    writeFileSync(join(vendor, "._mcp-2.2.0.dist-info"), header);
    writeFileSync(join(distInfo, "._RECORD"), header);
    writeFileSync(join(vendor, "._ordinary.py"), header);
    writeFileSync(join(vendor, "_private.py"), "");

    expect(removeAppleDoubleSidecars(vendor)).toEqual([
      "._mcp-2.2.0.dist-info",
      "._ordinary.py",
      join("mcp-2.2.0.dist-info", "._RECORD"),
    ]);
    expect(existsSync(join(distInfo, "METADATA"))).toBe(true);
    expect(existsSync(join(vendor, "_private.py"))).toBe(true);
    expect(removeAppleDoubleSidecars(vendor)).toEqual([]);
  });
});

// A `process` entry never runs on win32, and `bin/plugin` is a POSIX shell script.
describe.runIf(process.platform !== "win32")("the python smoke's launcher", () => {
  it("imports mcp from the plugin's own vendor directory, with nothing but PLUGIN_ROOT and PLUGIN_DATA", () => {
    const python = provisionPythonSmoke();
    const root = installPythonSmoke(join(scratch, "plugin"), python);
    const data = mkdtempSync(join(scratch, "data-"));
    const origin = execFileSync(
      "/usr/bin/env",
      ["-i", "PATH=/usr/bin:/bin", `PLUGIN_ROOT=${root}`, `PLUGIN_DATA=${data}`, join(root, "bin", "plugin"), "--print-mcp-origin"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    expect(realpathSync(origin).startsWith(realpathSync(join(root, "vendor")) + sep), origin).toBe(true);
  }, 600_000);
});
