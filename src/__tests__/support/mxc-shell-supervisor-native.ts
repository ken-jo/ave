import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { MAIN_BUNDLE_EXTERNALS } from "../../../scripts/lib/main-bundle-externals.mjs";
import { mxcShellSupervisorLocation } from "../../permissions/mxc-shell-supervisor-client.js";

export async function buildNativeShellSupervisor() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ss-")));
  const resources = { resourcePath: join(root, "resources"), isPackaged: false };
  const location = mxcShellSupervisorLocation(resources);
  const dispose = () => rmSync(root, { recursive: true, force: true });
  try {
    symlinkSync(resolve("node_modules"), location.nodeModules, "dir");
    await build({
      entryPoints: {
        "mxc-shell-supervisor": resolve("src/permissions/mxc-shell-supervisor.ts"),
        "mxc-shell-supervisor-default-stack": resolve("src/__tests__/support/mxc-shell-supervisor-default-stack.ts"),
      },
      outdir: dirname(location.entry), chunkNames: "chunks/[name]-[hash]",
      bundle: true, format: "esm", splitting: true, preserveSymlinks: true, platform: "node",
      target: ["node22"], legalComments: "none", minifySyntax: true, minifyWhitespace: true,
      minifyIdentifiers: true, keepNames: true, external: MAIN_BUNDLE_EXTERNALS,
      banner: { js: 'import { createRequire as __aveCreateRequire } from "node:module";\nconst require = __aveCreateRequire(import.meta.url);\n' },
    });
    // Same bundle and node modules, without the supervisor's asynchronous call stack setting.
    const defaultStackLocation = { ...location, entry: join(dirname(location.entry), "mxc-shell-supervisor-default-stack.js") };
    return { location, defaultStackLocation, resources, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
