#!/usr/bin/env node
/**
 * Upload a signed contract bundle to the R2 release bucket, or delete a probe.
 *
 *   node scripts/upload-contract-bundle-r2.mjs --dir <bundle> --prefix contract/<tag>/ --identity <san>
 *   node scripts/upload-contract-bundle-r2.mjs --delete --prefix _ci-probe/contract/<id>/
 *
 * `<bundle>` is scripts/build-contract-bundle.mjs output plus
 * `SHA256SUMS.sigstore.json`. Before any request the local files must match
 * `SHA256SUMS` exactly, with no file missing and none extra.
 *
 * Objects are write-once (scripts/lib/r2-objects.mjs): the bundle files go
 * first, `SHA256SUMS` next and the signature last, so a present signature
 * means the whole bundle is present. A rerun of a tag rebuilds identical
 * bytes but signs afresh, so its signature differs from the published one.
 * The published signature is then kept when cosign verifies it against these
 * `SHA256SUMS` with the expected identity (`--identity`, the workflow's
 * certificate SAN, and the GitHub Actions issuer); otherwise the run fails.
 *
 * `--delete` removes every object under a `_ci-probe/` prefix and nothing else.
 * Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE_MANIFEST, BUNDLE_SUMS, CONTRACT_BUILDS, CONTRACT_COPIES } from "./build-contract-bundle.mjs";
import { awsRunner, existingObject, put, putVersioned } from "./lib/r2-objects.mjs";
import { IMMUTABLE_CACHE, missingSecrets } from "./lib/release-channel.mjs";

const TAG = "[upload-contract-bundle-r2]";
export const BUNDLE_SIGNATURE = `${BUNDLE_SUMS}.sigstore.json`;
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const RELEASE_PREFIX = /^contract\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/$/u;
const PROBE_PREFIX = /^_ci-probe\/contract\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/u;

/** Upload order: the bundle files, then the digests, then the signature. */
const UPLOAD_ORDER = [...Object.keys(CONTRACT_COPIES), ...Object.keys(CONTRACT_BUILDS), BUNDLE_MANIFEST, BUNDLE_SUMS];

function contentType(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function parseArgs(argv) {
  const options = { delete: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--delete") options.delete = true;
    else if (arg === "--dir" || arg === "--prefix" || arg === "--identity") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${TAG} ${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`${TAG} unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.prefix === undefined) throw new Error(`${TAG} --prefix is required`);
  if (options.delete) {
    if (!PROBE_PREFIX.test(options.prefix)) throw new Error(`${TAG} --delete only removes a _ci-probe/contract/<id>/ prefix, not ${JSON.stringify(options.prefix)}`);
    return options;
  }
  if (!RELEASE_PREFIX.test(options.prefix) && !PROBE_PREFIX.test(options.prefix)) {
    throw new Error(`${TAG} --prefix must be contract/v<semver>/ or _ci-probe/contract/<id>/, not ${JSON.stringify(options.prefix)}`);
  }
  if (options.dir === undefined) throw new Error(`${TAG} --dir is required`);
  if (options.identity === undefined || !options.identity.startsWith("https://github.com/")) {
    throw new Error(`${TAG} --identity must be the signing workflow's https://github.com/... certificate identity`);
  }
  return options;
}

/** The staged bundle is exactly the files SHA256SUMS lists plus the signature. */
function checkStaged(dir) {
  const sums = new Map();
  for (const line of readFileSync(join(dir, BUNDLE_SUMS), "utf8").split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line);
    if (!match) throw new Error(`${TAG} ${BUNDLE_SUMS} has a malformed line: ${JSON.stringify(line)}`);
    sums.set(match[2], match[1]);
  }
  const expected = [...UPLOAD_ORDER.filter((name) => name !== BUNDLE_SUMS)].sort();
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(expected)) {
    throw new Error(`${TAG} ${BUNDLE_SUMS} lists ${[...sums.keys()].join(", ")}; expected ${expected.join(", ")}`);
  }
  const staged = readdirSync(dir).sort();
  const wanted = [...UPLOAD_ORDER, BUNDLE_SIGNATURE].sort();
  if (JSON.stringify(staged) !== JSON.stringify(wanted)) {
    throw new Error(`${TAG} ${dir} holds ${staged.join(", ")}; expected ${wanted.join(", ")}`);
  }
  for (const [name, digest] of sums) {
    if (createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") !== digest) {
      throw new Error(`${TAG} ${name} does not match ${BUNDLE_SUMS}`);
    }
  }
}

function verifySignature(signature, sumsPath, identity) {
  const result = spawnSync("cosign", [
    "verify-blob", "--bundle", signature,
    "--certificate-identity", identity, "--certificate-oidc-issuer", GITHUB_ACTIONS_ISSUER,
    sumsPath,
  ], {
    encoding: "utf8",
    // cosign fetches the Sigstore trust root; it never needs the R2 credentials.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("R2_"))),
  });
  if (result.error) throw new Error(`${TAG} cannot run cosign: ${result.error.message}`);
  return result.status === 0;
}

async function upload(aws, bucket, options) {
  const dir = resolve(options.dir);
  checkStaged(dir);
  const operation = (name) => ({ key: `${options.prefix}${name}`, contentType: contentType(name), cacheControl: IMMUTABLE_CACHE });
  for (const name of UPLOAD_ORDER) await putVersioned(aws, bucket, operation(name), join(dir, name), TAG);

  const signature = operation(BUNDLE_SIGNATURE);
  const local = join(dir, BUNDLE_SIGNATURE);
  const state = await existingObject(aws, bucket, signature.key, local, TAG);
  if (state === "absent") put(aws, bucket, signature, local, TAG, ["--if-none-match", "*"]);
  else if (state === "identical") console.log(`${TAG} keep ${signature.key} (identical object already uploaded)`);

  // Read the published bundle back: every file must equal the local bytes and
  // the published signature must verify them, whichever run wrote it.
  const scratch = mkdtempSync(join(tmpdir(), "contract-published-"));
  try {
    for (const name of [...UPLOAD_ORDER, BUNDLE_SIGNATURE]) {
      const key = `${options.prefix}${name}`;
      const got = aws(["get-object", "--bucket", bucket, "--key", key, join(scratch, name)]);
      if (got.status !== 0) throw new Error(`${TAG} get-object ${key} failed: ${got.stderr.trim()}`);
      if (name !== BUNDLE_SIGNATURE && !readFileSync(join(scratch, name)).equals(readFileSync(join(dir, name)))) {
        throw new Error(`${TAG} published ${key} differs from the local bundle`);
      }
    }
    if (!verifySignature(join(scratch, BUNDLE_SIGNATURE), join(scratch, BUNDLE_SUMS), options.identity)) {
      throw new Error(state === "different"
        ? `${TAG} ${signature.key} already exists and does not verify ${BUNDLE_SUMS} for ${options.identity}`
        : `${TAG} published ${signature.key} does not verify ${BUNDLE_SUMS} for ${options.identity}`);
    }
    if (state === "different") console.log(`${TAG} keep ${signature.key} (the published signature verifies these ${BUNDLE_SUMS})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${TAG} ${UPLOAD_ORDER.length + 1} objects under ${options.prefix} read back and verified for ${options.identity}`);
}

function listKeys(aws, bucket, prefix) {
  const result = aws(["list-objects-v2", "--bucket", bucket, "--prefix", prefix]);
  if (result.status !== 0) throw new Error(`${TAG} list-objects-v2 ${prefix} failed: ${result.stderr.trim()}`);
  if (result.stdout.trim() === "") return [];
  return (JSON.parse(result.stdout).Contents ?? []).map((entry) => entry.Key);
}

function deleteProbe(aws, bucket, prefix) {
  for (const key of listKeys(aws, bucket, prefix)) {
    if (!key.startsWith(prefix)) throw new Error(`${TAG} listing ${prefix} returned ${key}`);
    const result = aws(["delete-object", "--bucket", bucket, "--key", key]);
    if (result.status !== 0) throw new Error(`${TAG} delete-object ${key} failed: ${result.stderr.trim()}`);
    console.log(`${TAG} deleted ${key}`);
  }
  const left = listKeys(aws, bucket, prefix);
  if (left.length > 0) throw new Error(`${TAG} ${left.length} object(s) still listed under ${prefix}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const missing = missingSecrets(process.env);
  if (missing.length > 0) throw new Error(`${TAG} missing required secret(s): ${missing.join(", ")}`);
  const aws = awsRunner(process.env, TAG);
  const bucket = process.env.R2_BUCKET.trim();
  if (options.delete) deleteProbe(aws, bucket, options.prefix);
  else await upload(aws, bucket, options);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
