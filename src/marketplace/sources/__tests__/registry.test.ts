import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { OFFICIAL_MARKETPLACE } from "../official.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad } from "../policy.js";
import { SourceRegistry, type NewSource } from "../registry.js";

let root: string;
const NOW = new Date("2026-09-23T08:00:00.000Z");
const COMMIT_A = "a".repeat(40);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-mkt-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function policy(overrides: Partial<MarketplacePolicy> = {}): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides } };
}

const CORP_POLICY = policy({
  additional: [{ id: "corp", url: normalizeSourceUrl("https://git.corp.example/ave/market"), auth: { kind: "none" }, label: "Corp" }],
});

function open(load: PolicyLoad = policy()): Promise<SourceRegistry> {
  return SourceRegistry.open({ root, policy: load, now: () => NOW });
}

const custom = (overrides: Partial<NewSource> = {}): NewSource => ({
  id: "acme",
  origin: "custom",
  url: "https://GitHub.com/Acme/Market.git",
  auth: { kind: "none" },
  ...overrides,
});

function writeSources(sources: unknown[]): void {
  writeFileSync(join(root, "sources.json"), JSON.stringify({ version: 1, sources }));
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error.code;
    return `Error: ${(error as Error).message}`;
  }
  return "passed";
}

describe("SourceRegistry listing", () => {
  it("lists the official constant first, then managed sources from policy", async () => {
    const registry = await open(CORP_POLICY);
    expect(registry.list().map((source) => [source.id, source.origin])).toEqual([
      ["ave", "official"],
      ["corp", "managed"],
    ]);
    const official = registry.get("ave")!;
    expect(official.url.url).toBe(normalizeSourceUrl(OFFICIAL_MARKETPLACE.url).url);
    expect(official.auth).toEqual({ kind: "token", host: "github.com" });
    expect(registry.get("corp")!.label).toBe("Corp");
  });

  it("serves no managed sources when the policy is unreadable", async () => {
    const registry = await open({ ok: false, error: "bad" });
    expect(registry.list().map((source) => source.id)).toEqual(["ave"]);
  });
});

describe("SourceRegistry.add", () => {
  it("stores the normalized URL in an owner-only sources.json and serves it", async () => {
    const registry = await open();
    const added = await registry.add(custom({ label: "Acme tools" }));
    expect(added).toMatchObject({ id: "acme", origin: "custom", label: "Acme tools" });
    expect(added.url.url).toBe("https://github.com/Acme/Market");
    const file = JSON.parse(readFileSync(join(root, "sources.json"), "utf8"));
    expect(file).toEqual({
      version: 1,
      sources: [{ id: "acme", origin: "custom", url: "https://github.com/Acme/Market", auth: { kind: "none" }, addedAt: NOW.toISOString(), label: "Acme tools" }],
    });
    if (process.platform !== "win32") expect(statSync(join(root, "sources.json")).mode & 0o777).toBe(0o600);
    const reopened = await open();
    expect(reopened.get("acme")?.url.url).toBe("https://github.com/Acme/Market");
    expect(reopened.diagnostics()).toEqual([]);
  });

  it.each([
    ["ave", "SOURCE_NAME_RESERVED"],
    ["official", "SOURCE_NAME_RESERVED"],
    ["ave-official", "SOURCE_NAME_RESERVED"],
    ["ave-tools", "SOURCE_NAME_RESERVED"],
    ["Acme", "SOURCE_NAME_RESERVED"],
    ["corp", "SOURCE_ID_TAKEN"],
  ])("refuses the id %s with %s", async (id, expected) => {
    const registry = await open(CORP_POLICY);
    expect(await code(registry.add(custom({ id })))).toBe(expected);
  });

  it("refuses a second spelling of a repository that is already a source", async () => {
    const registry = await open(CORP_POLICY);
    await registry.add(custom());
    expect(await code(registry.add(custom({ id: "acme-2", url: "git@github.com:acme/market.git", auth: { kind: "ssh" } })))).toBe("SOURCE_ID_TAKEN");
    expect(await code(registry.add(custom({ id: "acme-3", url: "acme/market" })))).toBe("SOURCE_ID_TAKEN");
    expect(await code(registry.add(custom({ id: "acme-4", url: "acme/market-2" })))).toBe("passed");
    expect(await code(registry.add(custom({ id: "corp-2", url: "https://git.corp.example/ave/market/" })))).toBe("SOURCE_ID_TAKEN");
    expect(await code(registry.add(custom({ id: "mine", url: "ken-jo/ave-marketplace-index" })))).toBe("SOURCE_ID_TAKEN");
  });

  it("allows two direct sources from one repository with different subdirs", async () => {
    const registry = await open();
    await registry.add(custom({ id: "tool-a", origin: "direct", subdir: "plugins/a" }));
    expect(await code(registry.add(custom({ id: "tool-b", origin: "direct", subdir: "plugins/b" })))).toBe("passed");
    expect(await code(registry.add(custom({ id: "tool-c", origin: "direct", subdir: "plugins/a" })))).toBe("SOURCE_ID_TAKEN");
  });

  it("rejects unusable entries before writing anything", async () => {
    const registry = await open();
    expect(await code(registry.add(custom({ url: "file:///tmp/repo" })))).toBe("SOURCE_URL_REJECTED");
    expect(await code(registry.add(custom({ subdir: "plugins/a" })))).toBe("SOURCE_URL_REJECTED");
    expect(await code(registry.add(custom({ origin: "direct", subdir: "../escape" })))).toBe("SOURCE_URL_REJECTED");
    expect(await code(registry.add(custom({ auth: { kind: "ssh" } })))).toBe("SOURCE_URL_REJECTED");
    expect(await code(registry.add(custom({ ref: "main..x" })))).toBe("SOURCE_URL_REJECTED");
    expect(existsSync(join(root, "sources.json"))).toBe(false);
  });

  it("stores a token host in normalized form", async () => {
    const registry = await open();
    const added = await registry.add(custom({ auth: { kind: "token", host: "GitHub.com." } }));
    expect(added.auth).toEqual({ kind: "token", host: "github.com" });
  });

  it("serializes concurrent adds so neither is lost", async () => {
    const registry = await open();
    await Promise.all([registry.add(custom({ id: "one", url: "acme/one" })), registry.add(custom({ id: "two", url: "acme/two" }))]);
    const file = JSON.parse(readFileSync(join(root, "sources.json"), "utf8"));
    expect(file.sources.map((entry: { id: string }) => entry.id).sort()).toEqual(["one", "two"]);
  });
});

describe("SourceRegistry load checks", () => {
  const valid = { id: "acme", origin: "custom", url: "https://github.com/acme/market", auth: { kind: "none" }, addedAt: NOW.toISOString() };

  it("re-checks reserved ids and managed collisions on every load, leaving the file untouched", async () => {
    writeSources([
      { ...valid, id: "ave-tools", url: "https://github.com/acme/one" },
      { ...valid, id: "corp", url: "https://github.com/acme/two" },
      valid,
    ]);
    const registry = await open(CORP_POLICY);
    expect(registry.list().map((source) => source.id)).toEqual(["ave", "corp", "acme"]);
    expect(registry.get("corp")!.origin).toBe("managed");
    expect(registry.diagnostics()).toEqual([
      { subject: "ave-tools", message: "ave-tools is a reserved source id" },
      { subject: "corp", message: "corp is already used by a managed source" },
    ]);

    // A later write keeps the entries it does not serve.
    await registry.add(custom({ id: "extra", url: "acme/extra" }));
    const ids = JSON.parse(readFileSync(join(root, "sources.json"), "utf8")).sources.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual(["ave-tools", "corp", "acme", "extra"]);
  });

  it.each([
    ["an URL not in normalized form", { ...valid, url: "https://GitHub.com/acme/market.git" }, "not in normalized form"],
    ["a scheme that is not allowed", { ...valid, url: "file:///tmp/x" }, "source URL rejected"],
    ["an unknown key", { ...valid, token: "secret" }, "unknown key token"],
    ["a missing addedAt", { ...valid, addedAt: undefined }, "addedAt must be an ISO-8601 time"],
    ["a subdir on a custom source", { ...valid, subdir: "a" }, "subdir is for direct sources only"],
    ["an id used twice", valid, "acme is already used by a custom source"],
  ])("skips an entry with %s", async (_label, entry, message) => {
    writeSources(entry === valid ? [valid, valid] : [entry]);
    const registry = await open();
    expect(registry.diagnostics().map((diagnostic) => diagnostic.message).join("\n")).toContain(message);
    expect(registry.list().filter((source) => source.origin === "custom")).toHaveLength(entry === valid ? 1 : 0);
  });

  it("serves official and managed sources and refuses writes when sources.json is unreadable", async () => {
    writeFileSync(join(root, "sources.json"), '{"version":1,"sources":[],"sources":[]}');
    const registry = await open(CORP_POLICY);
    expect(registry.list().map((source) => source.id)).toEqual(["ave", "corp"]);
    expect(registry.diagnostics()[0]).toMatchObject({ subject: "sources.json" });
    expect(await code(registry.add(custom()))).toContain("repair or remove it");
    expect(readFileSync(join(root, "sources.json"), "utf8")).toBe('{"version":1,"sources":[],"sources":[]}');
  });
});

describe("SourceRegistry.remove", () => {
  it("removes a custom source and its directory", async () => {
    const registry = await open();
    await registry.add(custom());
    mkdirSync(join(root, "acme", "repo.git"), { recursive: true });
    await registry.remove("acme");
    expect(registry.get("acme")).toBeUndefined();
    expect(existsSync(join(root, "acme"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "sources.json"), "utf8")).sources).toEqual([]);
  });

  it("never removes the official or a managed source", async () => {
    const registry = await open(CORP_POLICY);
    expect(await code(registry.remove("ave"))).toContain("cannot be removed");
    expect(await code(registry.remove("corp"))).toContain("cannot be removed");
    expect(await code(registry.remove("nobody"))).toContain("no source named nobody");
  });
});

describe("SourceRegistry state", () => {
  it("starts unpinned and enabled, and round-trips a written state", async () => {
    const registry = await open();
    expect(await registry.readState("ave")).toEqual({ pinnedCommit: null, enabled: true });
    const state = {
      pinnedCommit: COMMIT_A,
      enabled: true,
      lastSync: { at: NOW.toISOString(), result: "SOURCE_UNREACHABLE" as const, candidate: "b".repeat(40) },
    };
    await registry.writeState("ave", state);
    expect(await registry.readState("ave")).toEqual(state);
    if (process.platform !== "win32") expect(statSync(join(root, "ave", "state.json")).mode & 0o777).toBe(0o600);
  });

  it("fails clearly on a state file it did not write, and refuses to write an invalid one", async () => {
    const registry = await open();
    mkdirSync(join(root, "ave"), { recursive: true });
    writeFileSync(join(root, "ave", "state.json"), JSON.stringify({ pinnedCommit: "main", enabled: true }));
    expect(await code(registry.readState("ave"))).toContain("pinnedCommit must be null or a commit id");
    expect(await code(registry.writeState("ave", { pinnedCommit: null, enabled: true, lastSync: { at: "x", result: "ok" } }))).toContain(
      "refusing to write an invalid state",
    );
    expect(await code(registry.writeState("nobody", { pinnedCommit: null, enabled: true }))).toContain("no source named nobody");
  });

  it("keeps the official source visible unless policy allows hiding it, and managed sources always", async () => {
    const strict = await open(CORP_POLICY);
    expect(await code(strict.setEnabled("ave", false))).toBe("SOURCE_POLICY_BLOCKED");
    expect(await code(strict.setEnabled("corp", false))).toBe("SOURCE_POLICY_BLOCKED");
    // A stored false from an earlier, looser policy is overridden.
    expect(strict.isEnabled(strict.get("ave")!, { pinnedCommit: null, enabled: false })).toBe(true);

    const loose = await open(policy({ allowDisablingOfficial: true }));
    await loose.setEnabled("ave", false);
    expect(loose.isEnabled(loose.get("ave")!, await loose.readState("ave"))).toBe(false);

    await loose.add(custom());
    await loose.setEnabled("acme", false);
    expect(await loose.readState("acme")).toEqual({ pinnedCommit: null, enabled: false });
  });
});
