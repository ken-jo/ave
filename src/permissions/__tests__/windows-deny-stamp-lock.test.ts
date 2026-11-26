import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every runtime entry that can stamp a deny row (and so create an absent one) is reached only through asrt-sandbox.ts, after the present-target check.
const STAMP_CALL = /\b(?:stampWindowsAcl(?:Async)?|wrapWithSandboxArgv|initializeWindowsIsolation)\s*\(|SandboxManager\.initialize\s*\(/g;
const PRESENT_CHECK = /\b(?:checkWindowsSandboxStampTargets|assertWindowsDenyTargetsPresent)\s*\(/;
// The Linux runtime probe passes no filesystem override: it runs the initialized configuration, which initialization checked.
const PROBE = "ASRT_LINUX_RUNTIME_PROBE_COMMAND";

function shippingSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : shippingSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(line => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, "")).join("\n");
}

describe("Windows deny stamp lock", () => {
  it("reaches the runtime stamp only from asrt-sandbox.ts, each call after the present-target check", () => {
    const callers = shippingSources("src").filter(path => code(readFileSync(path, "utf8")).match(STAMP_CALL) !== null);
    expect(callers.map(path => relative("src", path).replace(/\\/g, "/"))).toEqual(["permissions/asrt-sandbox.ts"]);
    const source = code(readFileSync(join("src", "permissions", "asrt-sandbox.ts"), "utf8"));
    const unchecked: string[] = [];
    for (const match of source.matchAll(STAMP_CALL)) {
      const before = source.slice(0, match.index);
      const enclosing = before.slice([...before.matchAll(/\n(?:export )?(?:async )?function /g)].at(-1)?.index ?? 0);
      const call = source.slice(match.index, match.index + 200);
      if (!PRESENT_CHECK.test(enclosing) && !call.includes(PROBE)) unchecked.push(`${match[0]} at offset ${match.index}`);
    }
    expect(unchecked).toEqual([]);
    // The shared check refuses an absent target before any other branch can return.
    const check = source.slice(source.indexOf("function checkWindowsSandboxStampTargets("));
    const body = check.slice(check.indexOf("{") + 1, check.indexOf("\n}"));
    const statements = body.split("\n").map(line => line.trim()).filter(Boolean);
    expect(statements[0]).toBe("if (process.platform !== \"win32\") return;");
    expect(statements[1]).toMatch(/^assertWindowsDenyTargetsPresent\(/);
  });
});
