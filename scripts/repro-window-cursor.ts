import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveE2eExecutable } from "../test/e2e/ui/background-electron.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowed = new Set(["--foreground", "--no-vibrancy", "--root-css", "--edge-cover", "--child", "--native-inset", "--native-frame", "--help"]);
for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
if (args.includes("--help")) {
  console.log("node --import tsx scripts/repro-window-cursor.ts [--foreground] [--no-vibrancy] [--root-css] [--edge-cover] [--child] [--native-inset] [--native-frame]");
  process.exit(0);
}
if (args.includes("--native-inset") && !args.includes("--child")) throw new Error("Native inset requires --child");
const runtime = mkdtempSync(join(tmpdir(), "ave-window-cursor-"));
try {
  const entry = join(runtime, "main.cjs");
  await build({ entryPoints: [join(root, "test/manual/window-cursor-repro.ts")], outfile: entry,
    bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  const foreground = args.includes("--foreground");
  const executable = foreground ? createRequire(import.meta.url)("electron") as string : resolveE2eExecutable({});
  const child = spawn(executable ?? "", ["--use-mock-keychain", `--user-data-dir=${join(runtime, "profile")}`, entry], {
    stdio: "inherit", env: { ...process.env, AVE_E2E: "1", NODE_ENV: "test",
      AVE_NATIVE_FIXTURE_MODE: foreground ? "foreground" : "background",
      AVE_CURSOR_REPRO_STYLES: join(root, "dist/src/styles.css"),
      AVE_CURSOR_REPRO_CASE: JSON.stringify({ vibrancy: !args.includes("--no-vibrancy"), rootCss: args.includes("--root-css"),
        edgeCover: args.includes("--edge-cover"), host: args.includes("--child") ? "child" : "browser", nativeInset: args.includes("--native-inset") ? 4 : 0,
        nativeFrame: args.includes("--native-frame") }) },
  });
  process.exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolveExit(code ?? 1));
  });
} finally {
  rmSync(runtime, { recursive: true, force: true });
}
