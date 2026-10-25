/** Registry-derived lockfiles drive boot dependency setup before sandbox initialization; paths must stay trusted. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readPluginRegistry, resolveManifestPathsFromRegistry } from "../registry.js";
import { writeTestPluginRegistry } from "./test-helpers.js";
import { resolveTrustedRegistryManifestPath } from "../registry-manifest-trust.js";

let testDir: string;
let pluginsRoot: string;
let registryPath: string;
let outsideDir: string;

async function writeManifestAt(dir: string, id: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "plugin.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ id, name: id, version: "1.0.0", python: { requirementsLock: "attacker.lock" } }),
    "utf-8",
  );
  await writeFile(join(dir, "attacker.lock"), "evil-package==1.0.0\n", "utf-8");
  return manifestPath;
}

async function consumerInput(): Promise<string[]> {
  const registry = await readPluginRegistry(registryPath);
  return resolveManifestPathsFromRegistry(registryPath, registry.plugins);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ave-regtrust-"));
  pluginsRoot = join(testDir, "plugins");
  outsideDir = join(testDir, "outside");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  registryPath = join(pluginsRoot, "registry.json");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("resolveManifestPathsFromRegistry — trust root is enforced before the consumer sees a path", () => {
  it("passes through a legitimate entry under pluginsRoot (positive control)", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    await writeTestPluginRegistry({ registryPath }, [{ id: "good", manifestPath: good }]);

    const paths = await consumerInput();
    expect(paths).toHaveLength(1);
    expect(resolve(paths[0]!)).toBe(resolve(good));
  });

  it("drops an ABSOLUTE entry pointing outside pluginsRoot", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "good", manifestPath: good },
      { id: "evil", manifestPath: evil },
    ]);

    const paths = await consumerInput();
    // An escaping manifest would anchor lockfile discovery outside the plugin root.
    expect(paths.map((p) => resolve(p))).toEqual([resolve(good)]);
    expect(paths.some((p) => p.includes("outside"))).toBe(false);
  });

  it("drops a RELATIVE `../..` traversal entry", async () => {
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    await writeTestPluginRegistry({ registryPath }, [
      { id: "evil", manifestPath: join("..", "outside", "evil", "plugin.json") },
    ]);
    // Ensure traversal reaches the planted manifest so containment is tested against a real escape.
    expect(resolve(pluginsRoot, "..", "outside", "evil", "plugin.json")).toBe(resolve(evil));

    expect(await consumerInput()).toEqual([]);
  });

  it("drops a SYMLINK that is lexically inside the root but links out", async () => {
    const evil = await writeManifestAt(join(outsideDir, "evil"), "evil");
    const linkDir = join(pluginsRoot, "linked");
    try {
      await symlink(join(outsideDir, "evil"), linkDir, "junction");
    } catch {
      return;
    }
    await writeTestPluginRegistry({ registryPath }, [{ id: "linked", manifestPath: join(linkDir, "plugin.json") }]);
    expect(evil).toContain("outside");

    // Lexical containment passes this path; realpath must refuse it.
    expect(await consumerInput()).toEqual([]);
  });

  it("still drops pendingUpdate rows (pre-existing behaviour preserved)", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "good",
        manifestPath: good,
        enabled: true,
        pendingUpdate: {
          kind: "marketplace",
          previousManifestFileSha256: null,
          previousReceiptRaw: null,
        },
      },
    ]);
    expect(await consumerInput()).toEqual([]);
  });
});

describe("resolveTrustedRegistryManifestPath — the authority itself", () => {
  it("does not blanket-trust a relative path the way the old predicate did", async () => {
    await writeManifestAt(join(outsideDir, "evil"), "evil");
    // Relative registry manifest paths must not bypass containment.
    expect(
      resolveTrustedRegistryManifestPath(
        join("..", "outside", "evil", "plugin.json"),
        pluginsRoot,
      ),
    ).toBeNull();
  });

  it("returns the absolute path for a contained relative entry", async () => {
    const good = await writeManifestAt(join(pluginsRoot, "good"), "good");
    const got = resolveTrustedRegistryManifestPath(join("good", "plugin.json"), pluginsRoot);
    expect(got).not.toBeNull();
    expect(resolve(got!)).toBe(resolve(good));
  });

  it("returns null for a non-existent entry (a dangling row is not trustworthy)", () => {
    expect(
      resolveTrustedRegistryManifestPath(join(pluginsRoot, "nope", "plugin.json"), pluginsRoot),
    ).toBeNull();
  });

  it("returns null when the root itself cannot be resolved", () => {
    expect(
      resolveTrustedRegistryManifestPath("plugin.json", join(testDir, "no-such-root")),
    ).toBeNull();
  });
});
