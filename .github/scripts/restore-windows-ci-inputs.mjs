// Artifacts come from the same workflow run and contain the prebuilt helpers
// from this checkout. The path helper must match the producing build's job
// outputs before it is moved into place. Normalize times for the local
// stale-build check.
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWindowsPathKindArtifactDigests, verifyWindowsPathKindReceipt, windowsPathKindHoldFixturePath, windowsPathKindPath, windowsPathKindReceiptPath } from "../../scripts/lib/windows-path-kind-build.mjs";
import { windowsJobLauncherPath } from "../../scripts/prepare-windows-job.mjs";

const { RUNNER_TEMP: temp, GITHUB_ENV: env } = process.env;
if (!temp || !env) throw new Error("Windows artifact restore requires runner paths");
const { TARGETS } = createRequire(import.meta.url)("../../scripts/lib/srt-win-integrity.cjs");
const vendor = "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win";
const launcher = windowsJobLauncherPath();
const helpers = [
  launcher,
  join(dirname(launcher), "ave-job-query-failure.exe"),
  windowsPathKindPath(process.arch),
  windowsPathKindReceiptPath(process.arch),
  windowsPathKindHoldFixturePath(process.arch),
  ...Object.keys(TARGETS).flatMap(arch => ["upstream-srt-win.exe", "srt-win.exe", "build-receipt.json"]
    .map(file => join(vendor, arch, file))),
  ...["js", "json"].map(extension => `src/permissions/generated/srt-win-build-receipts.${extension}`),
];
assertWindowsPathKindArtifactDigests(".windows-native-inputs", process.arch, {
  binarySha256: process.env.AVE_WINDOWS_PATH_KIND_SHA256,
  receiptSha256: process.env.AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256,
  holdFixtureSha256: process.env.AVE_WINDOWS_PATH_KIND_HOLD_FIXTURE_SHA256,
});
for (const file of helpers) {
  const source = join(".windows-native-inputs", file);
  const stat = statSync(source);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid native helper artifact: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  // Replacing files breaks hardlinks to the package-manager archive cache.
  renameSync(source, file);
}
verifyWindowsPathKindReceipt(process.cwd(), process.arch);
const now = new Date();
utimesSync(launcher, now, now);
const mirror = join(temp, "python-release-mirror");
if (!readdirSync(mirror, { withFileTypes: true, recursive: true }).some(file => file.isFile() && file.name.endsWith(".tar.gz"))) {
  throw new Error("Managed interpreter archive is missing");
}
appendFileSync(env, `AVE_PYTHON_DOWNLOAD_MIRROR=${pathToFileURL(mirror).href}\n`);
