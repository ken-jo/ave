import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import { NetworkGate } from "../../net/network-gate.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import type { SourceWarning } from "../../sources/warnings.js";
import { AskpassBroker } from "../askpass.js";
import { GitRunner, type GitRemote } from "../run-git.js";
import { parseSshConfig, sshConfigArgs, type SshConfigReader } from "../ssh-preflight.js";

/**
 * The ssh preflight (design §18.2.4) through the runner. git is a path that
 * does not exist, so a call that starts git fails GIT_RUNTIME_MISSING and one
 * the preflight refuses never gets that far: the code says which happened.
 */
const NO_GIT = "/nonexistent/ave-test/git";

function printed(hostname: string, extra: Record<string, string> = {}): string {
  return [`user git`, `hostname ${hostname}`, `port 22`, ...Object.entries(extra).map(([key, value]) => `${key} ${value}`), ""].join("\n");
}

describe("parseSshConfig and sshConfigArgs", () => {
  it("reads the effective hostname, and a proxy only when one is set", () => {
    expect(parseSshConfig(printed("git.example.com"))).toEqual({ hostname: "git.example.com", proxied: false });
    expect(parseSshConfig(printed("git.example.com", { proxycommand: "none", proxyjump: "none" }))).toEqual({ hostname: "git.example.com", proxied: false });
    expect(parseSshConfig(printed("git.example.com", { proxycommand: "nc -X 5 -x socks:1080 %h %p" }))).toEqual({ hostname: "git.example.com", proxied: true });
    expect(parseSshConfig(printed("git.example.com", { proxyjump: "bastion.example.com" }))).toEqual({ hostname: "git.example.com", proxied: true });
    expect(() => parseSshConfig("user git\n")).toThrow(MarketplaceError);
  });

  it("asks ssh -G for the user, host and port of the remote, and nothing else", () => {
    expect(sshConfigArgs(normalizeSourceUrl("git@github.com:acme/tools"))).toEqual(["-G", "git@github.com"]);
    expect(sshConfigArgs(normalizeSourceUrl("ssh://git@git.example.com:2222/acme/tools"))).toEqual(["-G", "-p", "2222", "git@git.example.com"]);
    expect(sshConfigArgs(normalizeSourceUrl("ssh://git@[fd00::1]/acme/tools"))).toEqual(["-G", "git@fd00::1"]);
  });
});

describe("GitRunner ssh preflight", () => {
  let dir: string;
  let broker: AskpassBroker;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ave-ssh-preflight-"));
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "gitconfig"), "");
    broker = await AskpassBroker.start({ getToken: () => null });
  });

  afterAll(async () => {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  });

  function runner(config: string, answers: (call: number) => readonly string[]) {
    const lookups: string[] = [];
    const readConfig = vi.fn<SshConfigReader>(async () => config);
    const lookup = vi.fn(async (host: string) => {
      lookups.push(host);
      return answers(lookups.length);
    });
    const git = new GitRunner({
      git: { kind: "system", path: NO_GIT, version: { major: 2, minor: 54, patch: 0, text: "2.54.0" } },
      globalConfigPath: join(dir, "gitconfig"),
      emptyDir: join(dir, "empty"),
      askpass: broker,
      lookup,
      readSshConfig: readConfig,
    });
    return { git, lookups, readConfig };
  }

  /** The remote as the gate hands it to the runner. */
  function remote(url: string, load = policyLoad(), acknowledged: SourceWarning[] = []): GitRemote {
    const normalized = normalizeSourceUrl(url);
    const gate = new NetworkGate({ policy: policySource(load), allowLoopback: false, transport: async () => new Response(null) });
    return { url: normalized, sourceId: "fixture", useToken: false, ...gate.checkRemote(normalized, { official: false, acknowledged: new Set(acknowledged) }) };
  }

  const lsRemote = (git: GitRunner, target: GitRemote) => git.run(["ls-remote", target.url.url], { remote: target, timeoutMs: 5_000 });

  async function failure(promise: Promise<unknown>): Promise<MarketplaceError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceError);
      return error as MarketplaceError;
    }
    throw new Error("expected a failure");
  }

  it("runs ssh as ssh -o BatchMode=yes, with no host pin in the environment or the arguments", async () => {
    const { git, readConfig } = runner(printed("git.example.com"), () => ["1.1.1.1"]);
    const target = remote("git@git.example.com:acme/tools");
    expect(git.environment(target).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    const args = [...(await git.configArgs(target)), ...readConfig.mock.calls.flatMap(([argv]) => argv)];
    expect(args.join(" ")).not.toMatch(/HostName|HostKeyAlias|CheckHostIP/iu);
    await failure(lsRemote(git, target));
    expect(readConfig).toHaveBeenCalledWith(["-G", "git@git.example.com"], expect.objectContaining({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }));
    expect(readConfig.mock.calls[0]![0].join(" ")).not.toMatch(/HostName|HostKeyAlias|CheckHostIP/iu);
  });

  it("refuses a printed hostname that resolves to a metadata address, and does not start git (§18.3 #3)", async () => {
    const { git, lookups } = runner(printed("metadata.example.com"), () => ["169.254.169.254"]);
    const error = await failure(lsRemote(git, remote("git@git.example.com:acme/tools")));
    expect(error.code).toBe("SOURCE_URL_REJECTED");
    // The sentence names the address the user entered; the printed hostname is what ssh connects to, so it is what was resolved.
    expect(error.detail).toEqual({ reason: "address-metadata", host: "git.example.com", address: "169.254.169.254" });
    expect(lookups).toEqual(["metadata.example.com"]);
  });

  it("fails on any refused answer, unlike a transport Ave owns: ssh may connect to any of them", async () => {
    const mixed = runner(printed("git.example.com"), () => ["1.1.1.1", "169.254.169.254"]);
    expect((await failure(lsRemote(mixed.git, remote("git@git.example.com:acme/tools")))).code).toBe("SOURCE_URL_REJECTED");

    const internal = runner(printed("git.example.com"), () => ["1.1.1.1", "10.0.0.5"]);
    const blocked = await failure(lsRemote(internal.git, remote("git@git.example.com:acme/tools", policyLoad({ blockPrivateNetworks: true }))));
    expect(blocked.code).toBe("SOURCE_POLICY_BLOCKED");
    expect(blocked.detail).toMatchObject({ reason: "private-network-blocked", address: "10.0.0.5" });

    // An internal answer the source holds no confirmation for asks for one.
    const unconfirmed = await failure(lsRemote(internal.git, remote("git@git.example.com:acme/tools")));
    expect(unconfirmed.code).toBe("SOURCE_CONFIRMATION_REQUIRED");
    expect(unconfirmed.detail).toEqual({ reason: "internal-network", host: "git.example.com", address: "10.0.0.5" });
  });

  it("does not resolve the target when ssh reaches it through a ProxyCommand or ProxyJump", async () => {
    const { git, lookups } = runner(printed("git.example.com", { proxyjump: "bastion.example.com" }), () => ["169.254.169.254"]);
    const error = await failure(lsRemote(git, remote("git@git.example.com:acme/tools")));
    expect(error.code).toBe("GIT_RUNTIME_MISSING");
    expect(lookups).toEqual([]);
  });

  it("documents the residual: an answer that changes after the preflight is not bound (§18.2.4)", async () => {
    // Public to the preflight, loopback to any later lookup: ssh's own lookup is not Ave's.
    const { git, lookups } = runner(printed("git.example.com"), (call) => (call === 1 ? ["1.1.1.1"] : ["127.0.0.1"]));
    const target = remote("git@git.example.com:acme/tools");
    const error = await failure(lsRemote(git, target));
    // The preflight passed and git was started, with the ssh command unchanged.
    expect(error.code).toBe("GIT_RUNTIME_MISSING");
    expect(lookups).toEqual(["git.example.com"]);
    expect(git.environment(target).GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });
});
