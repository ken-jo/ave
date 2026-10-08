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
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { installPythonSmoke, provisionPythonSmoke } from "./python-smoke-harness.js";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "python-smoke-launcher-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
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
