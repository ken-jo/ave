// Write-once uploads use conditional creation; identical reruns pass and differing bytes fail.
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

// Give upload commands only their scoped credentials.
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
    // Request checksums only where required; unsupported default composite checksums break single-part uploads.
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

function isMissing(head) {
  return head.status !== 0 && /\b(?:404|Not Found|NoSuchKey)\b/u.test(head.stderr);
}

// Distinguish absent objects from failed lookups; lookup failures throw.
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
