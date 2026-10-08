/**
 * The git marketplace's MCP installer (design §5.2, §8.1): it owns only the
 * servers it recorded, swaps files and config together, keeps `$DATA_DIR`
 * across updates, and restores the previous server when a step fails.
 */
import AdmZip from "adm-zip";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../../mcp/types.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import type { ResolvedMcpServer } from "../../resolve/mcp.js";
import { McpInstaller, mcpInstallOrigins } from "../mcp-installer.js";

const SNAPSHOT = "a".repeat(40);

/** Set to make the next record writes fail, as a full disk would. */
const recordWrites = vi.hoisted(() => ({ fail: false }));
vi.mock("../../../main/storage/feature-namespace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../main/storage/feature-namespace.js")>();
  return {
    ...actual,
    writeFileAtomicAtPath: async (...args: Parameters<typeof actual.writeFileAtomicAtPath>) => {
      if (recordWrites.fail) throw new Error("disk full");
      return actual.writeFileAtomicAtPath(...args);
    },
  };
});

class FakeManager {
  configs = new Map<string, McpServerConfig>();
  failNextAdd = false;
  /** The next add saves the config but its connection fails with this message. */
  disconnectedNextAdd: string | null = null;
  blocked = new Set<string>();
  validateConfig(config: McpServerConfig) {
    return this.blocked.has(config.id) ? { valid: false as const, reason: `Unapproved server: '${config.id}'`, layer: 1 } : { valid: true as const };
  }
  async getConfigs() {
    return [...this.configs.values()];
  }
  async addConfig(config: McpServerConfig) {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error("connect refused");
    }
    if (this.configs.has(config.id)) throw new Error(`${config.id} exists`);
    this.configs.set(config.id, config);
    const warning = this.disconnectedNextAdd;
    this.disconnectedNextAdd = null;
    return warning ? { connected: false, warning } : { connected: true };
  }
  async removeConfig(id: string) {
    this.configs.delete(id);
  }
}

function serverZip(script: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("server/run.sh", Buffer.from(script), "", 0o755);
  zip.addFile("server/README.md", Buffer.from("docs"), "", 0o644);
  return zip.toBuffer();
}

function resolved(version: string, options: { files?: Buffer; sourceId?: string } = {}): ResolvedMcpServer {
  return {
    plan: {
      sourceId: options.sourceId ?? "acme",
      sourceOrigin: "custom",
      snapshotCommit: SNAPSHOT,
      versionCommit: "b".repeat(40),
      packagePath: "mcp/notes",
      kind: "mcp",
      name: "notes",
      version,
      minAppVersion: "0.0.0",
    },
    from: "descriptor",
    runtime: options.files
      ? { transport: "stdio", command: "$PLUGIN_DIR/server/run.sh", args: ["--data", "$DATA_DIR"] }
      : { transport: "stdio", command: "npx", args: ["-y", `notes-mcp@${version}`] },
    packageFiles: options.files ? { zipBuffer: options.files, digest: "c".repeat(64) } : null,
  };
}

describe("McpInstaller", () => {
  let home: string;
  let manager: FakeManager;
  let installer: McpInstaller;
  const recordsPath = () => join(home, "packages", "mcp-installs.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-mcp-installer-"));
    manager = new FakeManager();
    const files = new PluginArtifactStore({
      installRoot: join(home, "mcp"),
      cacheRoot: join(home, "mcp", ".cache"),
    });
    installer = new McpInstaller({
      recordsPath: recordsPath(),
      dataRoot: join(home, "mcp-data"),
      files,
      manager,
      nodePath: "/usr/bin/node",
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("installs package files with their execute bit, fills the tokens, and records the origin", async () => {
    await expect(installer.install(resolved("1.0.0", { files: serverZip("#!/bin/sh\necho v1\n") }), { switchSource: false })).resolves.toEqual({ action: { action: "install" }, connectionWarning: null });
    const script = join(home, "mcp", "notes", "server", "run.sh");
    expect(await readFile(script, "utf8")).toContain("v1");
    if (process.platform !== "win32") {
      expect((await stat(script)).mode & 0o111).not.toBe(0);
      expect((await stat(join(home, "mcp", "notes", "server", "README.md"))).mode & 0o111).toBe(0);
    }
    // `$PLUGIN_DIR` is replaced in the author's text, so the rest of the path keeps its `/`.
    expect(manager.configs.get("notes")).toMatchObject({ command: `${join(home, "mcp", "notes")}/server/run.sh`, args: ["--data", join(home, "mcp-data", "notes")] });
    expect((await stat(join(home, "mcp-data", "notes"))).isDirectory()).toBe(true);
    expect(await installer.list()).toEqual([{ kind: "mcp", name: "notes", version: "1.0.0", sourceId: "acme", originCommit: SNAPSHOT }]);
    expect(await mcpInstallOrigins(recordsPath())()).toEqual([{ kind: "mcp", name: "notes", sourceId: "acme", commit: SNAPSHOT }]);
  });

  it("refuses to mark executable a zip entry that extraction did not write as named, and registers nothing", async () => {
    const installDir = join(home, "mcp", "notes");
    const skipping = new McpInstaller({
      recordsPath: recordsPath(),
      dataRoot: join(home, "mcp-data"),
      // An extractor that dropped the executable entry: the mode bits must not be applied to some other path.
      files: {
        installDirFor: () => installDir,
        extractZipWithCommit: async (_name, _zip, commit) => ({ result: await commit(installDir, ["server/README.md"]) }),
      },
      manager,
      nodePath: "/usr/bin/node",
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    });
    await expect(skipping.install(resolved("1.0.0", { files: serverZip("#!/bin/sh\n") }), { switchSource: false })).rejects.toThrow(/server\/run\.sh" was not extracted as named/);
    expect(manager.configs.size).toBe(0);
    expect(await skipping.list()).toEqual([]);
  });

  it("updates in place and keeps $DATA_DIR; a failed config add restores the previous files and config", async () => {
    await installer.install(resolved("1.0.0", { files: serverZip("v1") }), { switchSource: false });
    await writeFile(join(home, "mcp-data", "notes", "state.db"), "kept");
    await expect(installer.install(resolved("1.1.0", { files: serverZip("v2") }), { switchSource: false })).resolves.toEqual({
      action: { action: "replace", direction: "upgrade", from: "1.0.0" },
      connectionWarning: null,
    });
    expect(await readFile(join(home, "mcp", "notes", "server", "run.sh"), "utf8")).toBe("v2");
    expect(await readFile(join(home, "mcp-data", "notes", "state.db"), "utf8")).toBe("kept");

    manager.failNextAdd = true;
    await expect(installer.install(resolved("1.2.0", { files: serverZip("v3") }), { switchSource: false })).rejects.toThrow("connect refused");
    expect(await readFile(join(home, "mcp", "notes", "server", "run.sh"), "utf8")).toBe("v2");
    expect(manager.configs.has("notes")).toBe(true);
    expect((await installer.list())[0]!.version).toBe("1.1.0");
  });

  it("keeps a server whose first connection failed and says why", async () => {
    manager.disconnectedNextAdd = "Request timeout (10000ms): server/discover";
    await expect(installer.install(resolved("1.0.0"), { switchSource: false })).resolves.toEqual({
      action: { action: "install" },
      connectionWarning: "Request timeout (10000ms): server/discover",
    });
    expect(manager.configs.has("notes")).toBe(true);
    expect((await installer.list())[0]!.version).toBe("1.0.0");
  });

  it("writes nothing for a server the governance policy refuses", async () => {
    manager.blocked.add("notes");
    await expect(installer.install(resolved("1.0.0", { files: serverZip("v1") }), { switchSource: false })).rejects.toMatchObject({ code: "PACKAGE_POLICY_BLOCKED" });
    await expect(installer.installUnbound("notes", { transport: "http", url: "https://notes.example/mcp" })).rejects.toMatchObject({ code: "PACKAGE_POLICY_BLOCKED" });
    expect(() => installer.admit("notes", { transport: "stdio", command: "npx", args: [] })).toThrow(expect.objectContaining({ code: "PACKAGE_POLICY_BLOCKED" }));
    await expect(stat(join(home, "mcp", "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(home, "mcp-data", "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(recordsPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.configs.size).toBe(0);
  });

  it("removes the data directory a failed first install created, and keeps one that held data", async () => {
    manager.failNextAdd = true;
    await expect(installer.install(resolved("1.0.0"), { switchSource: false })).rejects.toThrow("connect refused");
    await expect(stat(join(home, "mcp-data", "notes"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(home, "mcp-data", "notes"), { recursive: true });
    await writeFile(join(home, "mcp-data", "notes", "state.db"), "kept");
    manager.failNextAdd = true;
    await expect(installer.install(resolved("1.0.0"), { switchSource: false })).rejects.toThrow("connect refused");
    expect(await readFile(join(home, "mcp-data", "notes", "state.db"), "utf8")).toBe("kept");
  });

  it("removes the previous version's files when the new one runs none", async () => {
    await installer.install(resolved("1.0.0", { files: serverZip("v1") }), { switchSource: false });
    await installer.install(resolved("2.0.0"), { switchSource: false });
    await expect(stat(join(home, "mcp", "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.configs.get("notes")).toMatchObject({ command: "npx", args: ["-y", "notes-mcp@2.0.0"] });
  });

  it("refuses a name the user configured by hand, and another source without switchSource", async () => {
    await manager.addConfig({ id: "notes", transport: "stdio", command: "mine", auth: "none" });
    await expect(installer.install(resolved("1.0.0"), { switchSource: false })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    expect(manager.configs.get("notes")).toMatchObject({ command: "mine" });

    await manager.removeConfig("notes");
    await installer.install(resolved("1.0.0"), { switchSource: false });
    await expect(installer.install(resolved("1.0.0", { sourceId: "other" }), { switchSource: false })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
    await expect(installer.install(resolved("1.0.0", { sourceId: "other" }), { switchSource: true })).resolves.toEqual({
      action: { action: "switch", fromSource: "acme", from: "1.0.0" },
      connectionWarning: null,
    });
    await expect(installer.installUnbound("notes", { transport: "http", url: "https://notes.example/mcp" })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
  });

  it("keeps the server's config when uninstall cannot rewrite the record", async () => {
    await installer.install(resolved("1.0.0"), { switchSource: false });
    recordWrites.fail = true;
    try {
      await expect(installer.uninstall("notes", { removeData: false })).rejects.toThrow("disk full");
    } finally {
      recordWrites.fail = false;
    }
    expect(manager.configs.get("notes")).toMatchObject({ command: "npx", args: ["-y", "notes-mcp@1.0.0"] });
    expect(await installer.list()).toEqual([{ kind: "mcp", name: "notes", version: "1.0.0", sourceId: "acme", originCommit: SNAPSHOT }]);
  });

  it("installs a pasted server unbound, and uninstall keeps or removes $DATA_DIR as asked", async () => {
    await installer.installUnbound("weather", { transport: "http", url: "https://weather.example/mcp" });
    expect(await installer.list()).toEqual([{ kind: "mcp", name: "weather", version: null, sourceId: null, originCommit: null }]);
    await writeFile(join(home, "mcp-data", "weather", "cache"), "x");
    await expect(installer.uninstall("weather", { removeData: false })).resolves.toEqual({ keptDataDir: join(home, "mcp-data", "weather") });
    expect(manager.configs.has("weather")).toBe(false);
    expect(await installer.list()).toEqual([]);

    await installer.installUnbound("weather", { transport: "http", url: "https://weather.example/mcp" });
    await expect(installer.uninstall("weather", { removeData: true })).resolves.toEqual({ keptDataDir: null });
    await expect(stat(join(home, "mcp-data", "weather"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installer.uninstall("weather", { removeData: true })).rejects.toMatchObject({ code: "PACKAGE_ID_CONFLICT" });
  });

  it("stops on an unreadable record file instead of reading it as empty", async () => {
    await mkdir(join(home, "packages"), { recursive: true });
    await writeFile(recordsPath(), "{ not json");
    await expect(installer.list()).rejects.toThrow();
    await expect(installer.install(resolved("1.0.0"), { switchSource: false })).rejects.toThrow();
    expect(manager.configs.size).toBe(0);
  });
});
