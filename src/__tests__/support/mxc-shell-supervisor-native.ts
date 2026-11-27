import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build, type Plugin } from "esbuild";
import { MAIN_BUNDLE_EXTERNALS } from "../../../scripts/lib/main-bundle-externals.mjs";
import { dropMxcShellStandbys, mxcShellSupervisorLocation } from "../../permissions/mxc-shell-supervisor-client.js";

// Test-only supervisor variants, bundled from source text beside the real entry so no product entry carries a test
// switch. Each imports the real modules by path.
const VARIANTS = {
  // The real supervisor without its asynchronous call stack setting.
  "mxc-shell-supervisor-default-stack": `
    import "./src/main/bare-program-lookup.ts";
    import { runMxcShellSupervisorProcess } from "./src/permissions/mxc-shell-supervisor-service.ts";
    void runMxcShellSupervisorProcess(process.argv.slice(2), null).then(() => process.exit(0), () => process.exit(1));
  `,
  // A fault supervisor: reports ready, records and ignores stop, never sends a receipt. A detached helper inherits
  // its stdout, so the host must settle without waiting for that pipe. Idle, it leaves with its owner.
  "mxc-shell-supervisor-ignore-stop": `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { Socket } from "node:net";
    import { dirname, join } from "node:path";
    import { MxcExtensionChannel } from "./src/permissions/mxc-extension-channel.ts";
    import { readMxcSupervisorKey } from "./src/permissions/mxc-supervisor-transport.ts";
    const generation = process.argv[3];
    const liveness = new Socket({ fd: 3, readable: true, writable: false });
    const control = new Socket({ fd: 4, readable: true, writable: true, allowHalfOpen: true });
    const key = await readMxcSupervisorKey(liveness);
    const channel = new MxcExtensionChannel(control, control, generation, key, "supervisor");
    let staging;
    liveness.once("close", () => { if (staging === undefined) process.exit(0); });
    liveness.resume();
    for await (const frame of channel.frames()) {
      if (frame.type === "shell-start") {
        staging = dirname(frame.requestPath);
        const holder = spawn("/bin/sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
        holder.unref();
        writeFileSync(join(staging, "holder.pid"), String(holder.pid));
        await channel.send({ type: "shell-ready", id: 1 });
      } else if (frame.type === "stop" && staging !== undefined) {
        writeFileSync(join(staging, "stop-received"), String(Date.now()));
      }
    }
    await new Promise(() => {});
  `,
} as const;

const variantEntries: Plugin = {
  name: "ave-supervisor-variants",
  setup(builder) {
    // esbuild filters are Go regular expressions, which take no JavaScript flags.
    builder.onResolve({ filter: /^ave-variant:/ }, args => ({ path: args.path.slice("ave-variant:".length), namespace: "ave-variant" }));
    builder.onLoad({ filter: /.*/, namespace: "ave-variant" }, args => ({
      contents: VARIANTS[args.path as keyof typeof VARIANTS], loader: "ts", resolveDir: resolve("."),
    }));
  },
};

export async function buildNativeShellSupervisor() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ss-")));
  const resources = { resourcePath: join(root, "resources"), isPackaged: false };
  const location = mxcShellSupervisorLocation(resources);
  const dispose = () => {
    // A warm standby belongs to this bundle; stop it before its files go.
    dropMxcShellStandbys();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    symlinkSync(resolve("node_modules"), location.nodeModules, "dir");
    await build({
      entryPoints: {
        "mxc-shell-supervisor": resolve("src/permissions/mxc-shell-supervisor.ts"),
        ...Object.fromEntries(Object.keys(VARIANTS).map(name => [name, `ave-variant:${name}`])),
      },
      plugins: [variantEntries],
      outdir: dirname(location.entry), chunkNames: "chunks/[name]-[hash]",
      bundle: true, format: "esm", splitting: true, preserveSymlinks: true, platform: "node",
      target: ["node22"], legalComments: "none", minifySyntax: true, minifyWhitespace: true,
      minifyIdentifiers: true, keepNames: true, external: [...MAIN_BUNDLE_EXTERNALS],
      banner: { js: 'import { createRequire as __aveCreateRequire } from "node:module";\nconst require = __aveCreateRequire(import.meta.url);\n' },
    });
    // Same bundle and node modules, without the supervisor's asynchronous call stack setting.
    const defaultStackLocation = { ...location, entry: join(dirname(location.entry), "mxc-shell-supervisor-default-stack.js") };
    const ignoreStopLocation = { ...location, entry: join(dirname(location.entry), "mxc-shell-supervisor-ignore-stop.js") };
    return { location, defaultStackLocation, ignoreStopLocation, resources, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
