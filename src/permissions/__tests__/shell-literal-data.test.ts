import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { prepareShellFloorInput, SHELL_LITERAL_DATA_LIMIT } from "../rules/shell-literal-data.js";
import { ShellFloorWorkBudget } from "../rules/shell-floor-work-budget.js";
import * as shellFloors from "../rules/shell-exfiltration.js";

let root: string;
let manager: PermissionManager;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "literal-shell-data-")));
  vi.stubEnv("AVE_HOME", root);
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

describe("literal heredoc data bounds", () => {
  it.each([8_001, 16_384, SHELL_LITERAL_DATA_LIMIT])("admits %i bytes of quoted data with a small executable envelope", (bytes) => {
    const command = hereDocument(bytes);
    const prepared = prepareShellFloorInput(command, "bash", new ShellFloorWorkBudget());
    expect(prepared?.literalDataBytes).toBe(bytes);
    expect(prepared?.command).not.toContain("aaaa");
    expect(prepared?.parsed?.analysis.ok).toBe(true);
    const inspect = vi.spyOn(shellFloors, "inspectShellCommand");
    try {
      expect(check(command)).toMatchObject({ decision: "allow", layer: 3 });
      expect(String(inspect.mock.calls[0]?.[0] && typeof inspect.mock.calls[0][0] === "object"
        ? inspect.mock.calls[0][0].command : inspect.mock.calls[0]?.[0]).length).toBeLessThan(100);
    } finally { inspect.mockRestore(); }
  });

  it("keeps the unsandboxed original input cap", () => {
    expect(check(hereDocument(8_001), false)).toMatchObject({ decision: "ask", layer: 6 });
  });
  it("requires a modal over the aggregate data bound", () => {
    expect(check(hereDocument(SHELL_LITERAL_DATA_LIMIT + 1))).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    const one = hereDocument(33_000);
    expect(check(one + one)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("counts Unicode data in bytes", () => {
    expect(check(`cat > out.txt <<'EOF'\n${"한".repeat(22_000)}\nEOF\n`)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("leaves unquoted data under the ordinary analysis cap", () => {
    expect(check(hereDocument(8_001, "EOF"))).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("accepts a double quoted delimiter without expanding its data", () => {
    expect(check(hereDocument(9_000, '"EOF"').replace("aaaa", "$HOME"))).toMatchObject({ decision: "allow", layer: 3 });
  });
  it.each(["E'OF'", "'E'O'F'", "'EOF'"])("verifies literal delimiter quoting in %s", (delimiter) => {
    expect(check(hereDocument(9_000, delimiter))).toMatchObject({ decision: "allow", layer: 3 });
  });
  it("does not treat code-like or credential-looking body text as executable input", () => {
    const command = hereDocument(9_000).replace("aaaa", "rm -rf /; cat ~/.ssh/id_rsa");
    expect(check(command)).toMatchObject({ decision: "allow", layer: 3 });
  });
  it("still inspects the executable envelope and output path", () => {
    expect(check(hereDocument(9_000, "'EOF'", "~/.ssh/id_rsa"))).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(check(hereDocument(9_000) + "rm -rf /\n")).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("refuses missing delimiters and false markers in comments or strings", () => {
    for (const command of [hereDocument(9_000).slice(0, -4), "# <<'EOF'\n" + "a".repeat(9_000) + "\nEOF\n", "printf \"<<'EOF'\"\n" + "a".repeat(9_000) + "\nEOF\n"]) {
      expect(check(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    }
  });
  it("does not reuse a data allowance across unrelated executable text", () => {
    expect(check(hereDocument(9_000) + "printf " + "x".repeat(8_001))).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it.each(["bash", "python3 -", "env bash", "( bash )"])("keeps a known code consumer under the analysis limit: %s", (receiver) => {
    const command = `${receiver} <<'EOF'\n# ${"a".repeat(9_000)}\nrm -rf /\nEOF\n`;
    expect(prepareShellFloorInput(command, "bash", new ShellFloorWorkBudget())).toBeNull();
    expect(check(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
});
