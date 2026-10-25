const path = require("node:path");
const { EsbuildPlugin } = require("esbuild-loader");

const isProduction = process.env.NODE_ENV !== "development";
const rendererMinifier = process.env.AVE_BUILD_MINIFIER ?? "terser";
if (rendererMinifier !== "terser" && rendererMinifier !== "esbuild") {
  throw new Error("AVE_BUILD_MINIFIER must be terser or esbuild");
}
const rootDir = __dirname;
const distSrcDir = path.resolve(rootDir, "dist/src");

const extensions = [".tsx", ".ts", ".jsx", ".js", ".json"];
const extensionAlias = {
  ".js": [".ts", ".tsx", ".js"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

// Transpile-only TS→JS via esbuild (esbuild is already a dep; ts-loader's
// classic-compiler API broke under TypeScript 7's native package). esbuild-loader
// only strips types per-file — module resolution stays with webpack's
// resolve.extensionAlias (the NodeNext `.js`→`.ts` rewrite), matching the prior
// ts-loader transpileOnly + Bundler-resolution behavior. Type checking is the
// separate `tsc --noEmit` gate, not the bundler's job.
const tsRule = {
  test: /\.[cm]?tsx?$/,
  exclude: /node_modules/,
  use: {
    loader: "esbuild-loader",
    options: {
      target: "es2022",
      jsx: "automatic",
    },
  },
};

class DocumentInputPlugin {
  apply(compiler) {
    compiler.hooks.afterCompile.tapPromise("DocumentInputPlugin", async (compilation) => {
      const { assertBundledDocumentInputs } = await import("./scripts/lib/document-consumer-guard.mjs");
      assertBundledDocumentInputs(compilation.fileDependencies);
    });
  }
}

const base = {
  mode: isProduction ? "production" : "development",
  context: rootDir,
  cache: {
    type: "filesystem",
    cacheDirectory: path.resolve(rootDir, ".cache/webpack"),
    version: rendererMinifier,
    buildDependencies: {
      config: [__filename],
      typescript: [path.resolve(rootDir, "tsconfig.json")],
      dependencies: [path.resolve(rootDir, "bun.lock")],
    },
  },
  // A restored checkout can reuse timestamps; validate snapshot contents.
  snapshot: {
    buildDependencies: { timestamp: false, hash: true },
    resolveBuildDependencies: { timestamp: false, hash: true },
    module: { timestamp: false, hash: true },
    contextModule: { timestamp: false, hash: true },
    resolve: { timestamp: false, hash: true },
  },
  module: {
    rules: [tsRule],
  },
  plugins: [new DocumentInputPlugin()],
  resolve: {
    extensions,
    extensionAlias,
  },
  stats: "errors-warnings",
  infrastructureLogging: {
    level: "warn",
  },
};

const renderer = {
  ...base,
  name: "renderer",
  target: ["web", "es2022"],
  entry: {
    renderer: path.resolve(rootDir, "src/renderer.tsx"),
  },
  experiments: {
    outputModule: true,
  },
  output: {
    path: distSrcDir,
    filename: "[name].js",
    chunkFilename: "renderer/chunks/[name].[contenthash:8].js",
    publicPath: "./",
    module: true,
    clean: {
      keep(asset) {
        return asset !== "renderer.js" && !asset.startsWith("renderer/");
      },
    },
  },
  optimization: {
    minimize: isProduction,
    ...(rendererMinifier === "esbuild" ? {
      minimizer: [new EsbuildPlugin({ target: "es2022", format: "esm", legalComments: "inline" })],
    } : {}),
    splitChunks: {
      chunks: "initial",
      cacheGroups: {
        react: {
          test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
          name: "react",
          priority: 20,
          enforce: true,
        },
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: "vendor",
          priority: 10,
          reuseExistingChunk: true,
        },
      },
    },
  },
  performance: {
    maxAssetSize: 3 * 1024 * 1024,
    maxEntrypointSize: 3 * 1024 * 1024,
  },
};

function preloadConfig(name, entry, filename) {
  return {
    ...base,
    name,
    target: "electron-preload",
    entry: {
      [name]: path.resolve(rootDir, entry),
    },
    output: {
      path: distSrcDir,
      filename,
      library: {
        type: "commonjs2",
      },
    },
    externals: {
      electron: "commonjs2 electron",
    },
    optimization: {
      minimize: false,
    },
  };
}

// Every webpack-built preload comes from the one preload table, which also
// says the sandbox each runs in (`src/shared/preload-bundles.ts`): a config
// per id, named by the id, so `--config-name <id>` builds one, and
// `scripts/check-sandboxed-preloads.mjs` reads the same table and this list.
// The MCP-App sandbox-proxy relay is installed via session.registerPreloadScript()
// on each `ave-mcp-app:<hex>` partition (see html-preview-partition.ts). The
// floating dock's preload is bundled rather than hand-written `.cjs` because it
// imports the channel constants (`check-no-inline-channels.mjs`).
const PRELOAD_BUNDLES = require("./src/shared/preload-bundles.json");

module.exports = [
  renderer,
  ...Object.entries(PRELOAD_BUNDLES)
    .filter(([, bundle]) => bundle.build === "webpack")
    .map(([id, bundle]) => preloadConfig(id, bundle.entry, bundle.file)),
];
