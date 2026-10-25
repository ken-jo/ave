// Drive classification accepts only X:, follows substituted drives and fails closed on unmapped drives.
// Output must contain only the resolved mapping.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("This test requires Windows");
const helper = resolve(`resources/windows-path-kind/${process.arch}/ave-path-kind.exe`);

function run(...args) {
  const result = spawnSync(helper, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function unusedDrives() {
  const unused = [];
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (run(`${letter}:`).code === 1) unused.push(`${letter}:`);
  }
  return unused;
}

const system = (process.env.SystemDrive ?? "C:").toUpperCase();
const local = run(system);
assert.equal(local.code, 0, local.stderr);
assert.match(local.stdout, /^\\Device\\HarddiskVolume\d+\r?\n$/u, `the system drive maps to a volume: ${JSON.stringify(local.stdout)}`);
assert.equal(local.stdout.split("\n").filter(Boolean).length, 1, "one line only");
console.log(`${system} -> ${local.stdout.trim()}`);

assert.equal(run(system.toLowerCase()).stdout, local.stdout);

for (const bad of ["C", "C:\\", "CC:", "1:", "\\\\server\\share", ""]) {
  const refused = run(bad);
  assert.equal(refused.code, 2, `"${bad}" is refused as usage`);
  assert.equal(refused.stdout, "");
}
assert.equal(run().code, 2, "no argument is usage");
assert.equal(run("C:", "D:").code, 2, "two arguments are usage");

const [free, second] = unusedDrives();
assert.ok(free && second, "two unused drive letters are available");

const missing = run(free);
assert.equal(missing.code, 1);
assert.equal(missing.stdout, "");
assert.match(missing.stderr, /QueryDosDeviceW failed: \d+/u);
console.log(`${free} (unmapped) -> exit 1`);

// Substituted drives return a native path whose drive must be classified in turn.
const target = mkdtempSync(join(tmpdir(), "ave path kind "));
try {
  execFileSync("subst", [free, target], { windowsHide: true });
  try {
    const subst = run(free);
    assert.equal(subst.code, 0, subst.stderr);
    assert.equal(subst.stdout.trim().toLowerCase(), `\\??\\${target}`.toLowerCase(), `subst maps to its target: ${JSON.stringify(subst.stdout)}`);
    console.log(`${free} (subst) -> ${subst.stdout.trim()}`);
    execFileSync("subst", [second, `${free}\\`], { windowsHide: true });
    try {
      const chained = run(second);
      assert.equal(chained.code, 0, chained.stderr);
      // Substituted drive roots are reported without a trailing separator.
      assert.equal(chained.stdout.trim().toLowerCase(), `\\??\\${free}`.toLowerCase());
      console.log(`${second} (subst of ${free}) -> ${chained.stdout.trim()}`);
    } finally {
      execFileSync("subst", [second, "/D"], { windowsHide: true });
    }
  } finally {
    execFileSync("subst", [free, "/D"], { windowsHide: true });
  }
  assert.equal(run(free).code, 1);
} finally {
  rmSync(target, { recursive: true, force: true });
}
console.log("windows-path-kind: ok");
