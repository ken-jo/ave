#!/usr/bin/env node
/**
 * Production release builder.
 *
 * Steps:
 *   1. Pre-flight security check (signing-env validation)
 *   2. Read + patch-bump version in package.json, and regenerate the host
 *      protocol schema whose `$id` carries it
 *   3. node scripts/build-installers.mjs --current --publish=never
 *
 * Usage:  node scripts/release.mjs [--skip-code-sign]
 *
 * Credentials (signing certs, GH_TOKEN, etc.) must come from the environment
 * — never checked in. See docs/references/production-release-checklist.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runCommand } from "./hooks/spawn-command.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");

const argv = process.argv.slice(2);
const SKIP_CODE_SIGN = argv.includes("--skip-code-sign");
const IS_CI = process.env.CI === "true";

function run(cmd, args, opts = {}) {
  runCommand(cmd, args, { cwd: root, label: "release", ...opts });
}

function bumpPatch(version) {
  const [maj, min, patch] = version.split(".").map((n) => parseInt(n, 10));
  if ([maj, min, patch].some(Number.isNaN)) {
    throw new Error(`Cannot parse version: ${version}`);
  }
  return `${maj}.${min}.${patch + 1}`;
}

/**
 * Validate signing environment. For packaged macOS/Windows builds we
 * need codesign material. --skip-code-sign is an explicit internal-build
 * opt-out. Also verifies package.json build.publish.provider is declared.
 */
function checkSigningEnv(pkg) {
  // Provider check — pkg.build.publish must exist AND have a known provider.
  const publish = pkg?.build?.publish;
  const provider = Array.isArray(publish) ? publish[0]?.provider : publish?.provider;
  const KNOWN_PROVIDERS = new Set(["github", "s3", "generic"]);
  if (!provider || !KNOWN_PROVIDERS.has(provider)) {
    const msg =
      `[release] package.json#build.publish.provider missing or unknown (got ${JSON.stringify(provider)}). ` +
      `Must be one of: ${[...KNOWN_PROVIDERS].join(", ")}.`;
    if (IS_CI) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
  }

  if (SKIP_CODE_SIGN) {
    console.warn("[release] --skip-code-sign — producing unsigned internal build");
    return;
  }

  const missing = [];
  if (process.platform === "darwin") {
    const hasCsc = process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD;
    const hasNotarize =
      process.env.APPLE_ID &&
      (process.env.APPLE_ID_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
      process.env.APPLE_TEAM_ID;
    if (!hasCsc && !hasNotarize) {
      missing.push("macOS: CSC_LINK+CSC_KEY_PASSWORD OR APPLE_ID+APPLE_ID_PASSWORD+APPLE_TEAM_ID");
    }
  } else if (process.platform === "win32") {
    const hasWinCsc =
      (process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD) ||
      (process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);
    if (!hasWinCsc) {
      missing.push("Windows: CSC_LINK+CSC_KEY_PASSWORD OR WIN_CSC_LINK+WIN_CSC_KEY_PASSWORD");
    }
  }

  if (missing.length === 0) return;

  const msg =
    "[release] SECURITY: signing credentials not set. Required:\n  " +
    missing.join("\n  ") +
    "\n  Pass --skip-code-sign to opt out for internal builds.";
  if (IS_CI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Pre-flight security gate (fail CI early before any build work).
  checkSigningEnv(pkg);

  const oldVersion = pkg.version;
  const newVersion = process.env.AVE_RELEASE_VERSION ?? bumpPatch(oldVersion);
  console.log(`[release] version: ${oldVersion} → ${newVersion}`);
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  // The host protocol schema's `$id` carries the app version, and the build
  // below refuses a committed schema that differs from its sources.
  run("bun", ["run", "generate:plugin-host-protocol-schema"]);

  run("node", [
    "scripts/build-installers.mjs",
    "--current",
    "--publish=never",
    ...(SKIP_CODE_SIGN ? ["--skip-code-sign"] : []),
  ]);

  console.log(`[release] done. Artifacts in release/  (version ${newVersion})`);
}

main().catch((err) => {
  console.error("[release] FAILED:", err);
  process.exit(1);
});
