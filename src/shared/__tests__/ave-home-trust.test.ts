// Home content trust (slice 3): the manifest, the load gate, R4 write admission, R5 intents and the review actions.
import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

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
});
