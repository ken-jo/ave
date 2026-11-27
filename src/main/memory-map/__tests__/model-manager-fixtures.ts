import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureNamespaceHandle } from "../../storage/feature-namespace.js";
import type { LocalModelManager } from "../model-manager.js";
import { LOCAL_MODEL_REVISION } from "../model-manifest.js";

type ModelManagerOptions = ConstructorParameters<typeof LocalModelManager>[0];

export function createModelManagerFixtures<Manager>(
  ModelManager: new (options: ModelManagerOptions) => Manager,
  roots: string[],
) {
  async function fixture(body = "model", namespaceName = "", beforeSave?: () => void) {
    const root = await mkdtemp(join(tmpdir(), "memory-model-"));
    roots.push(root);

    const files = [{ name: "weights.bin", bytes: 5, sha256: createHash("sha256").update("model").digest("hex") }];
    const namespaceDir = join(root, namespaceName);
    let saved: string | undefined;
    const namespace: FeatureNamespaceHandle = {
      dir: namespaceDir,
      readJson: async (_, fallback) => fallback,
      writeJson: async () => {},
      childDir: async (name) => {
        const path = join(namespaceDir, name);
        await mkdir(path, { recursive: true });
        return path;
      },
      createFile: (name) => open(join(namespaceDir, name), "wx"),
    };
    const manager = new ModelManager({
      namespace,
      files,
      readPath: () => saved,
      savePath: (path) => {
        beforeSave?.();
        saved = path;
      },
      downloadFile: async (_, signal) => {
        signal.throwIfAborted();
        return new Response(body);
      },
    });
    return {
      manager,
      root,
      files,
      saved: () => saved,
      setSaved: (path: string) => { saved = path; },
      close: () => rm(root, { recursive: true, force: true }),
    };
  }

  async function linkedFixture(beforeSave?: () => void) {
    const f = await fixture("model", join("via-link", "ave", "models"), beforeSave);
    try {
      const realRoot = join(f.root, "real-root");
      const parent = join(realRoot, "ave", "models", "multilingual-e5-small");
      const canonical = join(parent, LOCAL_MODEL_REVISION);
      await mkdir(canonical, { recursive: true });
      await writeFile(join(canonical, "weights.bin"), "wrong");
      await symlink(realRoot, join(f.root, "via-link"), process.platform === "win32" ? "junction" : "dir");
      const external = join(f.root, "external");
      await mkdir(external);
      await writeFile(join(external, "weights.bin"), "model");
      return { ...f, parent, external };
    } catch (error) {
      await f.close();
      throw error;
    }
  }

  return { fixture, linkedFixture };
}
