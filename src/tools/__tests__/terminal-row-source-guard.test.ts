import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");
const LEDGER = "tools/invocation-ledger.ts";
// Where the lifecycle events are declared, not emitted.
const EVENT_DECLARATIONS = new Set(["hooks/hook-contract.ts", "hooks/script-hook-types.ts"]);
// Records beside an invocation's outcome (asks, grants, plugin operations, mode changes); the ledger refuses a terminal row there.
const SIDE_RECORD_WRITERS = new Set([
  "boot/steps/plugin-tool-executor.ts",
  "permissions/permission-mode-apply.ts",
  "tools/invocation-execution.ts",
  "tools/pipeline/audit-writer.ts",
]);
// Rows that belong to no invocation: hook quarantine at boot, judge records, manifest violations.
const NON_INVOCATION_WRITERS = new Set([
  "boot/steps/hook-system-wiring.ts",
  "permissions/judge/judge-engine.ts",
  "permissions/manifest-integrity.ts",
]);

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") productFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Each place outside the ledger that could write an invocation's terminal row or emit its denial. */
function violations(file: string, source: string): string[] {
  if (file === LEDGER) return [];
  const found: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/\bappendTerminalRow\s*\(/.test(code)) found.push(`${file}: terminal append`);
  if (/["'`]PermissionDenied["'`]/.test(code) && !EVENT_DECLARATIONS.has(file)) found.push(`${file}: PermissionDenied emit`);
  if (/\bappendToolInvocationAudit\s*\(/.test(code) && !SIDE_RECORD_WRITERS.has(file)) found.push(`${file}: invocation audit append`);
  if (/\.appendPermissionAuditEntry\s*\(/.test(code) && !file.startsWith("audit/") && !NON_INVOCATION_WRITERS.has(file)) {
    found.push(`${file}: direct permission audit append`);
  }
  return found;
}

describe("terminal row source guard", () => {
  it("leaves the ledger as the only writer of an invocation's terminal row and its denial", () => {
    const found = productFiles(SRC).flatMap((path) => violations(relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8")));
    expect(found).toEqual([]);
  });

  it.each([
    ["tools/invocation-runner.ts", "await appendToolInvocationAudit(services.auditLogger, { ...common, decision: \"deny\" });", "invocation audit append"],
    ["tools/pipeline/audit-writer.ts", "await this.fireLifecycleEvent(\"PermissionDenied\", sessionId, context, payload);", "PermissionDenied emit"],
    ["engine/turn/run-turn.ts", "void logger.appendPermissionAuditEntry(entry);", "direct permission audit append"],
    ["tools/pipeline/audit-writer.ts", "appendTerminalRow(logger, entry);", "terminal append"],
  ])("flags a planted call in %s", (file, line, kind) => {
    expect(violations(file, `export function planted() {\n  ${line}\n}\n`)).toEqual([`${file}: ${kind}`]);
  });
});
