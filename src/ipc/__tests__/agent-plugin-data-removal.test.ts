/**
 * An agent plugin's data directory is written by its bundled MCP servers and
 * hooks, which may not have exited when the package is uninstalled. Once
 * confined processes may run, the directory is renamed into the namespace's
 * tombstones for the next boot's sweep instead of deleted recursively.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgentPluginData } from "../domains/marketplace-content.js";
import { TOMBSTONE_SUBDIR } from "../../plugins/installed-entry-fs.js";
import { _resetConfinedProcessPhaseForTests, noteConfinedProcessesMayRun } from "../../lib/confined-process-phase.js";

describe("removeAgentPluginData", () => {
  let home: string;
  let previousHome: string | undefined;
  const settings = { deleteSecret: async () => undefined };

  beforeEach(async () => {
    previousHome = process.env.AVE_HOME;
    home = mkdtempSync(join(tmpdir(), "agent-plugin-data-"));
    process.env.AVE_HOME = home;
    await mkdir(join(home, "agent-plugin-data", "notes"), { recursive: true });
    await writeFile(join(home, "agent-plugin-data", "notes", "state"), "kept by a live server");
  });

  afterEach(async () => {
    _resetConfinedProcessPhaseForTests();
    if (previousHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("tombstones the data directory once confined processes may run", async () => {
    noteConfinedProcessesMayRun();

    await removeAgentPluginData(settings as never, "notes", []);

    expect(existsSync(join(home, "agent-plugin-data", "notes"))).toBe(false);
    const tombstones = await readdir(join(home, "agent-plugin-data", TOMBSTONE_SUBDIR));
    expect(tombstones).toHaveLength(1);
    expect(await readFile(join(home, "agent-plugin-data", TOMBSTONE_SUBDIR, tombstones[0]!, "state"), "utf8"))
      .toBe("kept by a live server");
  });

  it("deletes it at once before any confined process can run", async () => {
    await removeAgentPluginData(settings as never, "notes", []);

    expect(existsSync(join(home, "agent-plugin-data", "notes"))).toBe(false);
    expect(existsSync(join(home, "agent-plugin-data", TOMBSTONE_SUBDIR))).toBe(false);
  });
});
