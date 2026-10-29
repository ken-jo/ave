import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Use authenticated OSC 133 markers matching shell integration output. */

export const TERMINAL_TEST_NONCE = "0123456789abcdef0123456789abcdef";

const TERMINAL_TEST_PROMPT_TOKEN = "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf";

/** OSC 133 ends with the nonce, except B markers carry the token announced by P. */
export function terminalMarker(fields: string): string {
  if (fields === "B") return `\u001b]133;B;${TERMINAL_TEST_PROMPT_TOKEN}\u0007`;
  let announced = fields;
  if (fields.startsWith("P;")) {
    if (fields.includes(";Keys=") && !fields.includes(";NotFound=")) announced += ";NotFound=0";
    if (!fields.includes(";B=")) announced += `;B=${TERMINAL_TEST_PROMPT_TOKEN}`;
  }
  return `\u001b]133;${announced};${TERMINAL_TEST_NONCE}\u0007`;
}

/** Use C.UTF-8 on Linux and en_US.UTF-8 on macOS, which lacks C.UTF-8. */
export const TERMINAL_TEST_UTF8_LOCALE = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";

export const TERMINAL_TEST_MODERN_BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) =>
  existsSync(path) && /version (?:4\.[4-9]|[5-9]\.)/u.test(spawnSync(path, ["--version"], { encoding: "utf-8" }).stdout));

export const TERMINAL_TEST_ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((path) => existsSync(path));

/** PowerShell 7 for the native pwsh host terminal suite: `AVE_TEST_PWSH`, else the usual install locations. Absent on most CI hosts; the Windows
 * verification session runs it there. */
export const TERMINAL_TEST_PWSH = [
  process.env.AVE_TEST_PWSH,
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "/opt/homebrew/bin/pwsh", "/usr/local/bin/pwsh", "/usr/bin/pwsh", "/snap/bin/pwsh",
].find((path): path is string => path !== undefined && path.length > 0 && existsSync(path));

export async function waitForTerminal(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(25);
  }
}

/** Model system command-not-found handlers with the fixture program replacing the system helper. */
export function ubuntuLikeNotFoundHandler(shellName: string, program: string): string {
  const quoted = `'${program.replace(/'/gu, `'\\''`)}'`;
  const body = [
    `  if [ -x ${quoted} ]; then`,
    `    ${quoted} -- "$1"`,
    "    return $?",
    "  else",
    "    printf \"%s: command not found\\n\" \"$1\" >&2",
    "    return 127",
    "  fi",
  ];
  const name = shellName === "zsh" ? "command_not_found_handler" : "command_not_found_handle";
  return [`function ${name} {`, ...body, "}", ""].join("\n");
}
