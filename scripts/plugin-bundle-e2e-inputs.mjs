#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RETIRED_SDK = /@retiredname\/plugin-sdk|retiredname-plugin-sdk/;
const CONTRACT_FILES = {
  "public-contract.ts": "src/plugins/public-contract.ts",
  "plugin-manifest.schema.json": "schemas/plugin-manifest.schema.json",
};

function fail(message) {
  throw new Error(`[plugin-bundle-e2e-inputs] ${message}`);
}

export function requireFullSha(label, value) {
  if (!FULL_SHA.test(value ?? "")) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function git(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function gitBytes(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, ...args]);
}

function requireCheckout(label, repoRoot, expectedSha) {
  const actual = git(repoRoot, "rev-parse", "HEAD");
  if (actual !== expectedSha) {
    fail(`${label} checkout is ${actual}, expected ${expectedSha}`);
  }
  const dirty = git(
    repoRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  if (dirty) {
    fail(`${label} checkout is dirty: ${dirty.split("\n")[0]}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCommittedEntry(repoRoot, commit, path, modes, type) {
  const entry = gitBytes(repoRoot, "ls-tree", "--full-tree", "-z", commit, "--", path)
    .toString("utf8");
  const match = /^([0-7]{6}) (blob|tree) [0-9a-f]{40}\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== path || match[2] !== type || !modes.includes(match[1])) {
    fail(`orion-api ${path} must be a committed ${type === "tree" ? "directory" : "regular file"}`);
  }
}

function readCommittedFile(repoRoot, commit, path) {
  requireCommittedEntry(repoRoot, commit, path, ["100644", "100755"], "blob");
  return gitBytes(repoRoot, "show", `${commit}:${path}`);
}

function requireReleaseTag(hostRoot, ref) {
  if (typeof ref !== "string" || !ref || ref.includes(":")) {
    fail("orion-api contract ref must be an app release tag in the Host checkout");
  }
  try {
    git(hostRoot, "show-ref", "--verify", "--quiet", `refs/tags/${ref}`);
  } catch {
    fail("orion-api contract ref must be an app release tag in the Host checkout");
  }
}

export function verifyPluginBundleE2EInputs({
  hostRoot,
  marketplaceRoot,
  orionApiRoot,
  hostSha,
  marketplaceSha,
  orionApiSha,
}) {
  const refs = {
    host: requireFullSha("HOST_SHA", hostSha),
    marketplace: requireFullSha("MARKETPLACE_SHA", marketplaceSha),
    orionApi: requireFullSha("ORION_API_SHA", orionApiSha),
  };

  requireCheckout("Host", hostRoot, refs.host);
  requireCheckout("Marketplace", marketplaceRoot, refs.marketplace);
  requireCheckout("orion-api", orionApiRoot, refs.orionApi);

  const epPackage = JSON.parse(readCommittedFile(orionApiRoot, refs.orionApi, "package.json").toString("utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(epPackage[section] ?? {})) {
      if (RETIRED_SDK.test(name) || RETIRED_SDK.test(String(version))) {
        fail(`orion-api ${section} still declares retired SDK dependency ${name}`);
      }
    }
  }
  const lock = readCommittedFile(orionApiRoot, refs.orionApi, "bun.lock").toString("utf8");
  if (RETIRED_SDK.test(lock)) {
    fail("orion-api bun.lock still resolves the retired SDK dependency");
  }

  requireCommittedEntry(orionApiRoot, refs.orionApi, "contract", ["040000"], "tree");
  const sources = JSON.parse(
    readCommittedFile(orionApiRoot, refs.orionApi, "contract/sources.json").toString("utf8"),
  );
  if (sources.repository !== "retiredname-project/retiredname-app") {
    fail("orion-api contract must name retiredname-project/retiredname-app as its source");
  }
  requireReleaseTag(hostRoot, sources.ref);
  const contractDigests = {};
  for (const [name, from] of Object.entries(CONTRACT_FILES)) {
    const entry = sources.files?.[name];
    if (entry?.from !== from || !SHA256.test(entry.sha256 ?? "")) {
      fail(`orion-api contract metadata is invalid for ${name}`);
    }
    const vendoredDigest = sha256(readCommittedFile(orionApiRoot, refs.orionApi, `contract/${name}`));
    if (vendoredDigest !== entry.sha256) {
      fail(`orion-api contract bytes differ from sources.json for ${name}`);
    }
    const taggedDigest = sha256(gitBytes(hostRoot, "show", `refs/tags/${sources.ref}:${from}`));
    if (taggedDigest !== vendoredDigest) {
      fail(`orion-api contract bytes differ from Host ${sources.ref} for ${name}`);
    }
    contractDigests[name] = vendoredDigest;
  }

  const schemas = {
    host: readFileSync(resolve(hostRoot, "schemas/plugin-manifest.schema.json")),
    marketplace: readFileSync(
      resolve(marketplaceRoot, "schemas/host/plugin-manifest.schema.json"),
    ),
  };
  const schemaDigests = Object.fromEntries(
    Object.entries(schemas).map(([name, bytes]) => [name, sha256(bytes)]),
  );
  if (new Set(Object.values(schemaDigests)).size !== 1) {
    fail(`manifest schema digests differ: ${JSON.stringify(schemaDigests)}`);
  }

  return {
    refs,
    contractRef: sources.ref,
    contractSha256: contractDigests,
    schemaSha256: schemaDigests.host,
  };
}

function fromEnvironment() {
  const workspaceRoot = resolve(process.env.BUNDLE_E2E_WORKSPACE ?? "..");
  const evidence = verifyPluginBundleE2EInputs({
    hostRoot: resolve(process.env.HOST_ROOT ?? "."),
    marketplaceRoot: process.env.MARKETPLACE_ROOT
      ? resolve(process.env.MARKETPLACE_ROOT)
      : resolve(workspaceRoot, "retiredname-marketplace"),
    orionApiRoot: process.env.ORION_API_ROOT
      ? resolve(process.env.ORION_API_ROOT)
      : resolve(workspaceRoot, "retiredname-plugin-orion"),
    hostSha: process.env.HOST_SHA,
    marketplaceSha: process.env.MARKETPLACE_SHA,
    orionApiSha: process.env.ORION_API_SHA,
  });
  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.BUNDLE_E2E_EVIDENCE_PATH) {
    writeFileSync(process.env.BUNDLE_E2E_EVIDENCE_PATH, rendered, {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  fromEnvironment();
}
