import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { prepareShellFloorInput, SHELL_LITERAL_DATA_LIMIT } from "../rules/shell-literal-data.js";
import * as shellPaths from "../rules/literal-shell-inspection.js";

// A drive-less "/" is an unresolved-namespace protected path on win32, so the
// protected-path floor fires before the critical-delete heuristic. Same gate
// (ask + forceModal), equal-or-stricter; only the reason label differs.
const ROOT_DELETE_REASON_CODE = process.platform === "win32" ? "protected-path" : "critical-delete";

let root: string;
let manager: PermissionManager;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "literal-shell-data-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
  manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("allow");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function hereDocument(bytes: number, delimiter = "'EOF'", target = "out.txt"): string {
  return `cat > ${target} <<${delimiter}\n${"a".repeat(bytes - 1)}\nEOF\n`;
}
function check(command: string, runsSandboxed = true) {
  return manager.checkDetailed("bash", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "bash", command, cwd: root },
    shellExecution: { runsSandboxed },
  });
}

function expectAnalysisLimit(command: string, runsSandboxed = true): void {
  const previousMode = manager.getMode();
  try {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      manager.setMode(mode);
      expect(check(command, runsSandboxed), mode).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    }
  } finally { manager.setMode(previousMode); }
}

describe("literal heredoc data bounds", () => {
  it("declines a substitution even when its quoted heredoc body is inert data", () => {
    const command = 'echo "$(cat <<\'EOF\'\nrm -rf /\nEOF\n)"';
    expect(prepareShellFloorInput(command, "bash")?.destructive).toBe(false);
    expect(check(command)).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
  });

  it("retains executable destructive commands beside nested quoted data", () => {
    const command = 'echo "$(cat <<\'EOF\'\ndata\nEOF\nrm -rf /\n)"';
    expect(prepareShellFloorInput(command, "bash")?.destructive).toBe(true);
    expect(check(command)).toMatchObject({ decision: "ask", forceModal: true });
  });

  it.each([8_001, 16_384, SHELL_LITERAL_DATA_LIMIT])("admits %i bytes of quoted data with a small executable envelope", (bytes) => {
    const command = hereDocument(bytes);
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.literalDataBytes).toBe(bytes);
    expect(prepared?.command).toBe(command);
    expect(prepared?.parsed?.analysis.ok).toBe(true);
    const inspect = vi.spyOn(shellPaths, "inspectShellPermissionPaths");
    try {
      expect(check(command)).toMatchObject({ decision: "allow" });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]?.[0]).toBe(command);
    } finally { inspect.mockRestore(); }
  });

  it("routes an unproven host call through the mode", () => {
    expect(check(hereDocument(8_001), false)).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
  });
  it("denies data-allowance exhaustion before every mode", () => {
    const oversized = hereDocument(SHELL_LITERAL_DATA_LIMIT + 1);
    expect(prepareShellFloorInput(oversized, "bash")).toBeNull();
    expectAnalysisLimit(oversized);
    const one = hereDocument(33_000);
    expect(prepareShellFloorInput(one + one, "bash")).toBeNull();
    expectAnalysisLimit(one + one);
  });
  it("counts Unicode data in bytes", () => {
    const command = `cat > out.txt <<'EOF'\n${"한".repeat(22_000)}\nEOF\n`;
    expect(Buffer.byteLength("한".repeat(22_000) + "\n", "utf8")).toBe(66_001);
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expectAnalysisLimit(command);
  });
  it("leaves unquoted data under the ordinary analysis cap", () => {
    const command = hereDocument(8_001, "EOF");
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expectAnalysisLimit(command);
  });
  it("accepts a double quoted delimiter without expanding its data", () => {
    expect(check(hereDocument(9_000, '"EOF"').replace("aaaa", "$HOME"))).toMatchObject({ decision: "allow" });
  });
  it.each(["E'OF'", "'E'O'F'", "'EOF'"])("verifies literal delimiter quoting in %s", (delimiter) => {
    expect(check(hereDocument(9_000, delimiter))).toMatchObject({ decision: "allow" });
  });
  it("does not treat code-like or credential-looking body text as executable input", () => {
    const command = hereDocument(9_000).replace("aaaa", "rm -rf /; cat ~/.ssh/id_rsa");
    expect(check(command)).toMatchObject({ decision: "allow" });
  });
  it("still inspects the executable envelope and output path", () => {
    expect(check(hereDocument(9_000, "'EOF'", "~/.ssh/id_rsa"))).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
    expect(check(hereDocument(9_000) + "rm -rf /\n")).toMatchObject({ decision: "ask", forceModal: true });
  });
  it("refuses missing delimiters and false markers in comments or strings", () => {
    for (const command of [hereDocument(9_000).slice(0, -4), "# <<'EOF'\n" + "a".repeat(9_000) + "\nEOF\n", "printf \"<<'EOF'\"\n" + "a".repeat(9_000) + "\nEOF\n"]) {
      expect(prepareShellFloorInput(command, "bash")).toBeNull();
      expectAnalysisLimit(command);
    }
  });
  it("does not reuse a data allowance across unrelated executable text", () => {
    const command = hereDocument(9_000) + "printf " + "x".repeat(8_001);
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expectAnalysisLimit(command);
  });
  it.each([{ receiver: "bash", executesShell: true }, { receiver: "python3 -", executesShell: false }, { receiver: "env bash", executesShell: true }, { receiver: "( bash )", executesShell: true }])("keeps known code consumers separate from the data allowance: $receiver", ({ receiver, executesShell }) => {
    const command = `${receiver} <<'EOF'\n# ${"a".repeat(9_000)}\nrm -rf /\nEOF\n`;
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expectAnalysisLimit(command);
    const bounded = `${receiver} <<'EOF'\nrm -rf /\nEOF\n`;
    expect(prepareShellFloorInput(bounded, "bash")).not.toBeNull();
    expect(check(bounded)).toMatchObject(executesShell
      ? { decision: "ask", forceModal: true, reasonCode: ROOT_DELETE_REASON_CODE }
      : { decision: "allow", reasonCode: "allow-mode" });
  });
  it("keeps original source and all expansion checks when heredoc quoting is mixed", () => {
    const command = "cat <<X <<'Y'\nkeep\\\nX\n$(rm -rf /)\nY\nX\nY\n";
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.command).toBe(command);
    expect(prepared?.literalDataBytes).toBe(0);
    expect(check(command)).toMatchObject({ decision: "ask", forceModal: true });
    const large = command.replace("$(rm -rf /)", "# " + "a".repeat(9_000) + "\n$(rm -rf /)");
    expect(prepareShellFloorInput(large, "bash")).toBeNull();
    expectAnalysisLimit(large);
  });
  it("keeps later unquoted heredocs from sharing a quoted-data allowance", () => {
    const command = hereDocument(9_000) + "cat <<X\nplain data\nX\n";
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expectAnalysisLimit(command);
  });
  it("uses the original grammar for a backslash quoted delimiter", () => {
    const command = hereDocument(9_000, "\\EOF");
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.command).toBe(command);
    expect(prepared?.literalDataBytes).toBe(9_000);
    expect(check(command)).toMatchObject({ decision: "allow" });
  });

});
