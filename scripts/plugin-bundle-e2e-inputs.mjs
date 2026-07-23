#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCKED_SDK = /@ave\/plugin-sdk@github:former_org\/ave-plugin-sdk#([0-9a-f]{7,40})/;

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

function requireCheckout(label, repoRoot, expectedSha) {
  const actual = git(repoRoot, "rev-parse", "HEAD");
  if (actual !== expectedSha) {
    fail(`${label} checkout is ${actual}, expected ${expectedSha}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyPluginBundleE2EInputs({
  hostRoot,
  sdkRoot,
  marketplaceRoot,
  orionApiRoot,
  hostSha,
  sdkSha,
  marketplaceSha,
  orionApiSha,
}) {
  const refs = {
    host: requireFullSha("HOST_SHA", hostSha),
    sdk: requireFullSha("SDK_SHA", sdkSha),
    marketplace: requireFullSha("MARKETPLACE_SHA", marketplaceSha),
    orionApi: requireFullSha("ORION_API_SHA", orionApiSha),
  };

  requireCheckout("Host", hostRoot, refs.host);
  requireCheckout("SDK", sdkRoot, refs.sdk);
  requireCheckout("Marketplace", marketplaceRoot, refs.marketplace);
  requireCheckout("orion-api", orionApiRoot, refs.orionApi);

  const epPackage = readJson(resolve(orionApiRoot, "package.json"));
  const expectedDependency = `github:former_org/ave-plugin-sdk#${refs.sdk}`;
  const runtimeDependency = epPackage.dependencies?.["@ave/plugin-sdk"];
  const buildDependency = epPackage.devDependencies?.["@ave/plugin-sdk"];
  if (runtimeDependency !== undefined && buildDependency !== undefined) {
    fail("orion-api must declare @ave/plugin-sdk in exactly one dependency section");
  }
  const actualDependency = runtimeDependency ?? buildDependency;
  if (actualDependency !== expectedDependency) {
    fail(`orion-api must consume ${expectedDependency}; found ${String(actualDependency)}`);
  }

  const lock = readFileSync(resolve(orionApiRoot, "bun.lock"), "utf8");
  const lockedPrefix = lock.match(LOCKED_SDK)?.[1];
  if (!lockedPrefix) {
    fail("orion-api bun.lock has no resolved @ave/plugin-sdk Git commit");
  }
  const lockedCommit = git(sdkRoot, "rev-parse", `${lockedPrefix}^{commit}`);
  if (lockedCommit !== refs.sdk) {
    fail(`orion-api bun.lock resolves SDK ${lockedCommit}, expected ${refs.sdk}`);
  }

  const schemas = {
    host: readFileSync(resolve(hostRoot, "schemas/plugin-manifest.schema.json")),
    sdk: readFileSync(resolve(sdkRoot, "schemas/plugin-manifest.schema.json")),
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
    sdkDependency: actualDependency,
    sdkLockPrefix: lockedPrefix,
    schemaSha256: schemaDigests.host,
  };
}

function fromEnvironment() {
  const workspaceRoot = resolve(process.env.BUNDLE_E2E_WORKSPACE ?? "..");
  const evidence = verifyPluginBundleE2EInputs({
    hostRoot: resolve(process.env.HOST_ROOT ?? "."),
    sdkRoot: process.env.SDK_ROOT
      ? resolve(process.env.SDK_ROOT)
      : resolve(workspaceRoot, "ave-plugin-sdk"),
    marketplaceRoot: process.env.MARKETPLACE_ROOT
      ? resolve(process.env.MARKETPLACE_ROOT)
      : resolve(workspaceRoot, "agent-marketplace"),
    orionApiRoot: process.env.ORION_API_ROOT
      ? resolve(process.env.ORION_API_ROOT)
      : resolve(workspaceRoot, "ave-plugin-orion-api"),
    hostSha: process.env.HOST_SHA,
    sdkSha: process.env.SDK_SHA,
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
