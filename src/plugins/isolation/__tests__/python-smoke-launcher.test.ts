/** Run the POSIX launcher through the selected interpreter and isolated vendor tree. */
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
    // Use real sidecar header bytes to reproduce invalid UTF-8 during distribution discovery.
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

// Process entries exclude Windows; this launcher is a POSIX shell script.
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
