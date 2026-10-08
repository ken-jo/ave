/** Bundle app marketplace sources without the host logger's worker transport. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const [app, entry] = process.argv.slice(-2);
if (!app || !entry) throw new Error("usage: bundle-app-marketplace.mjs <app checkout> <entry>");

const appRoot = realpathSync(app);
const loggerImport = resolve(appRoot, "src/lib/logger.js");
let stubbed = 0;
const result = await Bun.build({
  entrypoints: [resolve(appRoot, entry)],
  root: appRoot,
  target: "node",
  format: "esm",
  plugins: [{
    name: "marketplace-check-unused-host-logger",
    setup(build) {
      build.onResolve({ filter: /\/lib\/logger\.js$/u }, (args) => {
        if (resolve(args.resolveDir, args.path) !== loggerImport) return;
        stubbed += 1;
        return { path: "unused-host-logger", namespace: "marketplace-check" };
      });
      build.onLoad({ filter: /.*/u, namespace: "marketplace-check" }, () => ({
        loader: "js",
        contents: `const silent = () => {};
const logger = { debug: silent, info: silent, warn: silent, error: silent, trace: silent, fatal: silent, child: () => logger };
export function createLogger() { return logger; }`,
      }));
    },
  }],
});
if (!result.success) throw new Error(`checker bundle failed: ${result.logs.map((log) => log.message).join("; ")}`);
if (result.outputs.length !== 1) throw new Error(`checker bundle expected one output, got ${result.outputs.length}`);
process.stdout.write(Buffer.from(await result.outputs[0].arrayBuffer()));
