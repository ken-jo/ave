import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { prepareShellFloorInput, SHELL_LITERAL_DATA_LIMIT } from "../rules/shell-literal-data.js";
import * as shellPaths from "../../tools/shell-path-policy.js";

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

describe("literal heredoc data bounds", () => {
  it("declines a substitution even when its quoted heredoc body is inert data", () => {
    const command = 'echo "$(cat <<\'EOF\'\nrm -rf /\nEOF\n)"';
    expect(prepareShellFloorInput(command, "bash")?.destructive).toBe(false);
    expect(check(command)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });

  it("retains executable destructive commands beside nested quoted data", () => {
    const command = 'echo "$(cat <<\'EOF\'\ndata\nEOF\nrm -rf /\n)"';
    expect(prepareShellFloorInput(command, "bash")?.destructive).toBe(true);
    expect(check(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it.each([8_001, 16_384, SHELL_LITERAL_DATA_LIMIT])("admits %i bytes of quoted data with a small executable envelope", (bytes) => {
    const command = hereDocument(bytes);
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.literalDataBytes).toBe(bytes);
    expect(prepared?.command).toBe(command);
    expect(prepared?.parsed?.analysis.ok).toBe(true);
    const inspect = vi.spyOn(shellPaths, "inspectShellPermissionPaths");
    try {
      expect(check(command)).toMatchObject({ decision: "allow", layer: 6 });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]?.[0]).toBe(command);
    } finally { inspect.mockRestore(); }
  });

  it("routes an unproven host call through the mode", () => {
    expect(check(hereDocument(8_001), false)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("keeps data-allowance limits separate from Allow-mode routing", () => {
    expect(check(hereDocument(SHELL_LITERAL_DATA_LIMIT + 1))).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
    const one = hereDocument(33_000);
    expect(check(one + one)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("counts Unicode data in bytes", () => {
    expect(check(`cat > out.txt <<'EOF'\n${"한".repeat(22_000)}\nEOF\n`)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("leaves unquoted data under the ordinary analysis cap", () => {
    expect(check(hereDocument(8_001, "EOF"))).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("accepts a double quoted delimiter without expanding its data", () => {
    expect(check(hereDocument(9_000, '"EOF"').replace("aaaa", "$HOME"))).toMatchObject({ decision: "allow", layer: 6 });
  });
  it.each(["E'OF'", "'E'O'F'", "'EOF'"])("verifies literal delimiter quoting in %s", (delimiter) => {
    expect(check(hereDocument(9_000, delimiter))).toMatchObject({ decision: "allow", layer: 6 });
  });
  it("does not treat code-like or credential-looking body text as executable input", () => {
    const command = hereDocument(9_000).replace("aaaa", "rm -rf /; cat ~/.ssh/id_rsa");
    expect(check(command)).toMatchObject({ decision: "allow", layer: 6 });
  });
  it("still inspects the executable envelope and output path", () => {
    expect(check(hereDocument(9_000, "'EOF'", "~/.ssh/id_rsa"))).toMatchObject({ decision: "ask", layer: 2, forceModal: true, reasonCode: "protected-path" });
    expect(check(hereDocument(9_000) + "rm -rf /\n")).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("refuses missing delimiters and false markers in comments or strings", () => {
    for (const command of [hereDocument(9_000).slice(0, -4), "# <<'EOF'\n" + "a".repeat(9_000) + "\nEOF\n", "printf \"<<'EOF'\"\n" + "a".repeat(9_000) + "\nEOF\n"]) {
      expect(prepareShellFloorInput(command, "bash")).toBeNull();
      expect(check(command)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
    }
  });
  it("does not reuse a data allowance across unrelated executable text", () => {
    expect(check(hereDocument(9_000) + "printf " + "x".repeat(8_001))).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it.each([{ receiver: "bash", executesShell: true }, { receiver: "python3 -", executesShell: false }, { receiver: "env bash", executesShell: true }, { receiver: "( bash )", executesShell: true }])("keeps known code consumers separate from the data allowance: $receiver", ({ receiver, executesShell }) => {
    const command = `${receiver} <<'EOF'\n# ${"a".repeat(9_000)}\nrm -rf /\nEOF\n`;
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expect(check(command)).toMatchObject(executesShell
      ? { decision: "ask", layer: 2, forceModal: true, reasonCode: "critical-delete" }
      : { decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("keeps original source and all expansion checks when heredoc quoting is mixed", () => {
    const command = "cat <<X <<'Y'\nkeep\\\nX\n$(rm -rf /)\nY\nX\nY\n";
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.command).toBe(command);
    expect(prepared?.literalDataBytes).toBe(0);
    expect(check(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    const large = command.replace("$(rm -rf /)", "# " + "a".repeat(9_000) + "\n$(rm -rf /)");
    expect(prepareShellFloorInput(large, "bash")).toBeNull();
    expect(check(large)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });
  it("keeps later unquoted heredocs from sharing a quoted-data allowance", () => {
    const command = hereDocument(9_000) + "cat <<X\nplain data\nX\n";
    expect(prepareShellFloorInput(command, "bash")).toBeNull();
    expect(check(command)).toMatchObject({ decision: "allow", layer: 6, reasonCode: "allow-mode" });
  });
  it("uses the original grammar for a backslash quoted delimiter", () => {
    const command = hereDocument(9_000, "\\EOF");
    const prepared = prepareShellFloorInput(command, "bash");
    expect(prepared?.command).toBe(command);
    expect(prepared?.literalDataBytes).toBe(9_000);
    expect(check(command)).toMatchObject({ decision: "allow", layer: 6 });
  });

});
