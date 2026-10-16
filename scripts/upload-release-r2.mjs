#!/usr/bin/env node
/**
 * Upload a tag's installers to the Cloudflare R2 release channel.
 *
 *   node scripts/upload-release-r2.mjs --dir <staging> --tag v<version> [--dry-run]
 *
 * The plan (object keys, order, content types, cache headers) comes from
 * lib/release-channel.mjs and is derived from `package.json` `build.publish`.
 * `--dry-run` prints it as JSON and needs no credentials or network.
 *
 * A real run needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
 * R2_BUCKET, and fails before any request when one is unset or empty. It uses
 * the AWS CLI against R2's S3-compatible endpoint
 * `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with region `auto`.
 *
 * Versioned objects are written with `If-None-Match: *`. A version already in
 * the bucket is left alone when its bytes are identical (a re-run) and is a
 * failure when they differ: a year-long immutable cache entry and the feed's
 * sha512 would otherwise disagree.
 *
 * This file is only an entry point and runs unconditionally.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { awsRunner, put, putVersioned } from "./lib/r2-objects.mjs";
import { missingSecrets, planR2Upload } from "./lib/release-channel.mjs";

const TAG = "[upload-release-r2]";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { dir: undefined, tag: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--dir" || arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`[upload-release-r2] ${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`[upload-release-r2] unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.dir === undefined) throw new Error("[upload-release-r2] --dir is required");
  if (options.tag === undefined) throw new Error("[upload-release-r2] --tag is required");
  return options;
}

function copy(aws, bucket, operation) {
  const result = aws([
    "copy-object", "--bucket", bucket, "--key", operation.key, "--copy-source", `${bucket}/${operation.from}`,
    "--metadata-directive", "REPLACE", "--content-type", operation.contentType,
    "--cache-control", operation.cacheControl, "--content-disposition", operation.contentDisposition,
  ]);
  if (result.status !== 0) throw new Error(`[upload-release-r2] copy-object ${operation.key} failed: ${result.stderr.trim()}`);
  console.log(`[upload-release-r2] copy ${operation.from} -> ${operation.key}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  const files = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const plan = planR2Upload({
    packageJson,
    tag: options.tag,
    files,
    readFeed: (name) => readFileSync(join(dir, name), "utf8"),
  });

  if (options.dryRun) {
    console.log(JSON.stringify({ feedUrl: plan.channel.feedUrl, version: plan.version, operations: plan.operations }, null, 2));
    return;
  }

  const missing = missingSecrets(process.env);
  if (missing.length > 0) {
    throw new Error(`[upload-release-r2] missing required secret(s): ${missing.join(", ")}`);
  }
  const aws = awsRunner(process.env, TAG);
  const bucket = process.env.R2_BUCKET.trim();
  for (const operation of plan.operations) {
    if (operation.action === "copy") copy(aws, bucket, operation);
    else if (operation.immutable) await putVersioned(aws, bucket, operation, join(dir, operation.source), TAG);
    else put(aws, bucket, operation, join(dir, operation.source), TAG);
  }
  console.log(`[upload-release-r2] ${plan.operations.length} objects published; feed ${plan.channel.feedUrl}/latest.yml`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
