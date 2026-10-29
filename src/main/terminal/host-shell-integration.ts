import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TerminalIntegrationUnavailableReason } from "../../shared/terminal-session.js";
import type { ManualShellLaunch } from "./manual-shell.js";
import { readWindowsDirectoryDacls } from "../../shared/ave-home.js";
import { isOwnerOnlyDacl } from "../../shared/windows-path-facts.js";
import { generateHostShellHooks, generatePwshHostHooks, PWSH_PROFILE_STARTUP, powerShellQuote, pwshNoncePrologue, SHELL_INTEGRATION_NONCE_FILE, shellNoncePrologue } from "./shell-integration.js";

export interface HostShellIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
  nonce: string;
  marksPromptEnd: boolean;
  integrationUnavailableReason?: TerminalIntegrationUnavailableReason;
  cleanup(): void;
}

function quote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

// Each PTY owns only this temporary directory. The user's HOME and startup files stay in place.
export function prepareHostShellIntegration(launch: ManualShellLaunch, env: NodeJS.ProcessEnv): HostShellIntegration {
  const shellEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const nonce = randomBytes(32).toString("hex");
  const native = (reason: TerminalIntegrationUnavailableReason): HostShellIntegration => ({
    command: launch.command, args: [...launch.args], env: shellEnv, nonce,
    marksPromptEnd: false, integrationUnavailableReason: reason, cleanup() {},
  });
  const shell = basename(launch.command).replace(/\.exe$/iu, "");
  if (shell === "pwsh") return preparePwsh(launch, shellEnv, nonce, native);
  if (shell !== "zsh" && shell !== "bash") {
    return native("unsupported-shell");
  }
  if (!env.HOME) return native("missing-home");
  if (!launch.args.includes("-i") && !launch.args.includes("--interactive")) {
    return native("custom-launch");
  }
  if (launch.args.some((arg) => !["-l", "-i", "--login", "--interactive"].includes(arg))) {
    return native("custom-launch");
  }
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "ave-host-terminal-"));
    const ownedDirectory = directory;
    const write = (name: string, text: string): string => {
      const path = join(ownedDirectory, name);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    };
    const noncePath = write(SHELL_INTEGRATION_NONCE_FILE, nonce);
    const hooksPath = write("hooks", generateHostShellHooks(shell));
    // The first owned startup step takes the nonce into an unexported variable and deletes the file before any user file runs.
    // User startup files share this shell, so they can still read the variable; they can no longer find the file.
    const prologue = shellNoncePrologue(shell, noncePath);
    const login = launch.args.includes("-l") || launch.args.includes("--login");
    if (shell === "zsh") {
      // Restore the real startup directory while each user file runs; remember changes made by those files.
      const restore = 'if [[ "$__ave_user_zdotdir_set" == 1 ]]; then export ZDOTDIR="$__ave_user_zdotdir"; else unset ZDOTDIR; fi';
      const save = '__ave_user_zdotdir_set=${+ZDOTDIR}\n__ave_user_zdotdir=${ZDOTDIR-}';
      const redirect = `export ZDOTDIR=${quote(ownedDirectory)}`;
      const source = (name: string): string => `${restore}\n[[ ! -r "\${ZDOTDIR-$HOME}/${name}" ]] || source "\${ZDOTDIR-$HOME}/${name}"\n${save}`;
      write(".zshenv", `${prologue}\n__ave_user_zdotdir_set=${env.ZDOTDIR === undefined ? "0" : "1"}\n__ave_user_zdotdir=${quote(env.ZDOTDIR ?? "")}\n${source(".zshenv")}\n${redirect}\n`);
      write(".zprofile", `${source(".zprofile")}\n${redirect}\n`);
      write(".zshrc", `${source(".zshrc")}\n${login ? redirect : `${restore}\nsource ${quote(hooksPath)}`}\n`);
      write(".zlogin", `${source(".zlogin")}\n${restore}\nsource ${quote(hooksPath)}\n`);
      // After startup ZDOTDIR is the user's value again, so native logout and nested-shell startup remain native.
      return { command: launch.command, args: [...launch.args], env: { ...shellEnv, ZDOTDIR: ownedDirectory }, nonce,
        marksPromptEnd: true, cleanup: () => rmSync(ownedDirectory, { recursive: true, force: true }) };
    }
    // Interactive login shells ignore --rcfile. Replay their startup sequence explicitly.
    // The native read-only login_shell flag and automatic logout files are not emulated.
    const startup = login
      ? [
        '[[ ! -r /etc/profile ]] || source /etc/profile',
        'for __ave_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do',
        '  if [[ -r "$__ave_profile" ]]; then source "$__ave_profile"; break; fi',
        'done',
        'unset __ave_profile',
      ].join("\n")
      : '[[ ! -r "$HOME/.bashrc" ]] || source "$HOME/.bashrc"';
    const rcPath = write("bashrc", prologue + "\n" + startup + "\nsource " + quote(hooksPath) + "\n");
    return { command: launch.command, args: ["--rcfile", rcPath, "-i"], env: shellEnv, nonce,
      marksPromptEnd: true, cleanup: () => rmSync(ownedDirectory, { recursive: true, force: true }) };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    return native("setup-failed");
  }
}

const PWSH_STARTUP_FLAGS: Readonly<Record<string, "login" | "interactive">> = {
  "-l": "login", "-login": "login", "-i": "interactive", "-interactive": "interactive",
};

// PowerShell 7: launch with -NoProfile so nothing of the user's runs before the owned wrapper, which takes the nonce first, then dot-sources the
// user's profiles in PowerShell's own order, then installs the hooks. A launch with any other argument stays native.
function preparePwsh(
  launch: ManualShellLaunch,
  env: Record<string, string>,
  nonce: string,
  native: (reason: TerminalIntegrationUnavailableReason) => HostShellIntegration,
): HostShellIntegration {
  const flags = launch.args.map((arg) => PWSH_STARTUP_FLAGS[arg.toLowerCase()]);
  if (flags.some((flag) => flag === undefined)) return native("custom-launch");
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "ave-host-terminal-"));
    const ownedDirectory = directory;
    // POSIX modes mean nothing to a Windows ACL, and a temporary directory inherits its parent's (which may grant every user read). Protect the
    // directory with an owner-only DACL, verified on read-back, before the nonce is written into it; the files inherit it.
    if (process.platform === "win32" && !protectOwnerOnlyDirectory(ownedDirectory)) throw new Error("owner-only directory protection failed");
    const write = (name: string, text: string): string => {
      const path = join(ownedDirectory, name);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    };
    const noncePath = write(SHELL_INTEGRATION_NONCE_FILE, nonce);
    const hooksPath = write("hooks.ps1", generatePwshHostHooks());
    const wrapper = write("startup.ps1", [pwshNoncePrologue(noncePath), PWSH_PROFILE_STARTUP, `. ${powerShellQuote(hooksPath)}`, ""].join("\n"));
    return {
      command: launch.command,
      // -Login must come first when it is given at all.
      args: [...(flags.includes("login") ? ["-Login"] : []), "-NoProfile", "-NoExit", "-Command", `. ${powerShellQuote(wrapper)}`],
      env, nonce, marksPromptEnd: true,
      cleanup: () => rmSync(ownedDirectory, { recursive: true, force: true }),
    };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    return native("setup-failed");
  }
}

/** Give `directory` an owner-only, inheritance-protected DACL (the protection the Ave home uses) and confirm it on read-back. */
function protectOwnerOnlyDirectory(directory: string): boolean {
  const [descriptor] = readWindowsDirectoryDacls([directory], true);
  return descriptor !== undefined && descriptor.error === undefined && descriptor.protected === true
    && typeof descriptor.currentUserSid === "string" && isOwnerOnlyDacl(descriptor, descriptor.currentUserSid);
}
