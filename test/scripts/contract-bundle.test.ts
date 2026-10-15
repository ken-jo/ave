import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex as sha256 } from "../../src/marketplace/__tests__/fixtures/package-files.js";

/**
 * The contract bundle a tag publishes under contract/<tag>/:
 * scripts/build-contract-bundle.mjs must reproduce its bytes exactly, and
 * scripts/upload-contract-bundle-r2.mjs must never replace a published object.
 */

const root = process.cwd();
const BUILD = resolve(root, "scripts/build-contract-bundle.mjs");
const UPLOAD = resolve(root, "scripts/upload-contract-bundle-r2.mjs");
const IDENTITY = "https://github.com/ken-jo/ave/.github/workflows/build-installers.yml@refs/tags/v9.9.9";
const PREFIX = "contract/v9.9.9/";
const BUNDLE_FILES = [
  "public-contract.ts",
  "plugin-manifest.schema.json",
  "protocol.schema.json",
  "marketplace-check.js",
  "agent-plugin-components.js",
];
const SIGNATURE = "SHA256SUMS.sigstore.json";

const temporary: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `contract-bundle-${label}-`));
  temporary.push(dir);
  return dir;
}

function build(out: string, extra: string[] = []) {
  // The working tree may hold uncommitted edits during development; the copies
  // still come from HEAD's objects and the bundles from this checkout.
  return spawnSync(process.execPath, [BUILD, "--out", out, "--tag", "v9.9.9", "--allow-dirty", ...extra], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("build-contract-bundle", () => {
  const builds: string[] = [];
  const kept: string[] = [];

  beforeAll(() => {
    for (const label of ["first", "second"]) {
      const out = join(mkdtempSync(join(tmpdir(), `contract-bundle-${label}-`)), "bundle");
      kept.push(resolve(out, ".."));
      const result = build(out);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      builds.push(out);
    }
  }, 180_000);

  afterAll(() => {
    for (const dir of kept) rmSync(dir, { recursive: true, force: true });
  });

  it("produces identical bytes on two runs", () => {
    const [first, second] = builds as [string, string];
    const names = readdirSync(first).sort();
    expect(names).toEqual([...BUNDLE_FILES, "bundle.json", "SHA256SUMS"].sort());
    expect(readdirSync(second).sort()).toEqual(names);
    for (const name of names) expect(readFileSync(join(second, name)).equals(readFileSync(join(first, name))), name).toBe(true);
  });

  it("records every file in bundle.json and SHA256SUMS", () => {
    const out = builds[0] as string;
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const manifest = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8")) as {
      schemaVersion: number;
      app: string;
      tag: string;
      commit: string;
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(Object.keys(manifest)).toEqual(["schemaVersion", "app", "tag", "commit", "files"]);
    expect(manifest).toMatchObject({ schemaVersion: 1, app: "ave", tag: "v9.9.9", commit: head });
    expect(Object.keys(manifest.files)).toEqual(BUNDLE_FILES);
    for (const name of BUNDLE_FILES) {
      const bytes = readFileSync(join(out, name));
      expect(manifest.files[name]).toEqual({ sha256: sha256(bytes), bytes: bytes.length });
    }

    const lines = readFileSync(join(out, "SHA256SUMS"), "utf8").split("\n");
    expect(lines.pop()).toBe("");
    const listed = lines.map((line) => /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line)).map((match) => [match?.[2], match?.[1]]);
    expect(listed.map(([name]) => name)).toEqual([...BUNDLE_FILES, "bundle.json"].sort());
    for (const [name, digest] of listed) expect(sha256(readFileSync(join(out, name as string))), name).toBe(digest);
  });

  it("copies the contract sources byte for byte from the commit", () => {
    const out = builds[0] as string;
    const sources: Record<string, string> = {
      "public-contract.ts": "src/plugins/public-contract.ts",
      "plugin-manifest.schema.json": "schemas/plugin-manifest.schema.json",
      "protocol.schema.json": "schemas/plugin-host-protocol/3/protocol.schema.json",
    };
    for (const [name, path] of Object.entries(sources)) {
      const committed = spawnSync("git", ["show", `HEAD:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).stdout;
      expect(readFileSync(join(out, name)).equals(committed), name).toBe(true);
    }
  });

  it("bundles the checkers without the checkout's absolute path", () => {
    for (const name of ["marketplace-check.js", "agent-plugin-components.js"]) {
      const source = readFileSync(join(builds[0] as string, name), "utf8");
      expect(source).not.toContain(root);
    }
  });

  it("refuses an output directory that is not empty and a tag that is not a plain name", () => {
    const occupied = tempDir("occupied");
    writeFileSync(join(occupied, "stale"), "x");
    const refused = build(occupied);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is not empty");

    const badTag = spawnSync(process.execPath, [BUILD, "--out", join(tempDir("tag"), "out"), "--tag", "../v1", "--allow-dirty"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(badTag.status).toBe(1);
    expect(badTag.stderr).toContain("--tag must be a plain tag name");
  });
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("upload-contract-bundle-r2", () => {
  const secrets = {
    R2_ACCOUNT_ID: "account-id-for-test",
    R2_ACCESS_KEY_ID: "access-key-for-test",
    R2_SECRET_ACCESS_KEY: "secret-for-test",
    R2_BUCKET: "bucket-for-test",
  };

  /** A staged bundle with a small stand-in for every file and a signature. */
  function staged(signature = "signature-ok-1"): string {
    const dir = tempDir("staged");
    const sums: Record<string, string> = {};
    for (const name of BUNDLE_FILES) {
      writeFileSync(join(dir, name), `${name} bytes\n`);
      sums[name] = sha256(readFileSync(join(dir, name)));
    }
    writeFileSync(join(dir, "bundle.json"), "{}\n");
    sums["bundle.json"] = sha256(readFileSync(join(dir, "bundle.json")));
    writeFileSync(join(dir, "SHA256SUMS"), Object.keys(sums).sort().map((name) => `${sums[name]}  ${name}\n`).join(""));
    writeFileSync(join(dir, SIGNATURE), signature);
    return dir;
  }

  /**
   * A stand-in bucket: `aws` stores objects as files under `objects/`, logs
   * each call, and answers head-object with the stored object's md5 ETag.
   * `cosign verify-blob` accepts a signature whose bytes start with
   * "signature-ok" when called with the expected identity and issuer.
   */
  function fakeTools(): { bin: string; objects: string; log: string } {
    const bin = tempDir("bin");
    const objects = join(bin, "objects");
    mkdirSync(objects);
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "aws"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const opt = (name) => args[args.indexOf(name) + 1];
const file = (key) => path.join(${JSON.stringify(objects)}, encodeURIComponent(key));
const op = args[1];
if (op === "head-object") {
  if (!fs.existsSync(file(opt("--key")))) { process.stderr.write("An error occurred (404) when calling the HeadObject operation: Not Found"); process.exit(254); }
  const md5 = crypto.createHash("md5").update(fs.readFileSync(file(opt("--key")))).digest("hex");
  process.stdout.write(JSON.stringify({ ETag: '"' + md5 + '"' }));
} else if (op === "put-object") {
  if (args.includes("--if-none-match") && fs.existsSync(file(opt("--key")))) { process.stderr.write("PreconditionFailed"); process.exit(254); }
  fs.copyFileSync(opt("--body"), file(opt("--key")));
} else if (op === "get-object") {
  fs.copyFileSync(file(opt("--key")), args[args.indexOf("--key") + 2]);
} else if (op === "list-objects-v2") {
  const keys = fs.readdirSync(${JSON.stringify(objects)}).map(decodeURIComponent).filter((key) => key.startsWith(opt("--prefix")));
  process.stdout.write(keys.length ? JSON.stringify({ Contents: keys.map((Key) => ({ Key })) }) : "");
} else if (op === "delete-object") {
  fs.rmSync(file(opt("--key")));
} else process.exit(2);
`);
    writeFileSync(join(bin, "cosign"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const ok = args[0] === "verify-blob"
  && opt("--certificate-identity") === ${JSON.stringify(IDENTITY)}
  && opt("--certificate-oidc-issuer") === "https://token.actions.githubusercontent.com"
  && fs.readFileSync(opt("--bundle"), "utf8").startsWith("signature-ok")
  && fs.existsSync(args[args.length - 1])
  && !Object.keys(process.env).some((name) => name.startsWith("R2_"));
process.exit(ok ? 0 : 1);
`);
    chmodSync(join(bin, "aws"), 0o755);
    chmodSync(join(bin, "cosign"), 0o755);
    return { bin, objects, log };
  }

  function upload(args: string[], tools: { bin: string }) {
    return spawnSync(process.execPath, [UPLOAD, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...secrets, PATH: `${tools.bin}:${process.env.PATH ?? ""}` },
    });
  }
  const keys = (tools: { objects: string }) => readdirSync(tools.objects).map(decodeURIComponent).sort();

  it("uploads the bundle write-once with the signature last, then reads it back", () => {
    const tools = fakeTools();
    const result = upload(["--dir", staged(), "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("secret-for-test");
    const puts = readFileSync(tools.log, "utf8").trim().split("\n").filter((call) => call.startsWith("s3api put-object"));
    expect(puts.map((call) => /--key (\S+)/u.exec(call)?.[1])).toEqual(
      [...BUNDLE_FILES, "bundle.json", "SHA256SUMS", SIGNATURE].map((name) => `${PREFIX}${name}`),
    );
    for (const call of puts) {
      expect(call).toContain("--if-none-match *");
      expect(call).toContain("--cache-control public, max-age=31536000, immutable");
      expect(call).toContain("--endpoint-url https://account-id-for-test.r2.cloudflarestorage.com");
    }
    expect(result.stdout).toContain("read back and verified");
  });

  it("keeps identical objects and a published signature that verifies on a rerun", () => {
    const tools = fakeTools();
    const first = staged("signature-ok-first-run");
    expect(upload(["--dir", first, "--prefix", PREFIX, "--identity", IDENTITY], tools).status).toBe(0);
    const rerun = tempDir("rerun");
    cpSync(first, rerun, { recursive: true });
    writeFileSync(join(rerun, SIGNATURE), "signature-ok-second-run");

    const result = upload(["--dir", rerun, "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`keep ${PREFIX}SHA256SUMS (identical object already uploaded)`);
    expect(result.stdout).toContain(`keep ${PREFIX}${SIGNATURE} (the published signature verifies these SHA256SUMS)`);
    expect(readFileSync(join(tools.objects, encodeURIComponent(`${PREFIX}${SIGNATURE}`)), "utf8")).toBe("signature-ok-first-run");
  });

  it("refuses to replace a published file with different bytes", () => {
    const tools = fakeTools();
    expect(upload(["--dir", staged(), "--prefix", PREFIX, "--identity", IDENTITY], tools).status).toBe(0);
    const changed = staged();
    writeFileSync(join(changed, "marketplace-check.js"), "other bytes\n");
    const sums = readFileSync(join(changed, "SHA256SUMS"), "utf8").replace(
      /^[0-9a-f]{64}(?= {2}marketplace-check\.js$)/mu,
      sha256(Buffer.from("other bytes\n")),
    );
    writeFileSync(join(changed, "SHA256SUMS"), sums);
    const before = keys(tools).map((key) => readFileSync(join(tools.objects, encodeURIComponent(key))).toString("hex"));

    const result = upload(["--dir", changed, "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${PREFIX}marketplace-check.js already exists with different bytes`);
    expect(keys(tools).map((key) => readFileSync(join(tools.objects, encodeURIComponent(key))).toString("hex"))).toEqual(before);
  });

  it("refuses a published signature that does not verify", () => {
    const tools = fakeTools();
    const first = staged("forged signature");
    const result = upload(["--dir", first, "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`published ${PREFIX}${SIGNATURE} does not verify SHA256SUMS for ${IDENTITY}`);

    const rerun = upload(["--dir", staged(), "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain(`${PREFIX}${SIGNATURE} already exists and does not verify`);
  });

  it("refuses a staged bundle that does not match its SHA256SUMS", () => {
    const tools = fakeTools();
    const tampered = staged();
    writeFileSync(join(tampered, "public-contract.ts"), "tampered\n");
    const result = upload(["--dir", tampered, "--prefix", PREFIX, "--identity", IDENTITY], tools);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public-contract.ts does not match SHA256SUMS");
    expect(existsSync(tools.log)).toBe(false);

    const extra = staged();
    writeFileSync(join(extra, "notes.txt"), "x");
    expect(upload(["--dir", extra, "--prefix", PREFIX, "--identity", IDENTITY], tools).stderr).toContain("holds");
  });

  it("deletes only a _ci-probe/contract/ prefix", () => {
    const tools = fakeTools();
    const probe = "_ci-probe/contract/123-1/";
    expect(upload(["--dir", staged(), "--prefix", probe, "--identity", IDENTITY], tools).status).toBe(0);
    expect(upload(["--dir", staged(), "--prefix", PREFIX, "--identity", IDENTITY], tools).status).toBe(0);

    const refused = upload(["--delete", "--prefix", PREFIX], tools);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--delete only removes a _ci-probe/contract/<id>/ prefix");

    const deleted = upload(["--delete", "--prefix", probe], tools);
    expect(deleted.stderr).toBe("");
    expect(deleted.status).toBe(0);
    expect(keys(tools).every((key) => key.startsWith(PREFIX))).toBe(true);
    expect(keys(tools)).toHaveLength(BUNDLE_FILES.length + 3);
  });

  it("refuses a prefix outside contract/<tag>/ and _ci-probe/contract/", () => {
    const tools = fakeTools();
    for (const prefix of ["releases/", "contract/latest/", "contract/v1.0.0", "_ci-probe/other/"]) {
      const result = upload(["--dir", staged(), "--prefix", prefix, "--identity", IDENTITY], tools);
      expect(result.status, prefix).toBe(1);
      expect(result.stderr).toContain("--prefix must be");
    }
  });
});
