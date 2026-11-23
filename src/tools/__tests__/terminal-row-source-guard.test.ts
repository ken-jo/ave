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
// The only writer of a directory grant beside an invocation's outcome.
const DIRECTORY_GRANT_WRITER = "tools/pipeline/audit-writer.ts";
// The sink itself, and rows that belong to no invocation: the audit self-test, hook quarantine at boot, judge records,
// manifest violations.
const NON_INVOCATION_WRITERS = new Set([
  "audit/audit-logger.ts",
  "audit/permission-audit-proof.ts",
  "boot/steps/hook-system-wiring.ts",
  "permissions/judge/judge-engine.ts",
  "permissions/manifest-integrity.ts",
]);
// The typed dispatchers, which pass an event parameter through; PermissionDenied reaches them only as a ledger denial.
const LIFECYCLE_DISPATCHERS = new Set([
  "engine/conversation-loop.ts",
  "engine/turn/lifecycle-hooks.ts",
  "hooks/script-hook-manager.ts",
  "tools/pipeline/audit-writer.ts",
]);
// A lifecycle dispatch and its event argument, across newlines; a function or async method declaration is not one.
const LIFECYCLE_DISPATCH = /(?<!\b(?:function|async)\s+)\b(?:fireLifecycleEvent|runLifecycleEvent)\s*\(\s*([^,)]*)/g;
// A string literal or a named hook event constant.
const LITERAL_EVENT = /^(?:"[^"]*"|'[^']*'|`[^`$]*`|HOOK_EVENT_TYPES\.\w+)\s*$/;
// A direct sink append: a method access, a bracketed access outside a type, or a destructured method.
const DIRECT_APPEND = /\.appendPermissionAuditEntry\b|\[\s*["'`]appendPermissionAuditEntry["'`]\s*\](?!\s*>)|\{[^{}]*\bappendPermissionAuditEntry\b[^{}]*\}\s*=(?![=>])/;

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
  if (/["'`]PermissionDenied["'`]|\.PermissionDenied\b/.test(code) && !EVENT_DECLARATIONS.has(file)) found.push(`${file}: PermissionDenied emit`);
  if (/\bappendToolInvocationAudit\s*\(/.test(code) && !SIDE_RECORD_WRITERS.has(file)) found.push(`${file}: invocation audit append`);
  if (/\bappendDirectoryGrantRecord\s*\(/.test(code) && file !== DIRECTORY_GRANT_WRITER) found.push(`${file}: directory grant append`);
  if (DIRECT_APPEND.test(code) && !NON_INVOCATION_WRITERS.has(file)) found.push(`${file}: direct permission audit append`);
  if (!LIFECYCLE_DISPATCHERS.has(file) && [...code.matchAll(LIFECYCLE_DISPATCH)].some((match) => !LITERAL_EVENT.test(match[1] ?? ""))) {
    found.push(`${file}: lifecycle event by variable`);
  }
  return found;
}

describe("terminal row source guard", () => {
  it("leaves the ledger as the only writer of an invocation's terminal row and its denial", () => {
    const found = productFiles(SRC).flatMap((path) => violations(relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8")));
    expect(found).toEqual([]);
  });

  it("does not flag a literal lifecycle event or a dispatcher's declaration", () => {
    expect(violations("engine/turn/run-turn.ts", "await self.fireLifecycleEvent(\n  \"Stop\", payload);\nvoid hooks.runLifecycleEvent(HOOK_EVENT_TYPES.Stop, id);\n")).toEqual([]);
    expect(violations("engine/turn/session.ts", "async function fireLifecycleEvent(event: string) {}\n")).toEqual([]);
  });

  it("does not flag a type that names the sink method", () => {
    expect(violations("tools/pipeline/rationale-host-coordinator.ts",
      "type Append = ReturnType<AuditLogger[\"appendPermissionAuditEntry\"]>;\n")).toEqual([]);
  });

  it.each([
    ["tools/invocation-runner.ts", "await appendToolInvocationAudit(services.auditLogger, { ...common, decision: \"deny\" });", "invocation audit append"],
    ["tools/pipeline/audit-writer.ts", "await this.fireLifecycleEvent(\"PermissionDenied\", sessionId, context, payload);", "PermissionDenied emit"],
    ["engine/turn/run-turn.ts", "void logger.appendPermissionAuditEntry(entry);", "direct permission audit append"],
    ["tools/pipeline/audit-writer.ts", "appendTerminalRow(logger, entry);", "terminal append"],
    ["tools/invocation-runner.ts", "void hooks.runLifecycleEvent(HOOK_EVENT_TYPES.PermissionDenied, sessionId);", "PermissionDenied emit"],
    ["engine/turn/run-turn.ts", "const { appendPermissionAuditEntry } = logger;", "direct permission audit append"],
    ["engine/turn/run-turn.ts", "void logger[\"appendPermissionAuditEntry\"](entry);", "direct permission audit append"],
    ["engine/turn/run-turn.ts", "const append = logger.appendPermissionAuditEntry.bind(logger);", "direct permission audit append"],
    ["audit/audit-chain-export.ts", "void logger.appendPermissionAuditEntry(entry);", "direct permission audit append"],
    ["tools/invocation-runner.ts", "await appendDirectoryGrantRecord(services.auditLogger, entry);", "directory grant append"],
    ["tools/invocation-runner.ts", "fire: (event, reason) => services.auditWriter.fireLifecycleEvent(event, sessionId, context, payload),", "lifecycle event by variable"],
    ["tools/invocation-execution.ts", "await services.auditWriter.fireLifecycleEvent(\n    events[kind], sessionId, context, payload);", "lifecycle event by variable"],
    ["engine/turn/run-turn.ts", "void hooks.runLifecycleEvent(denied ? DENIED : \"Stop\", sessionId, \"unknown\", {});", "lifecycle event by variable"],
  ])("flags a planted call in %s", (file, line, kind) => {
    expect(violations(file, `export function planted() {\n  ${line}\n}\n`)).toEqual([`${file}: ${kind}`]);
  });
});
