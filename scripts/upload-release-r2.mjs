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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingSecrets, planR2Upload } from "./lib/release-channel.mjs";

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

function md5(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("md5");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function awsRunner(env) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const childEnv = {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
  };
  return (args) => {
    const result = spawnSync("aws", ["s3api", ...args, "--endpoint-url", endpoint, "--output", "json"], {
      env: childEnv,
      encoding: "utf8",
    });
    if (result.error) throw new Error(`[upload-release-r2] cannot run the AWS CLI: ${result.error.message}`);
    return result;
  };
}

async function putVersioned(aws, bucket, operation, path) {
  const head = aws(["head-object", "--bucket", bucket, "--key", operation.key]);
  if (head.status === 0) {
    const etag = JSON.parse(head.stdout).ETag?.replaceAll('"', "");
    if (etag !== (await md5(path))) {
      throw new Error(`[upload-release-r2] ${operation.key} already exists with different bytes; a released version is never replaced`);
    }
    console.log(`[upload-release-r2] keep ${operation.key} (identical object already uploaded)`);
    return;
  }
  if (!/\b(?:404|Not Found|NoSuchKey)\b/u.test(head.stderr)) {
    throw new Error(`[upload-release-r2] head-object ${operation.key} failed: ${head.stderr.trim()}`);
  }
  put(aws, bucket, operation, path, ["--if-none-match", "*"]);
}

function put(aws, bucket, operation, path, extra = []) {
  const result = aws([
    "put-object", "--bucket", bucket, "--key", operation.key, "--body", path,
    "--content-type", operation.contentType, "--cache-control", operation.cacheControl, ...extra,
  ]);
  if (result.status !== 0) throw new Error(`[upload-release-r2] put-object ${operation.key} failed: ${result.stderr.trim()}`);
  console.log(`[upload-release-r2] put ${operation.key}`);
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
  const aws = awsRunner(process.env);
  const bucket = process.env.R2_BUCKET.trim();
  for (const operation of plan.operations) {
    if (operation.action === "copy") copy(aws, bucket, operation);
    else if (operation.immutable) await putVersioned(aws, bucket, operation, join(dir, operation.source));
    else put(aws, bucket, operation, join(dir, operation.source));
  }
  console.log(`[upload-release-r2] ${plan.operations.length} objects published; feed ${plan.channel.feedUrl}/latest.yml`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
