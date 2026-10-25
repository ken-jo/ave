import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { discoverHookTrustFiles } from "../hook-config-trust.js";
import { disableHook } from "../hook-discovery.js";
import { collectHookMatcherDiagnostics } from "../hook-matcher-diagnostics.js";
import { acceptHookTrust, disableHookTrust, listHookTrustState, rejectHookTrust } from "../hook-trust-commands.js";
import { runHookTrustWorkflow } from "../hook-trust-prompt.js";
import { ScriptHookManager } from "../script-hook-manager.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
let dir: string;
let layout: { hooksDir: string; disabledDir: string; lockfilePath: string };

function content(fileName: string, matcher: string): string {
  return fileName === "hooks.json"
    ? JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: ["node", COMMAND] }] }] } })
    : `#!/bin/sh\n# ave-hook-matcher: ${matcher}\nexit 0\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-disable-cause-"));
  layout = { hooksDir: dir, disabledDir: join(dir, ".disabled"), lockfilePath: join(dir, ".lockfile.json") };
  mkdirSync(layout.disabledDir);
});

afterEach(async () => { await cleanupTmpDir(dir); });

describe("disabled hook causes", () => {
  it("retains both colliding system quarantines through the real workflow on restart", async () => {
    for (const [fileName, matcher] of [["pre-guard.sh", "*danger*"], ["hooks.json", "*bad*"]]) {
      writeFileSync(join(layout.disabledDir, fileName), content(fileName, "read_file"));
      writeFileSync(join(dir, fileName), content(fileName, matcher));
    }
    expect(collectHookMatcherDiagnostics(dir, layout.disabledDir).guards).toHaveLength(2);
    const first = await runHookTrustWorkflow(layout);
    expect(first.disabledHooks).toHaveLength(2);
    const copies = readdirSync(layout.disabledDir).filter((name) => /\.(sh|json)\.\d/u.test(name) && !name.endsWith(".disable-cause"));
    expect(copies).toHaveLength(2);
    await runHookTrustWorkflow(layout);
    const diagnostics = collectHookMatcherDiagnostics(dir, layout.disabledDir);
    expect(diagnostics.guards).toHaveLength(2);
    expect(diagnostics.notices.join(" ")).toContain("*danger*");
    expect(diagnostics.notices.join(" ")).toContain("*bad*");
    const rows = listHookTrustState(layout).disabled;
    expect(rows).toHaveLength(4);
    for (const name of copies) {
      expect(rows.find((row) => row.fileName === name)?.errors?.join(" ")).toContain(name.startsWith("hooks.json") ? "*bad*" : "*danger*");
      expect(diagnostics.notices.join(" ")).toContain(join(layout.disabledDir, name));
    }
    const manager = new ScriptHookManager();
    manager.setMatcherGuards(diagnostics.guards);
    expect(await manager.runPreToolUse({ toolName: "read_file", source: "builtin", category: "read", input: {}, sessionId: "example", trustOrigin: "user-keyboard" })).toMatchObject({ decision: "deny", results: [] });
  });

  it.each(["pre-guard.sh", "hooks.json"])("legacy unmarked timestamped %s retains a guard and explains why", (fileName) => {
    const storedName = `${fileName}.2026-10-25T00-00-00-000Z`;
    writeFileSync(join(layout.disabledDir, storedName), content(fileName, "*danger*"));
    const diagnostics = collectHookMatcherDiagnostics(dir, layout.disabledDir);
    expect(diagnostics.guards).toHaveLength(1);
    expect(diagnostics.notices.join(" ")).toContain("treated as system-quarantined");
    expect(listHookTrustState(layout).disabled[0]).toMatchObject({ fileName: storedName, state: "disabled" });
    expect(listHookTrustState(layout).disabled[0].errors?.join(" ")).toContain("cause is missing or invalid");
  });

  it.each(["pre-guard.sh", "hooks.json"])("explicit user disables of canonical and colliding %s stay listed without guards", async (fileName) => {
    for (let copy = 0; copy < 2; copy += 1) {
      writeFileSync(join(dir, fileName), content(fileName, "*danger*"));
      await disableHookTrust(fileName, layout);
    }
    expect(listHookTrustState(layout).disabled).toHaveLength(2);
    expect(collectHookMatcherDiagnostics(dir, layout.disabledDir)).toEqual({ notices: [], guards: [] });
  });

  it.each([
    ["pre-guard.sh", false], ["pre-guard.sh", true], ["hooks.json", false], ["hooks.json", true],
  ] as const)("accept and delete clean the cause for %s (collision=%s)", async (fileName, collision) => {
    if (collision) writeFileSync(join(layout.disabledDir, fileName), content(fileName, "read_file"));
    writeFileSync(join(dir, fileName), content(fileName, "read_file"));
    const hook = discoverHookTrustFiles(dir).hooks.find((entry) => entry.fileName === fileName)!;
    const stored = disableHook(hook, layout.disabledDir, "system-quarantine");
    // Seed an existing record to exercise restoration independently of recording.
    writeFileSync(`${stored}.disable-cause`, "system-quarantine\n");
    expect(existsSync(`${stored}.disable-cause`)).toBe(true);
    expect(await acceptHookTrust(basename(stored), layout)).toMatchObject({ ok: true, verb: "accept", accepted: { fileName } });
    expect(existsSync(`${stored}.disable-cause`)).toBe(false);
    expect(existsSync(`${join(dir, fileName)}.disable-cause`)).toBe(false);
    expect(await disableHookTrust(fileName, layout)).toMatchObject({ ok: true });
    const disabled = listHookTrustState(layout).disabled.find((row) => existsSync(join(layout.disabledDir, `${row.fileName}.disable-cause`)))!;
    const removed = join(layout.disabledDir, disabled.fileName);
    expect(existsSync(`${removed}.disable-cause`)).toBe(true);
    expect(await rejectHookTrust(disabled.fileName, layout)).toMatchObject({ ok: true, verb: "reject" });
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(`${removed}.disable-cause`)).toBe(false);
  });

  it.each(["pre-guard.sh", "hooks.json"])("delete removes an existing cause record for %s", async (fileName) => {
    const stored = join(layout.disabledDir, fileName);
    writeFileSync(stored, content(fileName, "read_file"));
    writeFileSync(`${stored}.disable-cause`, "system-quarantine\n");
    expect(await rejectHookTrust(fileName, layout)).toMatchObject({ ok: true });
    expect(existsSync(stored)).toBe(false);
    expect(existsSync(`${stored}.disable-cause`)).toBe(false);
  });

  it.each(["pre-guard.sh", "hooks.json"])("renamed system-quarantined %s keeps its guard", (fileName) => {
    const stored = join(layout.disabledDir, `${fileName}.review-copy`);
    writeFileSync(stored, content(fileName, "*danger*"));
    writeFileSync(`${stored}.disable-cause`, "system-quarantine\n");
    expect(collectHookMatcherDiagnostics(dir, layout.disabledDir).guards).toHaveLength(1);
    expect(listHookTrustState(layout).disabled).toHaveLength(1);
  });

  it("explicitly disabling an existing quarantine clears its guard", async () => {
    const name = "pre-guard.sh";
    writeFileSync(join(dir, name), content(name, "*danger*"));
    await runHookTrustWorkflow(layout);
    expect(collectHookMatcherDiagnostics(dir, layout.disabledDir).guards).toHaveLength(1);
    await disableHookTrust(name, layout);
    expect(collectHookMatcherDiagnostics(dir, layout.disabledDir).guards).toHaveLength(0);
  });

  it("dispatcher failure is a system quarantine, while an explicit rejection is a user disable", async () => {
    for (const fail of [false, true]) {
      const name = fail ? "pre-failed.sh" : "pre-rejected.sh";
      writeFileSync(join(dir, name), content(name, "*danger*"));
      await runHookTrustWorkflow({ ...layout, promptDispatcher: { prompt: async () => {
        if (fail) throw new Error("prompt unavailable");
        return [{ fileName: name, trust: false }];
      } } });
    }
    const diagnostics = collectHookMatcherDiagnostics(dir, layout.disabledDir);
    expect(diagnostics.guards).toHaveLength(1);
    expect(diagnostics.notices.join(" ")).toContain("pre-failed.sh");
    expect(diagnostics.notices.join(" ")).not.toContain("pre-rejected.sh");
  });
});
