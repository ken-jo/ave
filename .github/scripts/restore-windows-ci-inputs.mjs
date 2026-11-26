// Artifacts come from the same workflow run and contain the prebuilt helpers
// from this checkout. Normalize their times for the local stale-build check.
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsJobLauncherPath } from "../../scripts/prepare-windows-job.mjs";

const { RUNNER_TEMP: temp, GITHUB_ENV: env } = process.env;
if (!temp || !env) throw new Error("Windows artifact restore requires runner paths");
const { TARGETS } = createRequire(import.meta.url)("../../scripts/lib/srt-win-integrity.cjs");
const vendor = "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win";
const launchers = [windowsJobLauncherPath(), ...["ave-path-kind.exe", "ave-path-kind-hold-fixture.exe"].map(file => join("resources", "windows-path-kind", process.arch, file))];
const helpers = [
  ...launchers,
  ...Object.keys(TARGETS).flatMap(arch => ["upstream-srt-win.exe", "srt-win.exe", "build-receipt.json"]
    .map(file => join(vendor, arch, file))),
  ...["js", "json"].map(extension => `src/permissions/generated/srt-win-build-receipts.${extension}`),
];
for (const file of helpers) {
  const source = join(".windows-native-inputs", file);
  const stat = statSync(source);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid native helper artifact: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  // Replacing files breaks hardlinks to the package-manager archive cache.
  renameSync(source, file);
}
const now = new Date();
for (const file of launchers) utimesSync(file, now, now);
const mirror = join(temp, "python-release-mirror");
if (!readdirSync(mirror, { withFileTypes: true, recursive: true }).some(file => file.isFile() && file.name.endsWith(".tar.gz"))) {
  throw new Error("Managed interpreter archive is missing");
}
appendFileSync(env, `AVE_PYTHON_DOWNLOAD_MIRROR=${pathToFileURL(mirror).href}\n`);
