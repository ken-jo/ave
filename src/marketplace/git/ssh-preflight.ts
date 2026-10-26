/** SSH preflight preserves host-key identity and checks all effective-host answers before git.
 * SSH resolves again, so rebinding after preflight remains possible; configured proxies resolve their own targets. */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { selectAnswers, type AddressPolicy } from "../../core/network-guard.js";
import { MarketplaceError } from "../errors.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";

export type SshConfigReader = (args: readonly string[], env: Readonly<Record<string, string>>) => Promise<string>;

export const readSshConfig: SshConfigReader = (args, env) =>
  new Promise<string>((resolve, reject) => {
    execFile("ssh", [...args], { env: { ...env }, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

export interface EffectiveSshConfig {
  hostname: string;
  proxied: boolean;
}

export function parseSshConfig(text: string): EffectiveSshConfig {
  let hostname: string | null = null;
  let proxied = false;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.*)$/u.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "hostname") hostname = value;
    if ((key === "proxycommand" || key === "proxyjump") && value !== "" && value.toLowerCase() !== "none") proxied = true;
  }
  if (!hostname) throw new MarketplaceError("SOURCE_UNREACHABLE", "ssh -G printed no hostname");
  return { hostname, proxied };
}

export function sshConfigArgs(url: NormalizedSourceUrl): string[] {
  const host = url.host.startsWith("[") && url.host.endsWith("]") ? url.host.slice(1, -1) : url.host;
  return ["-G", ...(url.port !== null ? ["-p", String(url.port)] : []), `${url.user ? `${url.user}@` : ""}${host}`];
}

export interface SshPreflightDeps {
  readConfig: SshConfigReader;
  lookup: (host: string) => Promise<readonly string[]>;
}

/** Refusal prevents git from starting. */
export async function sshPreflight(url: NormalizedSourceUrl, policy: AddressPolicy, env: Readonly<Record<string, string>>, deps: SshPreflightDeps): Promise<void> {
  let text: string;
  try {
    text = await deps.readConfig(sshConfigArgs(url), env);
  } catch (error) {
    throw new MarketplaceError("SOURCE_UNREACHABLE", `ssh -G for ${url.host} failed: ${(error as Error).message}`, { cause: error });
  }
  const config = parseSshConfig(text);
  // Beyond a ProxyCommand or ProxyJump, ssh resolves the target: trusted like any program the user configured.
  if (config.proxied) return;
  const answers = isIP(config.hostname) !== 0 ? [config.hostname] : await deps.lookup(config.hostname);
  selectAnswers(answers, new URL(`ssh://${isIP(config.hostname) === 6 ? `[${config.hostname}]` : config.hostname}/`), policy, "every");
}
