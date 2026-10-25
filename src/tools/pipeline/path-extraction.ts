import type { ShellExecutionFacts } from "../../shared/shell-execution.js";
import { resolve as pathResolve } from "node:path";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import type { Tool } from "../base.js";
import { selectDeclaredPathValues } from "../../shared/dotted-field-value.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
import {
  findShellPathPolicyViolation,
  type ShellPathPolicyViolation,
} from "../shell-path-policy.js";

// Extract declared file targets for sensitive-path hard blocks; native shells check command operands on their own surface.
export function extractTargetFilePaths(
  tool: Tool,
  input: unknown,
  cwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const fields = new Set<string>(tool.pathFields ?? []);
  const paths: string[] = [];
  for (const field of fields) {
    const values = selectDeclaredPathValues(obj, field);
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        paths.push(resolveToolPathForPermission(value, cwd));
      } catch {
        // Tool schema validation owns argument-type failures.
      }
    }
  }
  return [...new Set(paths)];
}

// Check every command-bearing field, including cmd, script, and shellCommand; containment cannot inspect only command.
export function shellPathPolicyViolation(
  finalInput: Record<string, unknown>,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
  blockReadsOutsideWorkingDirectories: boolean,
  facts?: ShellExecutionFacts,
): ShellPathPolicyViolation | null {
  const commands = extractShellCommands(finalInput);
  if (commands.length === 0) {
    return { kind: "invalid-path", reason: "Shell path policy: missing command string" };
  }
  const cwdValue = finalInput.cwd;
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    return { kind: "invalid-path", reason: "Shell path policy: cwd must be a string when provided" };
  }
  const resolvedCwd = cwdValue
    ? pathResolve(sandboxRoot, cwdValue)
    : sandboxRoot;
  for (const command of commands) {
    const violation = findShellPathPolicyViolation(
      command,
      resolvedCwd,
      sandboxRoot,
      allowedDirectories,
      blockReadsOutsideWorkingDirectories,
      facts,
    );
    if (violation) return violation;
  }
  return null;
}
