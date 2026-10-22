/**
 * Object writes to the Cloudflare R2 release bucket through the AWS CLI
 * against R2's S3-compatible endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
 * with region `auto`. Shared by scripts/upload-release-r2.mjs (installers)
 * and scripts/upload-contract-bundle-r2.mjs (the contract bundle).
 *
 * A write-once object is written with `If-None-Match: *`. One already in the
 * bucket is left alone when its bytes are identical (a re-run) and is a
 * failure when they differ: a published object is never replaced.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function md5(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("md5");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * Returns `run(args)`: one `aws s3api <args>` call with only the R2
 * credentials in its environment. `tag` prefixes error messages.
 */
export function awsRunner(env, tag) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const childEnv = {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
    // Send checksums only where an operation requires them. R2's compat table
    // lists CRC32/CRC32C/SHA as composite-only, and AWS CLI v2.23+ adds a
    // default CRC32 to every single-part put. TLS and the published digests
    // carry integrity here.
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
  };
  return (args) => {
    const result = spawnSync("aws", ["s3api", ...args, "--endpoint-url", endpoint, "--output", "json"], {
      env: childEnv,
      encoding: "utf8",
    });
    if (result.error) throw new Error(`${tag} cannot run the AWS CLI: ${result.error.message}`);
    return result;
  };
}

/** `head-object` answered "no such key" rather than failing. */
function isMissing(head) {
  return head.status !== 0 && /\b(?:404|Not Found|NoSuchKey)\b/u.test(head.stderr);
}

/**
 * The object's state before a write-once put: "absent", "identical" or
 * "different". Any other head-object failure throws.
 */
export async function existingObject(aws, bucket, key, path, tag) {
  const head = aws(["head-object", "--bucket", bucket, "--key", key]);
  if (head.status === 0) {
    const etag = JSON.parse(head.stdout).ETag?.replaceAll('"', "");
    return etag === (await md5(path)) ? "identical" : "different";
  }
  if (isMissing(head)) return "absent";
  throw new Error(`${tag} head-object ${key} failed: ${head.stderr.trim()}`);
}

export function put(aws, bucket, operation, path, tag, extra = []) {
  const result = aws([
    "put-object", "--bucket", bucket, "--key", operation.key, "--body", path,
    "--content-type", operation.contentType, "--cache-control", operation.cacheControl, ...extra,
  ]);
  if (result.status !== 0) throw new Error(`${tag} put-object ${operation.key} failed: ${result.stderr.trim()}`);
  console.log(`${tag} put ${operation.key}`);
}

export async function putVersioned(aws, bucket, operation, path, tag) {
  const state = await existingObject(aws, bucket, operation.key, path, tag);
  if (state === "different") {
    throw new Error(`${tag} ${operation.key} already exists with different bytes; a released version is never replaced`);
  }
  if (state === "identical") {
    console.log(`${tag} keep ${operation.key} (identical object already uploaded)`);
    return;
  }
  put(aws, bucket, operation, path, tag, ["--if-none-match", "*"]);
}
