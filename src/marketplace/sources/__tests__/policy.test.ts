import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { EMPTY_MARKETPLACE_POLICY, isBlockedByPolicy, loadMarketplacePolicy, type MarketplacePolicy } from "../policy.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-mkt-policy-"));
  path = join(dir, "policy.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePolicy(marketplaces: unknown): void {
  writeFileSync(path, JSON.stringify({ version: 1, requireExplicitApproval: true, managed: true, updatedAt: "2026-09-23T00:00:00Z", marketplaces }));
}

async function loaded(marketplaces: unknown): Promise<MarketplacePolicy> {
  writePolicy(marketplaces);
  const result = await loadMarketplacePolicy(path);
  if (!result.ok) throw new Error(`expected a valid policy, got: ${result.error}`);
  return result.policy;
}

async function rejected(marketplaces: unknown): Promise<string> {
  writePolicy(marketplaces);
  const result = await loadMarketplacePolicy(path);
  if (result.ok) throw new Error("expected the policy to be rejected");
  return result.error;
}

const DESIGN_EXAMPLE = {
  allow: ["https://github.com/acme/*", "host:git.corp.example", "https://github.com/ken-jo/ave-marketplace-index"],
  block: ["host:git.example.org"],
  allowHttpHosts: ["git.corp.example"],
  allowDirectInstall: true,
  allowDisablingOfficial: false,
  additional: [{ id: "corp", url: "https://git.corp.example/ave/marketplace.git" }],
  defaultInstalls: [
    { kind: "plugin", name: "wiki-search", source: "corp" },
    { kind: "plugin", name: "orion-api", source: "corp" },
  ],
  requiredInstalls: [{ kind: "plugin", name: "orion-api", source: "corp" }],
};

describe("loadMarketplacePolicy", () => {
  it("means no restrictions when the file is missing or has no marketplaces section", async () => {
    expect(await loadMarketplacePolicy(join(dir, "absent.json"))).toEqual({ ok: true, policy: EMPTY_MARKETPLACE_POLICY });
    writeFileSync(path, JSON.stringify({ version: 1, requireExplicitApproval: true, managed: false, updatedAt: "x" }));
    expect(await loadMarketplacePolicy(path)).toEqual({ ok: true, policy: EMPTY_MARKETPLACE_POLICY });
  });

  it("reads the design example and keeps a key listed in both lists as required only", async () => {
    const policy = await loaded(DESIGN_EXAMPLE);
    expect(policy.allow?.map((pattern) => pattern.text)).toEqual(DESIGN_EXAMPLE.allow);
    expect([...policy.allowHttpHosts]).toEqual(["git.corp.example"]);
    expect(policy.additional).toEqual([
      {
        id: "corp",
        url: normalizeSourceUrl("https://git.corp.example/ave/marketplace"),
        auth: { kind: "none" },
      },
    ]);
    expect(policy.requiredInstalls).toEqual([{ kind: "plugin", name: "orion-api", source: "corp" }]);
    expect(policy.defaultInstalls).toEqual([{ kind: "plugin", name: "wiki-search", source: "corp" }]);
    expect(policy.allowDirectInstall).toBe(true);
    expect(policy.allowDisablingOfficial).toBe(false);
  });

  it("defaults allowDirectInstall to true and allowDisablingOfficial to false", async () => {
    const policy = await loaded({});
    expect(policy.allow).toBeNull();
    expect(policy.allowDirectInstall).toBe(true);
    expect(policy.allowDisablingOfficial).toBe(false);
  });

  it("gives an ssh additional source ssh auth and normalizes a token host", async () => {
    const policy = await loaded({
      additional: [
        { id: "corp-ssh", url: "git@git.corp.example:ave/market.git" },
        { id: "corp-web", url: "https://git.corp.example/ave/other", auth: { kind: "token", host: "GIT.Corp.Example." }, ref: "release/v1", label: "Corp" },
      ],
    });
    expect(policy.additional[0]!.auth).toEqual({ kind: "ssh" });
    expect(policy.additional[1]).toMatchObject({ auth: { kind: "token", host: "git.corp.example" }, ref: "release/v1", label: "Corp" });
  });

  it.each([
    ["an unknown key (a typo must not fail open)", { blok: ["host:x.example"] }, "marketplaces.blok: is not a known key"],
    ["a pattern that does not parse", { block: ["ftp://x.example/*"] }, "marketplaces.block[0]"],
    ["a wildcard in the middle", { allow: ["https://github.com/*/repo"] }, "marketplaces.allow[0]"],
    ["a non-boolean switch", { allowDirectInstall: "yes" }, "allowDirectInstall: must be true or false"],
    ["a reserved managed id", { additional: [{ id: "ave-corp", url: "https://git.corp.example/a" }] }, "ave-corp is reserved"],
    ["a managed id used twice", { additional: [{ id: "corp", url: "https://git.corp.example/a" }, { id: "corp", url: "https://git.corp.example/b" }] }, "corp is used twice"],
    ["the same repository twice", { additional: [{ id: "one", url: "https://git.corp.example/a" }, { id: "two", url: "https://GIT.corp.example/a.git" }] }, "already a source"],
    ["the official repository as a managed source", { additional: [{ id: "corp", url: "ken-jo/ave-marketplace-index" }] }, "already a source"],
    ["plain http without allowHttpHosts", { additional: [{ id: "corp", url: "http://git.corp.example/a" }] }, "allowHttpHosts"],
    ["a managed source its own policy blocks", { block: ["host:git.corp.example"], additional: [{ id: "corp", url: "https://git.corp.example/a" }] }, "blocked by this policy"],
    ["token auth on an ssh URL", { additional: [{ id: "corp", url: "ssh://git@git.corp.example/a", auth: { kind: "token", host: "git.corp.example" } }] }, "token auth needs an http(s) URL"],
    ["an unsafe ref", { additional: [{ id: "corp", url: "https://git.corp.example/a", ref: "main..evil" }] }, "is not a branch or tag name"],
    ["an install naming a custom source", { defaultInstalls: [{ kind: "plugin", name: "wiki", source: "someone" }] }, "must name the official source or an additional source"],
    ["an install with an unknown kind", { requiredInstalls: [{ kind: "widget", name: "wiki", source: "ave" }] }, "is not a package kind"],
    ["null for a list (a typo must not mean \"nothing\")", { block: null }, "marketplaces.block: must be an array of strings"],
    ["null for required installs", { requiredInstalls: null }, "marketplaces.requiredInstalls: must be an array"],
    ["a port on an allowHttpHosts entry", { allowHttpHosts: ["git.corp.example:8080"] }, "a host takes no port"],
    ["a token host other than the source's", { additional: [{ id: "corp", url: "https://git.corp.example/a", auth: { kind: "token", host: "github.com" } }] }, "must be the source's host git.corp.example"],
    ["an install listed twice", { requiredInstalls: [{ kind: "plugin", name: "wiki", source: "ave" }, { kind: "plugin", name: "wiki", source: "ave" }] }, "is listed twice"],
  ])("fails closed on %s", async (_label, section, message) => {
    expect(await rejected(section)).toContain(message);
  });

  it("fails closed on duplicate keys and unparseable JSON", async () => {
    writeFileSync(path, '{"version":1,"marketplaces":{"block":[],"block":["host:x.example"]}}');
    const duplicate = await loadMarketplacePolicy(path);
    expect(duplicate.ok).toBe(false);
    writeFileSync(path, "{ not json");
    expect((await loadMarketplacePolicy(path)).ok).toBe(false);
  });

  it("fails closed when the file cannot be read", async () => {
    const result = await loadMarketplacePolicy(dir);
    expect(result.ok).toBe(false);
  });
});

describe("isBlockedByPolicy", () => {
  it("lets block win over allow and treats a present allow list as exhaustive", async () => {
    const policy = await loaded({
      allow: ["https://github.com/acme/*", "host:git.corp.example"],
      block: ["https://github.com/acme/secret"],
    });
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/market"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://github.com/ACME/Market.git"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/secret"))).toBe(true);
    // Neither case nor another scheme sidesteps the block.
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("git@github.com:ACME/Secret.git"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://github.com:443/Acme/secret/"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme-corp/market"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("ssh://git@git.corp.example/any/repo"))).toBe(false);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://gitlab.com/acme/market"))).toBe(true);
  });

  it("allows everything not blocked when there is no allow list", async () => {
    const policy = await loaded({ block: ["host:git.example.org"] });
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("https://git.example.org/a/b"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("git@git.example.org:a/b"))).toBe(true);
    expect(isBlockedByPolicy(policy, normalizeSourceUrl("acme/market"))).toBe(false);
  });
});
