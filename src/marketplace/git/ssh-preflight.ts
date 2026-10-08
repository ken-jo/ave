/**
 * The ssh remote's address check (design §18.2.4): a preflight, not a pin.
 *
 * ssh resolves and connects on its own, and pinning it (`HostName`,
 * `HostKeyAlias`, `CheckHostIP`) would change the user's host-key and
 * certificate identity, which is the trust anchor for SSH. So the runner
 * reads the effective configuration with `ssh -G`, which evaluates `Host`
 * and `Match` blocks, resolves the printed `hostname` once, and refuses the
 * call before git starts when any answer violates a hard refusal or a managed
 * block: ssh may connect to any of them. With `proxycommand` or `proxyjump`
 * set, ssh reaches the target beyond the proxy, so nothing is resolved here.
 *
 * Residual, stated: an answer that changes between this lookup and ssh's own
 * is not bound.
 */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { selectAnswers, type AddressPolicy } from "../../core/network-guard.js";
import { MarketplaceError } from "../errors.js";
import type { NormalizedSourceUrl } from "../net/source-url.js";

/** Runs `ssh <args>` with the git call's environment and answers its stdout. */
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
  /** Set when ssh reaches the target through another program or host. */
  proxied: boolean;
}

/** The lines of `ssh -G` this check needs. */
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

/** The arguments of `ssh -G` for a remote: `[-p <port>] [<user>@]<host>`. */
export function sshConfigArgs(url: NormalizedSourceUrl): string[] {
  const host = url.host.startsWith("[") && url.host.endsWith("]") ? url.host.slice(1, -1) : url.host;
  return ["-G", ...(url.port !== null ? ["-p", String(url.port)] : []), `${url.user ? `${url.user}@` : ""}${host}`];
}

export interface SshPreflightDeps {
  readConfig: SshConfigReader;
  lookup: (host: string) => Promise<readonly string[]>;
}

/** Throws the refusal, block or confirmation the remote's answers call for; git is not started then. */
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
