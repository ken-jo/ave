import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({ markers: [] as string[], opens: [] as string[] }));
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const record = (path: unknown): void => { if (String(path).endsWith(".git")) probes.markers.push(String(path)); };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      probes.opens.push(String(args[0]));
      return actual.openSync(...args);
    },
    statSync: ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => { record(path); return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof actual.statSync,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) => { record(path); return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof actual.lstatSync,
  };
});

import { discoverDirectoryInstructions, discoverProjectAgentsMd } from "../project-agents-md.js";
import { MemoryManager } from "../memory-manager.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";

describe.runIf(process.platform === "win32")("project instructions on a failed home-drive query", () => {
  let root: string;
  let project: string;
  let homeDir: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-agents-locality-")));
    project = join(root, "project");
    mkdirSync(join(project, "sub"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "root");
    writeFileSync(join(project, "sub", "AGENTS.md"), "sub");
    // The home lives on another drive whose query fails.
    const otherDrive = root.toUpperCase().startsWith("C:") ? "Y:" : "C:";
    homeDir = `${otherDrive}\\Users\\alice`;
    setWindowsDriveQueryForTest((drive) => {
      if (drive.toUpperCase().startsWith(otherDrive)) throw new Error("home drive query failed");
      return String.raw`\Device\HarddiskVolume1`;
    });
    probes.markers.length = 0;
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("fails project discovery without probing repository markers", () => {
    expect(() => discoverProjectAgentsMd(project, { homeDir })).toThrow("home drive query failed");
    expect(probes.markers).toEqual([]);
  });

  it("fails directory discovery without probing repository markers", async () => {
    await expect(discoverDirectoryInstructions(project, "sub/file.txt", new Set(), { homeDir })).rejects.toThrow("home drive query failed");
    expect(probes.markers).toEqual([]);
  });

  it("rediscovers warm prompt instructions after an alias moves", () => {
    setWindowsDriveQueryForTest(() => String.raw`\Device\HarddiskVolume1`);
    const other = join(root, "other");
    const alias = join(root, "alias");
    mkdirSync(other);
    writeFileSync(join(other, "AGENTS.md"), "replacement instructions");
    symlinkSync(project, alias, "junction");
    const manager = new MemoryManager({ aveDir: join(root, "profile") });
    expect(manager.getProjectAgentsMd(alias).layers.map((layer) => layer.content)).toContain("root");
    unlinkSync(alias);
    symlinkSync(other, alias, "junction");
    expect(manager.getProjectAgentsMd(alias).layers.map((layer) => layer.content)).toContain("replacement instructions");
  });

  it("refuses warm prompt instructions after a failed drive before any open", () => {
    setWindowsDriveQueryForTest(() => String.raw`\Device\HarddiskVolume1`);
    const manager = new MemoryManager({ aveDir: join(root, "profile") });
    expect(manager.getProjectAgentsMd(project).layers.map((layer) => layer.content)).toContain("root");
    probes.opens.length = 0;
    setWindowsDriveQueryForTest(() => { throw new Error("project drive query failed"); });
    expect(() => manager.getProjectAgentsMd(project)).toThrow("project drive query failed");
    expect(probes.opens).toEqual([]);
  });
});
