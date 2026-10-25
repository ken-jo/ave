/** Bundle test entries through the shipped build boundary; importing another suite would register its tests twice. */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// Use the shipped external dependency boundary.
import { MAIN_BUNDLE_EXTERNALS } from "../../../../scripts/lib/main-bundle-externals.mjs";

export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/** Emit inside the repository for external dependency resolution, with a separate path per suite. */
export function childBundleDir(cacheName: string): string {
  return join(repositoryRoot(), ".cache", cacheName);
}

/** Match shipped bundling, including split chunks; inlining changes dependency interop. */
export async function buildMainBoundaryBundle(options: {
  readonly entryPoints: Record<string, string>;
  readonly outdir: string;
  readonly splitting: boolean;
}): Promise<void> {
  await build({
    absWorkingDir: repositoryRoot(),
    entryPoints: options.entryPoints,
    outdir: options.outdir,
    entryNames: "[name]",
    // Use .mjs so copied entries remain ESM.
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    format: "esm",
    splitting: options.splitting,
    preserveSymlinks: true,
    platform: "node",
    target: ["node22"],
    minifySyntax: true,
    minifyWhitespace: true,
    external: [...MAIN_BUNDLE_EXTERNALS],
    logLevel: "silent",
    banner: {
      js:
        'import { createRequire as __r } from "node:module";\n'
        + "const require = __r(import.meta.url);\n",
    },
  });
}

export async function buildChildEntry(cacheName: string): Promise<string> {
  const outdir = childBundleDir(cacheName);
  await buildMainBoundaryBundle({
    entryPoints: {
      "plugin-child-main": join(repositoryRoot(), "src/plugins/isolation/plugin-child-main.ts"),
    },
    outdir,
    splitting: false,
  });
  return join(outdir, "plugin-child-main.mjs");
}
