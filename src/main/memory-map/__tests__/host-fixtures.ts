import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureNamespaceHandle } from "../../storage/feature-namespace.js";
import type { MemoryMapCatalog } from "../catalog.js";
import { buildGraph } from "../graph.js";
import type { MemoryWorkerRunner } from "../worker-client-win32.js";

export function createHostFixture(roots: string[]) {
  return async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "memory-host-"));
    roots.push(root);

    const namespace: FeatureNamespaceHandle = {
      dir: root,
      readJson: async (_, fallback) => {
        try {
          return JSON.parse(await readFile(join(root, "snapshot.json"), "utf8"));
        } catch {
          return fallback;
        }
      },
      writeJson: async (name, value) => {
        await writeFile(join(root, name), JSON.stringify(value));
      },
      childDir: async (name) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return path;
      },
      createFile: (name) => open(join(root, name), "wx"),
    };
    const catalog: MemoryMapCatalog = {
      authorizationScopeId: "scope",
      excluded: 0,
      records: [{ memoryId: "id", contentRevision: "hash", title: "Title", text: "Private body", sourceKind: "user" }],
    };
    const runWorker: MemoryWorkerRunner = async <T>(_folder: string, task: Parameters<MemoryWorkerRunner>[1]) => {
      if (task.kind === "embed-batch") return task.texts.map(() => [1, ...Array<number>(383).fill(0)]) as T;
      if (task.kind !== "project") throw new Error("Unexpected task");
      return (await buildGraph(task.input, {
        embed: async () => { throw new Error("Projection requires cached vectors"); },
        dispose: async () => {},
      }, () => {})) as T;
    };
    return { root, namespace, catalog, runWorker };
  };
}
