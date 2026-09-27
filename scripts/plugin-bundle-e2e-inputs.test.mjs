import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitFixtureEnv } from "../src/__tests__/support/git-fixture-env.mjs";
import {
  requireFullSha,
  verifyPluginBundleE2EInputs,
} from "./plugin-bundle-e2e-inputs.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitFixtureEnv(root) }).trim();
}

function makeRepo(root, files) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Bundle E2E Test");
  git(root, "config", "user.email", "bundle-e2e@example.invalid");
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, body);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function commitFixtureChange(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function writeSources(orionApiRoot, sources) {
  writeFileSync(join(orionApiRoot, "contract/sources.json"), `${JSON.stringify(sources)}\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bundle-e2e-inputs-"));
  const schema = '{"type":"object"}\n';
  const publicContract = 'export const CONTRACT = "fixture";\n';
  const hostRoot = join(root, "ave");
  const marketplaceRoot = join(root, "agent-marketplace");
  const orionApiRoot = join(root, "ave-plugin-orion");
  const hostSha = makeRepo(hostRoot, {
    "src/plugins/public-contract.ts": publicContract,
    "schemas/plugin-manifest.schema.json": schema,
  });
  git(hostRoot, "tag", "v0.1.0");
  const marketplaceSha = makeRepo(marketplaceRoot, {
    "schemas/host/plugin-manifest.schema.json": schema,
  });
  const sources = {
    repository: "former_org/ave",
    ref: "v0.1.0",
    files: {
      "public-contract.ts": {
        from: "src/plugins/public-contract.ts",
        sha256: sha256(publicContract),
      },
      "plugin-manifest.schema.json": {
        from: "schemas/plugin-manifest.schema.json",
        sha256: sha256(schema),
      },
    },
  };
  const orionApiSha = makeRepo(orionApiRoot, {
    "package.json": '{"name":"orion-api"}\n',
    "bun.lock": '{}\n',
    "contract/public-contract.ts": publicContract,
    "contract/plugin-manifest.schema.json": schema,
    "contract/sources.json": `${JSON.stringify(sources)}\n`,
  });
  return { root, hostRoot, marketplaceRoot, orionApiRoot, hostSha, marketplaceSha, orionApiSha, sources };
}

test("rejects mutable or abbreviated workflow refs", () => {
  assert.throws(() => requireFullSha("HOST_SHA", "main"), /40-character/);
  assert.throws(() => requireFullSha("HOST_SHA", "a".repeat(39)), /40-character/);
});

test("proves checkout, vendored contract provenance, and schema identity", () => {
  const f = fixture();
  const evidence = verifyPluginBundleE2EInputs(f);
  assert.equal(evidence.contractRef, "v0.1.0");
  assert.equal(evidence.contractSha256["public-contract.ts"], f.sources.files["public-contract.ts"].sha256);
  assert.equal(evidence.contractSha256["plugin-manifest.schema.json"], f.sources.files["plugin-manifest.schema.json"].sha256);
  assert.match(evidence.schemaSha256, /^[0-9a-f]{64}$/);
});

test("rejects dirty tracked, untracked, and submodule-visible checkout state", () => {
  const f = fixture();
  writeFileSync(join(f.hostRoot, "untracked.txt"), "not exact\n");
  assert.throws(
    () => verifyPluginBundleE2EInputs(f),
    /Host checkout is dirty/,
  );
});

test("rejects a dirty initialized submodule", () => {
  const f = fixture();
  const submoduleRoot = `${f.hostRoot}-submodule-source`;
  makeRepo(submoduleRoot, { "tracked.txt": "clean\n" });
  git(
    f.hostRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    submoduleRoot,
    "vendor/fixture",
  );
  f.hostSha = commitFixtureChange(f.hostRoot, "add fixture submodule");
  writeFileSync(join(f.hostRoot, "vendor/fixture/tracked.txt"), "dirty\n");

  assert.throws(
    () => verifyPluginBundleE2EInputs(f),
    /Host checkout is dirty/,
  );
});

test("CLI honors explicit checkout roots without appending repository names", () => {
  const f = fixture();
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./plugin-bundle-e2e-inputs.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOST_ROOT: f.hostRoot,
        MARKETPLACE_ROOT: f.marketplaceRoot,
        ORION_API_ROOT: f.orionApiRoot,
        HOST_SHA: f.hostSha,
        MARKETPLACE_SHA: f.marketplaceSha,
        ORION_API_SHA: f.orionApiSha,
        // The workflow itself writes consolidated evidence. This child test
        // proves stdout mode and must not inherit the parent's evidence sink.
        BUNDLE_E2E_EVIDENCE_PATH: "",
      },
    },
  );
  assert.equal(JSON.parse(output).refs.orionApi, f.orionApiSha);
});

test("CLI defaults to the canonical ave-plugin-orion workspace directory", () => {
  const f = fixture();
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./plugin-bundle-e2e-inputs.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_E2E_WORKSPACE: f.root,
        HOST_ROOT: f.hostRoot,
        MARKETPLACE_ROOT: "",
        ORION_API_ROOT: "",
        HOST_SHA: f.hostSha,
        MARKETPLACE_SHA: f.marketplaceSha,
        ORION_API_SHA: f.orionApiSha,
        BUNDLE_E2E_EVIDENCE_PATH: "",
      },
    },
  );
  assert.equal(JSON.parse(output).refs.orionApi, f.orionApiSha);
});

test("CLI creates a private evidence sink for later lifecycle merges", () => {
  const f = fixture();
  const evidencePath = join(f.hostRoot, "bundle-evidence.json");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./plugin-bundle-e2e-inputs.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOST_ROOT: f.hostRoot,
        MARKETPLACE_ROOT: f.marketplaceRoot,
        ORION_API_ROOT: f.orionApiRoot,
        HOST_SHA: f.hostSha,
        MARKETPLACE_SHA: f.marketplaceSha,
        ORION_API_SHA: f.orionApiSha,
        BUNDLE_E2E_EVIDENCE_PATH: evidencePath,
      },
    },
  );

  assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).refs.orionApi, f.orionApiSha);
  // Windows does not expose POSIX file modes through chmod/stat. The
  // production Marketplace E2E image is Linux, where this guards the
  // private evidence-sink contract.
  if (process.platform !== "win32") {
    assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
  }
});

test("rejects a retired SDK dependency in the package", () => {
  const f = fixture();
  const packagePath = join(f.orionApiRoot, "package.json");
  writeFileSync(packagePath, '{"devDependencies":{"@ave/plugin-sdk":"github:former_org/ave-plugin-sdk#main"}}\n');
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "add retired dependency");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /still declares retired SDK dependency/);
});

test("rejects a retired SDK resolution left in the lockfile", () => {
  const f = fixture();
  writeFileSync(join(f.orionApiRoot, "bun.lock"), '"@ave/plugin-sdk": ["stale"]\n');
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "add stale lock resolution");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /still resolves the retired SDK dependency/);
});

test("rejects a mutable contract ref", () => {
  const f = fixture();
  writeSources(f.orionApiRoot, { ...f.sources, ref: "main" });
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "change contract ref");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /must be an app release tag/);
});

test("rejects a contract from another repository", () => {
  const f = fixture();
  writeSources(f.orionApiRoot, { ...f.sources, repository: "other/host" });
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "change contract repository");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /must name former_org\/ave/);
});

test("rejects changed contract bytes", () => {
  const f = fixture();
  writeFileSync(join(f.orionApiRoot, "contract/public-contract.ts"), "changed\n");
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "change vendored copy");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /bytes differ from sources.json/);
});

test("rejects a contract path that is not a file", () => {
  const f = fixture();
  const path = join(f.orionApiRoot, "contract/public-contract.ts");
  rmSync(path);
  mkdirSync(path);
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "remove vendored file");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /must be a committed regular file/);
});

test("rejects a committed contract directory symlink", () => {
  const f = fixture();
  const contractPath = join(f.orionApiRoot, "contract");
  const outsidePath = join(f.root, "contract-outside");
  renameSync(contractPath, outsidePath);
  symlinkSync(outsidePath, contractPath, "dir");
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "replace contract tree with symlink");
  assert.equal(git(f.orionApiRoot, "status", "--porcelain"), "");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /contract must be a committed directory/);
});

test("rejects a self-consistent copy that differs from the app tag", () => {
  const f = fixture();
  const changed = "changed\n";
  writeFileSync(join(f.orionApiRoot, "contract/public-contract.ts"), changed);
  writeSources(f.orionApiRoot, {
    ...f.sources,
    files: {
      ...f.sources.files,
      "public-contract.ts": { ...f.sources.files["public-contract.ts"], sha256: sha256(changed) },
    },
  });
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "change vendored copy and digest");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /bytes differ from Host v0.1.0/);
});

test("rejects incorrect contract source paths", () => {
  const f = fixture();
  writeSources(f.orionApiRoot, {
    ...f.sources,
    files: {
      ...f.sources.files,
      "public-contract.ts": { ...f.sources.files["public-contract.ts"], from: "src/plugins/types.ts" },
    },
  });
  f.orionApiSha = commitFixtureChange(f.orionApiRoot, "change contract source path");
  assert.throws(() => verifyPluginBundleE2EInputs(f), /metadata is invalid/);
});

test("rejects cross-repository schema drift", () => {
  const f = fixture();
  writeFileSync(
    join(f.marketplaceRoot, "schemas/host/plugin-manifest.schema.json"),
    '{"type":"array"}\n',
  );
  f.marketplaceSha = commitFixtureChange(
    f.marketplaceRoot,
    "change marketplace schema",
  );
  assert.throws(() => verifyPluginBundleE2EInputs(f), /schema digests differ/);
});
