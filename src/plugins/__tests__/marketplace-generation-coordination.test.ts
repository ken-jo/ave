import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginMarketplaceService } from "../marketplace.js";
import { makeTestPluginPaths } from "./test-helpers.js";

describe("PluginMarketplaceService generation coordination boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })));
  });

  it.each([
    ["git plugin install", (service: PluginMarketplaceService) =>
      (service.installGitPlugin as unknown as (plan: unknown, options: unknown) => Promise<unknown>)(
        { name: "acme" },
        { stage: () => { throw new Error("unexpected stage"); } },
      ),
      "[plugin-generation] git plugin install requires coordinated generation activation"],
    ["local plugin install", (service: PluginMarketplaceService) =>
      (service.installLocal as unknown as (sourcePath: string) => Promise<unknown>)("/unused"),
      "[plugin-generation] local plugin install requires coordinated generation activation"],
  ])("fails closed before %s can touch external or durable state", async (_operation, invoke, expectedError) => {
    const root = mkdtempSync(join(tmpdir(), "ave-generation-coordination-"));
    roots.push(root);
    const pluginsRoot = join(root, "plugins");
    const service = new PluginMarketplaceService(makeTestPluginPaths({ rootDir: root, pluginsRoot }));

    await expect(invoke(service)).rejects.toThrow(expectedError);
    expect(existsSync(pluginsRoot)).toBe(false);
  });
});
