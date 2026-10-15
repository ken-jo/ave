import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { NetworkGate } from "../../net/network-gate.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { OFFICIAL_MARKETPLACE } from "../official.js";
import { policyLoad as policy, policySource } from "../../__tests__/fixtures/policy.js";
import type { PolicyLoad } from "../policy.js";
import { confirmationsFor, SourceRegistry, type GitSource, type NewFolderSource, type NewSource, type ResolvedSource } from "../registry.js";

let root: string;
const NOW = new Date("2026-09-23T08:00:00.000Z");
const COMMIT_A = "a".repeat(40);

/** A source the test expects to be a git source. */
function gitSource(source: ResolvedSource | undefined): GitSource {
  if (source?.transport !== "git") throw new Error(`expected a git source, got ${JSON.stringify(source)}`);
  return source;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-mkt-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CORP_POLICY = policy({
  additional: [{ transport: "git", id: "corp", url: normalizeSourceUrl("https://git.corp.example/ave/market"), auth: { kind: "none" }, label: "Corp" }],
});

function open(load: PolicyLoad = policy(), platform: NodeJS.Platform = process.platform): Promise<SourceRegistry> {
  return SourceRegistry.open({ root, policy: policySource(load), now: () => NOW, platform });
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

async function failure(promise: Promise<unknown>): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error;
    throw error;
  }
  throw new Error("expected a MarketplaceError");
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
    const official = gitSource(registry.get("ave"));
    expect(official.url.url).toBe(normalizeSourceUrl(OFFICIAL_MARKETPLACE.url).url);
    expect(official.auth).toEqual({ kind: "none" });
    expect(registry.get("corp")!.label).toBe("Corp");
  });

  it("serves no managed sources when the policy is unreadable", async () => {
    const registry = await open({ ok: false, error: "bad", path: "/fixture/ave-policy.json" });
    expect(registry.list().map((source) => source.id)).toEqual(["ave"]);
  });
});

describe("SourceRegistry.add", () => {
  it("stores the normalized URL in an owner-only sources.json and serves it", async () => {
    const registry = await open();
    const added = await registry.add(custom({ label: "Acme tools" }));
    expect(added).toMatchObject({ id: "acme", origin: "custom", label: "Acme tools" });
    expect(gitSource(added).url.url).toBe("https://github.com/Acme/Market");
    const file = JSON.parse(readFileSync(join(root, "sources.json"), "utf8"));
    expect(file).toEqual({
      version: 1,
      sources: [{ id: "acme", origin: "custom", url: "https://github.com/Acme/Market", auth: { kind: "none" }, addedAt: NOW.toISOString(), label: "Acme tools" }],
    });
    if (process.platform !== "win32") expect(statSync(join(root, "sources.json")).mode & 0o777).toBe(0o600);
    const reopened = await open();
    expect(gitSource(reopened.get("acme")).url.url).toBe("https://github.com/Acme/Market");
    expect(reopened.diagnostics()).toEqual([]);
  });

  it.each([
    ["ave", "SOURCE_NAME_RESERVED"],
    ["official", "SOURCE_NAME_RESERVED"],
    ["ave-official", "SOURCE_NAME_RESERVED"],
    ["ave-tools", "SOURCE_NAME_RESERVED"],
    ["Acme", "SOURCE_ID_INVALID"],
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
    expect(await code(registry.add(custom({ id: "mine", url: "ken-jo/agent-marketplace" })))).toBe("SOURCE_ID_TAKEN");
    // The refusal names the source it duplicates and the address as added, so the tab can offer *Show acme* (§18.8).
    const taken = await failure(registry.add(custom({ id: "acme-5", url: "https://github.com/ACME/market/" })));
    expect(taken.code).toBe("SOURCE_ID_TAKEN");
    expect(taken.detail).toEqual({ reason: "repository-already-added", url: "https://github.com/ACME/market", existingId: "acme" });
    // A taken id alone carries no detail: another id resolves it.
    expect((await failure(registry.add(custom({ url: "acme/other" })))).detail).toBeUndefined();
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
    ["a token host that is not a host name", { ...valid, auth: { kind: "token", host: "bad host" } }, "auth.host:"],
    ["a token host other than the source's", { ...valid, auth: { kind: "token", host: "gitlab.com" } }, "auth.host must be the source's host github.com"],
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
    const refused = await failure(registry.add(custom()));
    expect(refused.code).toBe("SOURCE_LIST_UNREADABLE");
    expect(refused.detail).toEqual({ reason: "invalid" });
    expect(readFileSync(join(root, "sources.json"), "utf8")).toBe('{"version":1,"sources":[],"sources":[]}');
  });

  it("refuses writes with the fs error's code, and no home path, when sources.json cannot be opened", async () => {
    mkdirSync(join(root, "sources.json"));
    const registry = await open();
    expect(registry.list().map((source) => source.id)).toEqual(["ave"]);
    const refused = await failure(registry.add(custom()));
    expect(refused.code).toBe("SOURCE_LIST_UNREADABLE");
    expect(refused.detail).toEqual({ reason: "unreadable", fsCode: "EISDIR" });
    expect(refused.message).toContain("sources.json (EISDIR)");
    for (const text of [refused.message, registry.diagnostics()[0]!.message]) expect(text).not.toContain(root);
    expect(statSync(join(root, "sources.json")).isDirectory()).toBe(true);
  });
});

describe("SourceRegistry sweep of copies Repair moved aside", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("opens even when the marketplaces folder cannot be listed, leaving the sweep for later", async () => {
    mkdirSync(join(root, ".trash-acme-left"));
    chmodSync(root, 0o300);
    try {
      const registry = await open();
      expect(registry.list().map((source) => source.id)).toEqual(["ave"]);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(existsSync(join(root, ".trash-acme-left"))).toBe(true);
    await open();
    expect(existsSync(join(root, ".trash-acme-left"))).toBe(false);
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

  it("keeps an unserved entry with the same id, and never lets a new source take that id", async () => {
    const stale = { id: "acme", origin: "custom", url: "https://GitHub.com/acme/old.git", auth: { kind: "none" }, addedAt: NOW.toISOString() };
    writeSources([stale]);
    const registry = await open();
    expect(registry.get("acme")).toBeUndefined();
    expect(await code(registry.add(custom()))).toBe("SOURCE_ID_TAKEN");

    // Two entries share an id: removing the served one leaves the other as written.
    const served = { ...stale, url: "https://github.com/acme/market" };
    writeSources([served, stale]);
    const reopened = await open();
    await reopened.remove("acme");
    expect(JSON.parse(readFileSync(join(root, "sources.json"), "utf8")).sources).toEqual([stale]);
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
    await expect(registry.readState("ave")).rejects.toMatchObject({
      code: "SOURCE_LOCAL_DATA_DAMAGED",
      message: "state.json of source ave is invalid: pinnedCommit must be null, a commit id or a folder revision",
      detail: { reason: "state-invalid", sourceId: "ave" },
    });
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

describe("confirmations are bound to the source's address (§18.5)", () => {
  const at = (url: string) => policy({ additional: [{ transport: "git", id: "team", url: normalizeSourceUrl(url), auth: { kind: "token", host: "git.example.test" } }] });

  it("drops a managed source's confirmations when its policy entry moves to another address, also after a restart", async () => {
    const moving = policySource(at("http://git.example.test:8000/old"));
    const registry = await SourceRegistry.open({ root, policy: moving, now: () => NOW });
    await registry.acknowledge("team", ["token-unencrypted", "internal-downloads"]);
    expect([...(await registry.acknowledged(registry.get("team")!))]).toEqual(["token-unencrypted", "internal-downloads"]);

    // The administrator points the same id at another service.
    moving.change(at("http://git.example.test:9000/new"));
    moving.apply((await moving.check())!);
    const moved = gitSource(registry.get("team"));
    expect(moved.url.url).toBe("http://git.example.test:9000/new");
    const held = await registry.acknowledged(moved);
    expect([...held]).toEqual([]);
    // So the gate offers no credential over plain http to the new service.
    const gate = new NetworkGate({ policy: moving, allowLoopback: false, transport: async () => new Response(null) });
    expect(gate.checkRemote(moved.url, { official: false, acknowledged: held }).credentialsAllowed).toBe(false);

    const reopened = await SourceRegistry.open({ root, policy: policySource(at("http://git.example.test:9000/new")), now: () => NOW });
    expect([...(await reopened.acknowledged(reopened.get("team")!))]).toEqual([]);
    // A confirmation given at the new address holds only what it gives.
    await reopened.acknowledge("team", ["unencrypted"]);
    expect([...(await reopened.acknowledged(reopened.get("team")!))]).toEqual(["unencrypted"]);
  });

  it("drops a custom source's confirmations when sources.json names another address", async () => {
    const registry = await open();
    await registry.add(custom({ url: "http://git.example.test:8000/a", acknowledged: ["unencrypted", "token-unencrypted"] }));
    expect([...(await registry.acknowledged(registry.get("acme")!))]).toEqual(["unencrypted", "token-unencrypted"]);
    const stored = JSON.parse(readFileSync(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    expect(stored.sources[0]!.acknowledged).toEqual({ url: "http://git.example.test:8000/a", warnings: ["unencrypted", "token-unencrypted"] });
    // Hand-edited to another port, the confirmations stay with the old address.
    writeSources([{ ...stored.sources[0], url: "http://git.example.test:9000/a" }]);
    const reopened = await open();
    expect([...(await reopened.acknowledged(reopened.get("acme")!))]).toEqual([]);
  });
});

describe("folder sources in the registry (§18.4.3, §18.4.4, §18.5)", () => {
  const LOCAL = `local-${"b".repeat(64)}`;
  const folder = (overrides: Partial<NewFolderSource> = {}): NewFolderSource => ({ id: "team", origin: "custom", path: "/srv/team", dev: 7n, ino: 42n, ancestors: [{ dev: 7n, ino: 2n }, { dev: 7n, ino: 30n }], ...overrides });

  it("stores a folder entry with its path and the confirmations bound to that path, and its identity in the state", async () => {
    const registry = await open(policy(), "linux");
    const added = await registry.addFolder(folder({ label: "Team", acknowledged: ["network-folder"] }));
    expect(added).toEqual({ transport: "folder", id: "team", origin: "custom", path: "/srv/team", auth: { kind: "none" }, label: "Team", acknowledged: ["network-folder"] });
    const file = JSON.parse(readFileSync(join(root, "sources.json"), "utf8"));
    expect(file.sources).toEqual([
      { id: "team", origin: "custom", path: "/srv/team", auth: { kind: "none" }, addedAt: NOW.toISOString(), label: "Team", acknowledged: { path: "/srv/team", warnings: ["network-folder"] } },
    ]);
    expect(await registry.readState("team")).toEqual({
      pinnedCommit: null,
      enabled: true,
      folder: { dev: "7", ino: "42", ancestors: [{ dev: "7", ino: "2" }, { dev: "7", ino: "30" }] },
    });
    const reopened = await open(policy(), "linux");
    expect(reopened.get("team")).toEqual(added);
    expect([...(await reopened.acknowledged(reopened.get("team")!))]).toEqual(["network-folder"]);
    expect(reopened.diagnostics()).toEqual([]);
  });

  it("holds no confirmation given for another path: confirmations are bound to the canonical path", async () => {
    writeSources([{ id: "team", origin: "custom", path: "/srv/team", auth: { kind: "none" }, addedAt: NOW.toISOString(), acknowledged: { path: "/srv/other", warnings: ["network-folder"] } }]);
    const registry = await open(policy(), "linux");
    expect(registry.get("team")).toMatchObject({ transport: "folder", acknowledged: [] });
    expect(registry.diagnostics()).toEqual([]);
  });

  it.each([
    ["/srv/Team", "/srv/team"],
    ["/srv/team", "/srv/team/"],
    ["/srv/Caf\u00e9", "/srv/Cafe\u0301"],
    ["C:\\Program Files\\m", "C:\\PROGRA~1\\m"],
    ["C:\\m", "X:\\m"],
    ["Z:\\m", "\\\\server\\share\\m"],
  ])("holds no confirmation given under %s for %s: another spelling is another path", (given, now) => {
    expect(confirmationsFor({ path: given, warnings: ["network-folder"] }, { path: now })).toEqual([]);
  });

  it("refuses a folder entry that carries git fields, and an acknowledged url on a folder", async () => {
    writeSources([
      { id: "refd", origin: "custom", path: "/srv/a", ref: "main", auth: { kind: "none" }, addedAt: NOW.toISOString() },
      { id: "both", origin: "custom", path: "/srv/b", url: "https://github.com/acme/market", auth: { kind: "none" }, addedAt: NOW.toISOString() },
      { id: "relative", origin: "custom", path: "srv/c", auth: { kind: "none" }, addedAt: NOW.toISOString() },
    ]);
    const registry = await open(policy(), "linux");
    expect(registry.list().map((source) => source.id)).toEqual(["ave"]);
    expect(registry.diagnostics().map((item) => item.subject)).toEqual(["refd", "both", "relative"]);
  });

  it("pairs a pin with its transport: a folder holds a folder revision, a git source a commit (§18.4.3)", async () => {
    const registry = await open(policy(), "linux");
    await registry.addFolder(folder());
    await registry.add(custom());
    await registry.writeState("team", { pinnedCommit: LOCAL, enabled: true, folder: { dev: "7", ino: "42", ancestors: [] } });
    expect((await registry.readState("team")).pinnedCommit).toBe(LOCAL);
    expect(await code(registry.writeState("team", { pinnedCommit: COMMIT_A, enabled: true }))).toContain("a folder source's pin must be a folder revision");
    expect(await code(registry.writeState("acme", { pinnedCommit: LOCAL, enabled: true }))).toContain("a git source's pin must be a commit id");
    expect(await code(registry.writeState("acme", { pinnedCommit: COMMIT_A, enabled: true, folder: { dev: "1", ino: "2", ancestors: [] } }))).toContain("a git source has no folder identity");
    // A folder identity without the directories above it is not one this version wrote.
    mkdirSync(join(root, "team"), { recursive: true });
    writeFileSync(join(root, "team", "state.json"), JSON.stringify({ pinnedCommit: LOCAL, enabled: true, folder: { dev: "7", ino: "42" } }));
    await expect(registry.readState("team")).rejects.toMatchObject({ code: "SOURCE_LOCAL_DATA_DAMAGED", detail: { reason: "state-invalid", sourceId: "team" } });

    // A state written by hand with the wrong pairing reads as damaged, not as a pin.
    mkdirSync(join(root, "acme"), { recursive: true });
    writeFileSync(join(root, "acme", "state.json"), JSON.stringify({ pinnedCommit: LOCAL, enabled: true }));
    await expect(registry.readState("acme")).rejects.toMatchObject({ code: "SOURCE_LOCAL_DATA_DAMAGED", detail: { reason: "state-invalid", sourceId: "acme" } });
  });

  it("gives a managed folder network-folder through its policy entry", async () => {
    const registry = await open(policy({ additional: [{ transport: "folder", id: "share", path: "/Volumes/share/market" }] }), "linux");
    const share = registry.get("share")!;
    expect(share).toMatchObject({ transport: "folder", origin: "managed", path: "/Volumes/share/market" });
    expect([...(await registry.acknowledged(share))]).toEqual(["network-folder"]);
  });
});
