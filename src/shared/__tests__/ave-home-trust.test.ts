// Home content trust (slice 3): the manifest, the load gate, R4 write admission, R5 intents and the review actions.
import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

const dacls = vi.hoisted(() => ({ override: undefined as undefined | ((paths: readonly string[]) => unknown[]) }));
vi.mock("../windows-path-facts.js", async (original) => {
  const actual = await original<typeof import("../windows-path-facts.js")>();
  return { ...actual, readWindowsDacls: (paths: readonly string[], options?: unknown) =>
    dacls.override !== undefined ? dacls.override(paths) : (actual.readWindowsDacls as (p: readonly string[], o?: unknown) => unknown)(paths, options) };
});

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { _resetAveHomePrivacyForTest, AveHomeConfigurationRefusedWriteError, ensureAveHomePrivate, setAveHomeConfigurationRefusedAtBoot } from "../ave-home.js";
import { AveHomeConfigurationNotOwnerError, setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import {
  _resetAveHomeTrustForTest,
  approveAveHomeTrustItems,
  aveHomeTreeDigest,
  classifyWindowsHomeEvidence,
  initialAveHomeTrustManifest,
  readAveHomeTreeDigestSync,
  removeNoFollow,
  evaluateAveHomeTrustAtBoot,
  getAveHomeTrustReview,
  isAveHomeTrustPendingAtBoot,
  readAveHomeEntrySync,
  readAveHomeInputSync,
  recordAveHomeInputWriteSync,
  removeAveHomeTrustItem,
  summarizeAveHomeInput,
} from "../ave-home-trust.js";
import { readApprovals, recordApproval } from "../../permissions/user-approval-store.js";
import { readPluginRegistry, updatePluginRegistry } from "../../plugins/registry.js";
import { readPermissionsFile } from "../../permissions/permissions-store.js";
import { DEFAULT_EXECUTION_MODE } from "../permission-mode.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { listCustomCommands } from "../../core/custom-commands.js";
import { guardAtomicWrite } from "../../lib/atomic-file.js";
import { updatePermissionsFile } from "../../permissions/permissions-store.js";
import { storedFileRulesLocation, updateProjectRulesFile } from "../../permissions/rules/project-rule-files.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import type { WindowsDaclFacts } from "../windows-path-facts.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const paths = useTempPaths("ave-home-trust-", ".ave");

afterEach(() => {
  _resetAveHomeTrustForTest();
  _resetAveHomePrivacyForTest();
  setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  vi.unstubAllEnvs();
});

const SERVERS = JSON.stringify({ servers: [{ name: "files", command: "/opt/tools/mcp-files --token secret-arg", env: { TOKEN: "env-secret" } }] });

/** A home after its protection check, before boot commits configuration. */
function home(): string {
  const dir = paths();
  setFixtureOwner(dirname(dir));
  expect(ensureAveHomePrivate(dir).enforcement).not.toBe("none");
  vi.stubEnv("AVE_HOME", dir);
  return dir;
}

function put(dir: string, rel: string, bytes: string): string {
  const path = join(dir, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** One boot: commit configuration, then evaluate the manifest. A later call is a restart of the same home. */
function boot(dir: string): ReturnType<typeof evaluateAveHomeTrustAtBoot> {
  _resetAveHomeTrustForTest();
  _resetAveHomePrivacyForTest();
  const privacy = ensureAveHomePrivate(dir);
  migrateAveHomeConfiguration(dir, privacy);
  return evaluateAveHomeTrustAtBoot(dir);
}

function manifest(dir: string): { state: string; entries: Record<string, { current?: string; pendingWrite?: string }> } {
  return JSON.parse(readFileSync(join(dir, "config", ".ave-trust-manifest.json"), "utf8"));
}

describe("home content trust manifest", () => {
  it("starts a new home fresh and trusts what Ave writes", () => {
    const dir = home();
    expect(boot(dir)).toEqual({ pending: false, state: "fresh" });
    const servers = join(dir, "mcp", "servers.json");
    writeUtf8FileAtomicSync(servers, SERVERS);
    expect(manifest(dir).entries["mcp/servers.json"]).toEqual({ current: sha256Hex(SERVERS) });
    expect(readAveHomeInputSync(servers)).toMatchObject({ status: "trusted" });
    expect(boot(dir).pending).toBe(false);
  });

  it("marks every item of an existing home pending until it is approved, and loads approved items after a restart", () => {
    const dir = home();
    const servers = put(dir, "mcp/servers.json", SERVERS);
    put(dir, "skills/notes/SKILL.md", "---\nname: notes\n---\nTake notes.");
    put(dir, "AGENTS.md", "# instructions");
    expect(boot(dir)).toEqual({ pending: true, state: "bootstrapped:false" });
    expect(isAveHomeTrustPendingAtBoot()).toBe(true);
    expect(readAveHomeInputSync(servers)).toMatchObject({ status: "untrusted", reason: "new" });
    expect(readAveHomeEntrySync(join(dir, "skills", "notes"))).toMatchObject({ status: "untrusted" });
    const review = getAveHomeTrustReview()!;
    expect(review.rows.map((row) => row.key).sort()).toEqual(["AGENTS.md", "mcp/servers.json", "skills/notes"]);
    // D1①: a clean legacy home offers one click.
    expect(review.approveAllOffered).toBe(true);
    expect(approveAveHomeTrustItems(review.snapshotId)).toBe(3);
    expect(manifest(dir).state).toBe("bootstrapped:true");
    expect(manifest(dir).entries["skills/notes"]).toEqual({
      current: aveHomeTreeDigest(new Map([["SKILL.md", Buffer.from("---\nname: notes\n---\nTake notes.")]])),
    });
    // Approval binds the hashes; the boot verdict (forced confinement) holds until the restart.
    expect(isAveHomeTrustPendingAtBoot()).toBe(true);
    expect(boot(dir)).toEqual({ pending: false, state: "bootstrapped:true" });
    expect(readAveHomeInputSync(servers)).toMatchObject({ status: "trusted" });
  });

  it("treats an absent or unreadable manifest as untrusted, never as approval", () => {
    const dir = home();
    put(dir, "AGENTS.md", "# instructions");
    boot(dir);
    approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId);
    writeFileSync(join(dir, "config", ".ave-trust-manifest.json"), "{not json");
    expect(boot(dir).pending).toBe(true);
    expect(readAveHomeInputSync(join(dir, "AGENTS.md"))).toMatchObject({ status: "untrusted" });
  });

  it("withdraws trust from an item changed outside Ave and offers only per-item approval", () => {
    const dir = home();
    const agents = put(dir, "AGENTS.md", "# instructions");
    boot(dir);
    approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId);
    writeFileSync(agents, "# planted");
    expect(boot(dir).pending).toBe(true);
    const review = getAveHomeTrustReview()!;
    expect(review.rows).toEqual([expect.objectContaining({ key: "AGENTS.md", reason: "changed", approvable: true })]);
    expect(review.approveAllOffered).toBe(false);
    expect(() => approveAveHomeTrustItems(review.snapshotId)).toThrowError(expect.objectContaining({ code: "not-offered" }));
    expect(approveAveHomeTrustItems(review.snapshotId, ["AGENTS.md"])).toBe(1);
  });

  it("records the hash the card rendered, so content swapped before the click stays untrusted", () => {
    const dir = home();
    const agents = put(dir, "AGENTS.md", "# shown");
    boot(dir);
    const review = getAveHomeTrustReview()!;
    writeFileSync(agents, "# swapped");
    approveAveHomeTrustItems(review.snapshotId, ["AGENTS.md"]);
    expect(boot(dir).pending).toBe(true);
    expect(readAveHomeInputSync(agents)).toMatchObject({ status: "untrusted", reason: "changed" });
  });

  it("refuses a stale snapshot", () => {
    const dir = home();
    put(dir, "AGENTS.md", "# instructions");
    boot(dir);
    const first = getAveHomeTrustReview()!;
    getAveHomeTrustReview();
    expect(() => approveAveHomeTrustItems(first.snapshotId, ["AGENTS.md"])).toThrowError(expect.objectContaining({ code: "stale" }));
  });

  it.runIf(process.platform !== "win32")("withholds one click when a moved config/ was found among the siblings (D3①)", () => {
    const dir = home();
    put(dir, "AGENTS.md", "# instructions");
    const moved = join(dir, "config-old");
    mkdirSync(moved, { mode: 0o700 });
    writeFileSync(join(moved, ".ave-config-migrated"), "ave-home-boundary-v1");
    boot(dir);
    const review = getAveHomeTrustReview()!;
    expect(review.approveAllOffered).toBe(false);
    expect(approveAveHomeTrustItems(review.snapshotId, ["AGENTS.md"])).toBe(1);
  });

  it("blocks approval while the home is refused, and while config/ requires recovery", () => {
    const refused = home();
    put(refused, "AGENTS.md", "# instructions");
    boot(refused);
    _resetAveHomeTrustForTest();
    setAveHomeConfigurationRefusedAtBoot(refused);
    expect(evaluateAveHomeTrustAtBoot(refused)).toEqual({ pending: true, unavailable: "permissions" });
    const review = getAveHomeTrustReview()!;
    expect(review.rows).toEqual([]);
    expect(() => approveAveHomeTrustItems(review.snapshotId)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    _resetAveHomePrivacyForTest();
    _resetAveHomeTrustForTest();

    const recovering = home();
    put(recovering, "config/policy.json", '{"version":1,"requireExplicitApproval":false}');
    put(recovering, "AGENTS.md", "# instructions");
    expect(boot(recovering)).toEqual({ pending: true, unavailable: "recovery" });
    expect(() => approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    expect(existsSync(join(recovering, "config", ".ave-trust-manifest.json"))).toBe(false);
  });
});

describe("load gate", () => {
  it("reads stores pending review as absent, keeping only the closed restriction overlay", async () => {
    const dir = home();
    put(dir, "permissions/user-approvals.json", JSON.stringify({ version: 1, approvals: { planted: { decision: "allow", scope: "global" } } }));
    put(dir, "plugins/registry.json", JSON.stringify({ version: 1, plugins: [{ id: "planted", manifestPath: "/x/plugin.json" }] }));
    put(dir, "permissions.json", JSON.stringify({ version: 1, mode: "auto", updatedAt: "", rules: [
      { pattern: "Bash(curl *)", action: "allow" }, { pattern: "Bash(rm *)", action: "deny" },
    ] }));
    boot(dir);
    expect((await readApprovals()).approvals).toEqual({});
    expect(await readPluginRegistry(join(dir, "plugins", "registry.json"))).toEqual({ version: 1, plugins: [], pendingReview: true });
    const permissions = await readPermissionsFile(join(dir, "permissions.json"));
    // R2: deny rules still apply; the widening mode and allow rules do not.
    expect(permissions?.rules).toEqual([expect.objectContaining({ pattern: "Bash(rm *)", action: "deny" })]);
    expect(permissions?.mode).toBe(DEFAULT_EXECUTION_MODE);
  });

  it("keeps pending memory and instruction documents out of the prompt", () => {
    const dir = home();
    put(dir, "memories/MEMORY.md", "- planted memory");
    put(dir, "AGENTS.md", "# planted instructions");
    boot(dir);
    expect(getAveHomeTrustReview()!.rows.map((row) => row.key).sort()).toEqual(["AGENTS.md", "memories/MEMORY.md"]);
    const memory = new MemoryManager({ aveDir: dir });
    memory.load();
    expect(memory.getMemoryIndex()).toBe("");
    expect(memory.getAgentsMd()).toBe("");
    approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId);
    boot(dir);
    memory.load();
    expect(memory.getMemoryIndex()).toContain("planted memory");
  });
});

describe("R4 write admission", () => {
  it("refuses to rewrite an item pending review from its absent view", () => {
    const dir = home();
    const servers = put(dir, "mcp/servers.json", SERVERS);
    boot(dir);
    expect(() => writeUtf8FileAtomicSync(servers, '{"servers":[]}')).toThrowError(AveHomeConfigurationRefusedWriteError);
    expect(() => writeUtf8FileAtomicSync(servers, '{"servers":[]}')).toThrowError(expect.objectContaining({ reason: "pending" }));
    expect(readFileSync(servers, "utf8")).toBe(SERVERS);
  });

  // Today's writers that can run without the host-instance lock (a second process: the CLI, an execution-mode MCP or skill add).
  // Each trusted-input write path refuses them with the one error the CLI shows: "Ave is running; close it or use the app".
  it.each([
    ["an MCP server definition", (dir: string) => writeUtf8FileAtomicSync(join(dir, "mcp", "servers.json"), SERVERS)],
    ["a skill approval", (dir: string) => writeUtf8FileAtomicSync(join(dir, "skill-approvals.json"), "{}")],
    ["a user skill", (dir: string) => recordAveHomeInputWriteSync(join(dir, "skills", "added.md"), "# added", () => writeFileSync(join(dir, "skills", "added.md"), "# added"))],
    ["a user approval", (_dir: string) => recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "global", verdictAtApproval: "medium", nlJustification: null,
    })],
    ["the extension registry", (dir: string) => updatePluginRegistry(join(dir, "plugins", "registry.json"), () => undefined)],
  ])("refuses %s from a writer without the host-instance lock", async (_label, write) => {
    const dir = home();
    boot(dir);
    mkdirSync(join(dir, "skills"), { recursive: true });
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => false });
    await expect(Promise.resolve().then(() => write(dir))).rejects.toBeInstanceOf(AveHomeConfigurationNotOwnerError);
    expect(new AveHomeConfigurationNotOwnerError().message).toContain("Ave is running");
  });
});

describe("R5 write intents", () => {
  it("records the intent before the write and collapses it after", () => {
    const dir = home();
    boot(dir);
    const path = join(dir, "AGENTS.md");
    recordAveHomeInputWriteSync(path, "# one", () => {
      expect(manifest(dir).entries["AGENTS.md"]).toEqual({ pendingWrite: sha256Hex("# one") });
      writeFileSync(path, "# one");
    });
    expect(manifest(dir).entries["AGENTS.md"]).toEqual({ current: sha256Hex("# one") });
  });

  it("clears the intent of a failed write so the old bytes never match it", () => {
    const dir = home();
    boot(dir);
    const path = join(dir, "AGENTS.md");
    expect(() => recordAveHomeInputWriteSync(path, "# one", () => { throw new Error("disk full"); })).toThrow("disk full");
    expect(manifest(dir).entries["AGENTS.md"]).toBeUndefined();
  });

  it("collapses a crashed write's intent at boot only when the file holds exactly its bytes", () => {
    const dir = home();
    boot(dir);
    const landed = join(dir, "AGENTS.md");
    const lost = join(dir, "user-preferences.md");
    const persisted = manifest(dir);
    persisted.entries["AGENTS.md"] = { pendingWrite: sha256Hex("# landed") };
    persisted.entries["user-preferences.md"] = { pendingWrite: sha256Hex("# never written") };
    writeFileSync(join(dir, "config", ".ave-trust-manifest.json"), JSON.stringify({ version: 1, ...persisted }));
    writeFileSync(landed, "# landed");
    writeFileSync(lost, "# planted");
    boot(dir);
    expect(manifest(dir).entries["AGENTS.md"]).toEqual({ current: sha256Hex("# landed") });
    expect(manifest(dir).entries["user-preferences.md"]).toBeUndefined();
    expect(readAveHomeInputSync(landed)).toMatchObject({ status: "trusted" });
    expect(readAveHomeInputSync(lost)).toMatchObject({ status: "untrusted" });
  });
});

describe("links and removal", () => {
  it.runIf(process.platform !== "win32")("reads a linked item as untrusted and removes the link without touching its target (D4①)", () => {
    const dir = home();
    const target = join(dirname(dir), "outside-skill");
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "outside");
    mkdirSync(join(dir, "skills"), { recursive: true });
    symlinkSync(target, join(dir, "skills", "linked"), "dir");
    boot(dir);
    const review = getAveHomeTrustReview()!;
    expect(review.rows).toEqual([expect.objectContaining({ key: "skills/linked", reason: "link", approvable: false })]);
    expect(() => approveAveHomeTrustItems(review.snapshotId, ["skills/linked"])).toThrowError(expect.objectContaining({ code: "not-approvable" }));
    removeAveHomeTrustItem(getAveHomeTrustReview()!.snapshotId, "skills/linked");
    expect(existsSync(join(dir, "skills", "linked"))).toBe(false);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("outside");
  });

  it("removes a pending tree item entry by entry", () => {
    const dir = home();
    put(dir, "commands/deploy.md", "deploy now");
    put(dir, "agents/helper/AGENTS.md", "help");
    boot(dir);
    removeAveHomeTrustItem(getAveHomeTrustReview()!.snapshotId, "agents/helper");
    expect(existsSync(join(dir, "agents", "helper"))).toBe(false);
    expect(lstatSync(join(dir, "commands", "deploy.md")).isFile()).toBe(true);
  });

  it("does not list a user command pending review", async () => {
    const dir = home();
    put(dir, "commands/deploy.md", "---\ndescription: deploy\n---\ndeploy now");
    boot(dir);
    expect(await listCustomCommands(undefined)).toEqual([]);
    approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId);
    boot(dir);
    expect((await listCustomCommands(undefined)).map((entry) => entry.name)).toEqual(["deploy"]);
  });
});

describe("fresh home writes through the stores", () => {
  // A file lock creates its target empty before the first write; that placeholder must not make a fresh home pending.
  it("leaves nothing pending after permissions, project rules, the reviewer cache and memory are written", async () => {
    const dir = home();
    expect(boot(dir)).toEqual({ pending: false, state: "fresh" });
    await updatePermissionsFile(join(dir, "permissions.json"), (file) => { file.rules.push({ pattern: "Bash(git status)", action: "allow" } as never); });
    const location = storedFileRulesLocation(dir, "a".repeat(64), "/work/project");
    await updateProjectRulesFile(location, (file) => { file.rules.push({ pattern: "Bash(npm test)", action: "allow" } as never); });
    const cache = new VerdictCache(join(dir, "permissions", "reviewer-cache.jsonl"));
    await cache.store(
      { toolName: "fs_write", source: "builtin", category: "write", trustOrigin: "user-keyboard", finalInput: { path: "/work/a.md" } },
      { allowedDirectories: ["/work"], scope: { mode: "deny-all" } },
      { level: "low", reason: "ok" },
    );
    const memory = new MemoryManager({ aveDir: dir });
    memory.load();
    await memory.saveMemory("Build", "Run the tests before pushing.");
    expect(getAveHomeTrustReview()!.rows).toEqual([]);
    expect(boot(dir)).toEqual({ pending: false, state: "fresh" });
    expect(getAveHomeTrustReview()!.rows).toEqual([]);
    expect((await readPermissionsFile(join(dir, "permissions.json")))?.rules).toEqual([expect.objectContaining({ pattern: "Bash(git status)" })]);
    expect(new VerdictCache(join(dir, "permissions", "reviewer-cache.jsonl")).lookup(
      { toolName: "fs_write", source: "builtin", category: "write", trustOrigin: "user-keyboard", finalInput: { path: "/work/a.md" } },
      { allowedDirectories: ["/work"], scope: { mode: "deny-all" } },
    ).hit).toBe(true);
  });

  it("reads an empty file nothing vouches for as absent, but an emptied approved file as changed", () => {
    const dir = home();
    const permissions = put(dir, "permissions.json", "");
    expect(boot(dir).pending).toBe(false);
    expect(readAveHomeInputSync(permissions)).toEqual({ status: "absent" });
    writeUtf8FileAtomicSync(permissions, '{"version":1,"rules":[],"mode":"default","updatedAt":""}');
    writeFileSync(permissions, "");
    expect(readAveHomeInputSync(permissions)).toMatchObject({ status: "untrusted", reason: "changed" });
  });

  it("writes memory again after its pending index was removed", async () => {
    const dir = home();
    put(dir, "memories/MEMORY.md", "- planted memory");
    boot(dir);
    removeAveHomeTrustItem(getAveHomeTrustReview()!.snapshotId, "memories/MEMORY.md");
    const memory = new MemoryManager({ aveDir: dir });
    memory.load();
    await memory.saveMemory("Build", "Run the tests before pushing.");
    expect(boot(dir).pending).toBe(false);
  });
});

describe("approve all stays closed", () => {
  it("never offers approve all for a home whose commit saw a moved config/ beside it, even after a restart", () => {
    const dir = home();
    put(dir, "AGENTS.md", "# instructions");
    const moved = join(dir, "config.old");
    mkdirSync(moved, { mode: 0o700 });
    writeFileSync(join(moved, ".ave-config-migrated"), "ave-home-boundary-v1");
    boot(dir);
    expect(manifest(dir)).toMatchObject({ state: "bootstrapped:false", oneByOne: true });
    expect(getAveHomeTrustReview()!.approveAllOffered).toBe(false);
    boot(dir);
    const review = getAveHomeTrustReview()!;
    expect(review.approveAllOffered).toBe(false);
    expect(() => approveAveHomeTrustItems(review.snapshotId)).toThrowError(expect.objectContaining({ code: "not-offered" }));
    expect(approveAveHomeTrustItems(review.snapshotId, ["AGENTS.md"])).toBe(1);
  });

  it("does not reopen approve all when the manifest is deleted or corrupted", () => {
    const dir = home();
    put(dir, "AGENTS.md", "# instructions");
    boot(dir);
    expect(getAveHomeTrustReview()!.approveAllOffered).toBe(true);
    writeFileSync(join(dir, "config", ".ave-trust-manifest.json"), "{not json");
    boot(dir);
    expect(manifest(dir)).toMatchObject({ state: "bootstrapped:false", oneByOne: true });
    expect(getAveHomeTrustReview()!.approveAllOffered).toBe(false);
  });

  it("writes the one-by-one flag only when the commit saw a moved configuration", () => {
    const dir = home();
    expect(JSON.parse(initialAveHomeTrustManifest(dir, true))).toEqual({ version: 1, state: "bootstrapped:false", entries: {} });
    expect(JSON.parse(initialAveHomeTrustManifest(dir, true, true))).toEqual({ version: 1, state: "bootstrapped:false", oneByOne: true, entries: {} });
  });
});

describe("overlapping writes", () => {
  it("settles on the bytes whose rename landed last, whichever callback runs first", async () => {
    const dir = home();
    boot(dir);
    const path = join(dir, "AGENTS.md");
    let landA!: () => void;
    let landB!: () => void;
    const a = guardAtomicWrite(path, "first", () => new Promise<void>((done) => { landA = done; }));
    const b = guardAtomicWrite(path, "second", () => new Promise<void>((done) => { landB = done; }));
    // B renames, then A: A's bytes are on disk. A's callback runs first, B's last.
    writeFileSync(path, "second");
    writeFileSync(path, "first");
    landA();
    await a;
    landB();
    await b;
    expect(readAveHomeInputSync(path)).toMatchObject({ status: "trusted" });
    expect(manifest(dir).entries["AGENTS.md"]).toEqual({ current: sha256Hex("first") });
    expect(boot(dir).pending).toBe(false);
  });

  it("keeps what another write committed when an overlapping one fails", async () => {
    const dir = home();
    boot(dir);
    const path = join(dir, "AGENTS.md");
    let failB!: () => void;
    const b = guardAtomicWrite(path, "second", () => new Promise<void>((_done, fail) => { failB = () => fail(new Error("disk full")); }));
    await guardAtomicWrite(path, "first", async () => { writeFileSync(path, "first"); });
    failB();
    await expect(b).rejects.toThrow("disk full");
    expect(readAveHomeInputSync(path)).toMatchObject({ status: "trusted" });
    expect(manifest(dir).entries["AGENTS.md"]).toEqual({ current: sha256Hex("first") });
  });
});

describe("item digests and listing", () => {
  it("never lets a file stand in for an approved tree with the same serialization", () => {
    const dir = home();
    put(dir, "skills/notes/SKILL.md", "notes");
    boot(dir);
    approveAveHomeTrustItems(getAveHomeTrustReview()!.snapshotId);
    const tree = manifest(dir).entries["skills/notes"]!.current!;
    expect(tree).toBe(aveHomeTreeDigest(new Map([["SKILL.md", Buffer.from("notes")]])));
    expect(readAveHomeTreeDigestSync(join(dir, "skills", "notes"))).toBe(tree);
    removeNoFollow(join(dir, "skills", "notes"));
    put(dir, "skills/notes", `ave-tree-v1\nSKILL.md\0${sha256Hex("notes")}\n`);
    expect(boot(dir).pending).toBe(true);
    expect(readAveHomeEntrySync(join(dir, "skills", "notes"))).toMatchObject({ status: "untrusted", reason: "changed" });
  });

  it("shows an item directory that is itself a link, and removes only the link", () => {
    const dir = home();
    const outside = join(dirname(dir), "outside-skills");
    put(outside, "notes/SKILL.md", "outside");
    symlinkSync(outside, join(dir, "skills"));
    expect(boot(dir).pending).toBe(true);
    const review = getAveHomeTrustReview()!;
    expect(review.rows).toEqual([expect.objectContaining({ key: "skills", reason: "link", approvable: false })]);
    removeAveHomeTrustItem(review.snapshotId, "skills");
    expect(existsSync(join(dir, "skills"))).toBe(false);
    expect(readFileSync(join(outside, "notes", "SKILL.md"), "utf8")).toBe("outside");
  });

  it("removes a tree through no-follow handles, leaving a linked target untouched", () => {
    const dir = home();
    const outside = join(dirname(dir), "outside-data");
    put(outside, "keep.txt", "keep");
    put(dir, "agents/helper/AGENTS.md", "help");
    symlinkSync(outside, join(dir, "agents", "helper", "data"));
    removeNoFollow(join(dir, "agents", "helper"), dir);
    expect(existsSync(join(dir, "agents", "helper"))).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("Windows owner and ACL overlay", () => {
  const user = "S-1-5-21-1-2-3-1001";
  const other = "S-1-5-21-1-2-3-1002";
  function row(owner: string, aces: Array<{ sid: string; allow: boolean }>): WindowsDaclFacts {
    return {
      exists: true, directory: false, currentUserSid: user, elevated: false,
      dacl: { owner, protected: true, nullDacl: false, aces: aces.map(({ sid, allow }) => ({ sid, type: allow ? 0 : 1, mask: 0x1f01ff, flags: 0 })) },
    } as unknown as WindowsDaclFacts;
  }

  it("withdraws trust from an item another account owns", () => {
    const result = classifyWindowsHomeEvidence([row(other, [{ sid: user, allow: true }])], ["AGENTS.md"]);
    expect(result.withdrawn.get("AGENTS.md")).toBe("foreign-owner");
    expect(result.clean).toBe(false);
  });

  it("withdraws trust from an item another account can change, including through a parent folder", () => {
    const result = classifyWindowsHomeEvidence(
      [row(user, [{ sid: user, allow: true }]), row(user, [{ sid: user, allow: true }, { sid: other, allow: true }])],
      ["skills/notes", "skills/notes"],
    );
    expect(result.withdrawn.get("skills/notes")).toBe("foreign-access");
    expect(result.clean).toBe(false);
  });

  it("reads the evidence again at review time, so an item planted after boot is judged on its own", () => {
    const dir = home();
    put(dir, "agents.custom.md", "# custom");
    boot(dir);
    put(dir, "user-preferences.md", "planted after boot");
    const platform = process.platform;
    dacls.override = (paths) => paths.map((path) => path.endsWith("user-preferences.md")
      ? row(other, [{ sid: user, allow: true }]) : row(user, [{ sid: user, allow: true }]));
    try {
      setProcessPlatform("win32");
      const review = getAveHomeTrustReview()!;
      expect(review.rows.find((entry) => entry.key === "user-preferences.md")).toMatchObject({ reason: "foreign-owner", approvable: false });
      expect(review.approveAllOffered).toBe(false);
      expect(() => approveAveHomeTrustItems(review.snapshotId)).toThrowError(expect.objectContaining({ code: "not-offered" }));
    } finally {
      setProcessPlatform(platform);
      dacls.override = undefined;
    }
  });

  it("withholds approve all when the evidence read at review time fails, even with no item withdrawn", () => {
    const dir = home();
    put(dir, "agents.custom.md", "# custom");
    boot(dir);
    expect(getAveHomeTrustReview()!.approveAllOffered).toBe(true);
    const platform = process.platform;
    dacls.override = () => { throw new Error("native read failed"); };
    try {
      setProcessPlatform("win32");
      const review = getAveHomeTrustReview()!;
      expect(review.rows.every((entry) => entry.approvable)).toBe(true);
      expect(review.approveAllOffered).toBe(false);
      expect(() => approveAveHomeTrustItems(review.snapshotId)).toThrowError(expect.objectContaining({ code: "not-offered" }));
    } finally {
      setProcessPlatform(platform);
      dacls.override = undefined;
    }
  });

  // A case-sensitive file system lets two names fold to one Windows key; only Linux test hosts can make both names.
  it.runIf(process.platform === "linux")("refuses approval of two items whose names fold to one key on Windows", () => {
    const dir = home();
    put(dir, "skills/Notes/SKILL.md", "upper");
    put(dir, "skills/notes/SKILL.md", "lower");
    boot(dir);
    const platform = process.platform;
    dacls.override = (paths) => paths.map(() => row(user, [{ sid: user, allow: true }]));
    try {
      setProcessPlatform("win32");
      const rows = getAveHomeTrustReview()!.rows.filter((entry) => entry.key === "skills/notes");
      expect(rows).toHaveLength(2);
      for (const entry of rows) expect(entry).toMatchObject({ reason: "unreadable", approvable: false });
    } finally {
      setProcessPlatform(platform);
      dacls.override = undefined;
    }
  });

  it("keeps an item the user, SYSTEM and Administrators hold, and treats missing facts as unclean", () => {
    const clean = classifyWindowsHomeEvidence([row("S-1-5-32-544", [{ sid: user, allow: true }, { sid: "S-1-5-18", allow: true }])], ["AGENTS.md"]);
    expect(clean).toEqual({ withdrawn: new Map(), clean: true });
    expect(classifyWindowsHomeEvidence([], ["AGENTS.md"]).clean).toBe(false);
  });
});

describe("review summary", () => {
  it("masks arguments, environment and URL credentials", () => {
    const servers = Buffer.from(JSON.stringify({ servers: [
      { name: "files", command: "/opt/tools/mcp-files --token secret-arg", args: ["--key", "arg-secret"], env: { TOKEN: "env-secret" } },
      { name: "remote", url: "https://user:pass@example.test/mcp?key=query-secret", headers: { Authorization: "Bearer header-secret" } },
    ] }));
    const summary = summarizeAveHomeInput("mcp/servers.json", { bytes: servers })!;
    expect(summary).toBe("files: mcp-files, remote: https://example.test");
    for (const secret of ["secret-arg", "arg-secret", "env-secret", "pass", "query-secret", "header-secret", "/opt/tools"]) expect(summary).not.toContain(secret);
    expect(summarizeAveHomeInput("plugins/.cache/demo/install-receipt.json", { bytes: Buffer.from('{"pluginId":"demo","version":"1.2.0","files":{}}') })).toBe("demo@1.2.0");
    expect(summarizeAveHomeInput("permissions.json", { bytes: Buffer.from('{"version":1,"mode":"auto","rules":[{"pattern":"Bash(git *)","action":"allow"},{"pattern":"rm","action":"deny"}]}') }))
      .toBe("mode auto; allow Bash(git *)");
    expect(summarizeAveHomeInput("mcp/servers.json", { bytes: Buffer.from("{not json") })).toBeUndefined();
  });
});

describe.runIf(process.platform !== "win32")("POSIX home protection", () => {
  it("refuses a home under a group-writable ancestor without changing its modes", () => {
    const dir = paths();
    const parent = dirname(dir);
    chmodSync(parent, 0o770);
    try {
      const privacy = ensureAveHomePrivate(dir);
      expect(privacy).toMatchObject({ enforcement: "none", category: "posix-root-unsafe", failedPath: parent });
      expect(lstatSync(parent).mode & 0o777).toBe(0o770);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("refuses a home reached through a link that sits in a folder others can write", () => {
    const base = dirname(paths());
    const safe = join(base, "safe");
    const open = join(base, "open");
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(open, { mode: 0o700 });
    symlinkSync(safe, join(open, "link"));
    chmodSync(open, 0o770);
    try {
      const privacy = ensureAveHomePrivate(join(open, "link", ".ave"));
      expect(privacy).toMatchObject({ enforcement: "none", category: "posix-root-unsafe", failedPath: open });
    } finally {
      chmodSync(open, 0o700);
    }
  });
});
