import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every native extension container must be authorized by row-2 admission (`spawnMxcConfinedChild`), which runs the start
// guard, the single-use receipt, the co-holder nesting registry, the executable re-measure and HOME/temp placement in the
// primitive's `beforeSpawn`. A module that called the primitive directly would bypass all of it, so the caller set is
// pinned here: a later change (or merge) that adds another caller fails this test instead of silently spawning.
const SANCTIONED: Readonly<Record<string, readonly string[]>> = {
  spawnMxcExtensionProcess: ["src/permissions/confined-child.ts", "src/permissions/mxc-extension-process.ts"],
  spawnMxcExtensionProcessForDiagnostics: ["tools/mxc-probes/packaged-main.ts", "src/permissions/mxc-extension-process.ts"],
  _spawnMxcExtensionProcessForTest: ["src/permissions/mxc-extension-process.ts"],
};

function productionSources(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "src", "tools", "scripts"], { encoding: "utf8" }).split("\0");
  return tracked.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file)
    && !/(?:^|\/)__tests__\//u.test(file) && !/\.test\.[cm]?[jt]sx?$/u.test(file) && !/(?:^|\/)__probes__\//u.test(file));
}

describe("native extension spawn callers", () => {
  const sources = productionSources().map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("scans the real tracked tree", () => {
    expect(sources.some(({ file }) => file === "src/permissions/confined-child.ts")).toBe(true);
    expect(sources.some(({ file }) => file === "tools/mxc-probes/packaged-main.ts")).toBe(true);
  });

  it.each(Object.entries(SANCTIONED))("only sanctioned modules reference %s", (name, allowed) => {
    const pattern = new RegExp(`\\b${name}\\b`, "u");
    const callers = sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort();
    expect(callers).toEqual([...allowed].sort());
  });

  it("the sanctioned production caller passes its admission at the spawn boundary", () => {
    const text = readFileSync("src/permissions/confined-child.ts", "utf8");
    const call = text.slice(text.indexOf("await spawnMxcExtensionProcess(request, {"));
    expect(call.length).toBeGreaterThan(0);
    const options = call.slice(0, call.indexOf("\n    });"));
    expect(options).toContain("beforeSpawn: () => {");
    expect(options).toContain("consumeMxcExtensionAdmission(admission,");
    expect(options).toContain("assertNesting();");
  });
});
