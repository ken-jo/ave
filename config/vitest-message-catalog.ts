import path from "node:path";
import { build } from "esbuild";
import { normalizePath, type Plugin } from "vite";

/** Flatten the pure catalog data, keeping runtime state in the isolated module graph. */
export function messageCatalogPlugin(root: string): Plugin {
  const entries = new Set([
    "src/i18n/messages/generated/index.ts",
    "src/i18n/messages/generated-locales/ko.ts",
  ].map((entry) => normalizePath(path.resolve(root, entry))));

  const fragmentDir = path.resolve(root, "src/i18n/messages/generated");

  return {
    name: "test-message-catalog",
    enforce: "pre",
    async load(file) {
      if (!entries.has(normalizePath(file))) return null;
      // Only the data barrels are bundled: locale loaders, registry state and
      // translation functions still load from source in every test context.
      const result = await build({
        absWorkingDir: root,
        entryPoints: [file],
        // Anchor source maps beside the original module; nothing is written.
        outfile: file.replace(/\.ts$/, ".js"),
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        metafile: true,
        sourcemap: "inline",
      });
      // Refuse a future barrel that reaches runtime state or external modules:
      // bundling those would change module identity and mock boundaries.
      for (const input of Object.keys(result.metafile!.inputs)) {
        const source = path.resolve(root, input);
        if (normalizePath(source) !== normalizePath(file) && path.dirname(source) !== fragmentDir) {
          throw new Error(`catalog bundle contains a non-fragment module: ${input}`);
        }
        this.addWatchFile(source);
      }
      if (Object.values(result.metafile!.outputs).some((output) => output.imports.length > 0)) {
        throw new Error("catalog bundle contains an external import");
      }
      return result.outputFiles[0].text;
    },
  };
}
