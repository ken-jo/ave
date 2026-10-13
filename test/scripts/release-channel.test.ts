import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEED_FILES,
  IMMUTABLE_CACHE,
  REVALIDATE_CACHE,
  feedReferences,
  latestDownloadUrl,
  missingSecrets,
  planR2Upload,
  releaseChannel,
} from "../../scripts/lib/release-channel.mjs";

/**
 * The R2 release channel: `package.json` `build.publish` is its one source,
 * scripts/upload-release-r2.mjs executes the plan, and the website links the
 * `latest/` aliases the plan creates.
 */

const root = process.cwd();
const SCRIPT = resolve(root, "scripts/upload-release-r2.mjs");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
  build: { productName: string; publish: unknown };
};
const version = packageJson.version;
const prefix = `${packageJson.build.productName}-${version}-`;
const tag = `v${version}`;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const INSTALLERS = [
  "mac-arm64.dmg",
  "mac-arm64.zip",
  "windows-x64-setup.exe",
  "linux-x86_64.AppImage",
  "linux-amd64.deb",
  "linux-x86_64.rpm",
].map((rest) => `${prefix}${rest}`);
const BLOCKMAPS = [`${prefix}mac-arm64.dmg.blockmap`, `${prefix}mac-arm64.zip.blockmap`, `${prefix}windows-x64-setup.exe.blockmap`];

function feed(feedVersion: string, files: string[]): string {
  return [
    `version: ${feedVersion}`,
    "files:",
    ...files.flatMap((file) => [`  - url: ${file}`, "    sha512: AAAA", "    size: 1"]),
    `path: ${files[0]}`,
    "sha512: AAAA",
    "releaseDate: '2026-10-14T00:00:00.000Z'",
    "",
  ].join("\n");
}

const FEEDS: Record<string, string> = {
  "latest-mac.yml": feed(version, [`${prefix}mac-arm64.zip`, `${prefix}mac-arm64.dmg`]),
  "latest.yml": feed(version, [`${prefix}windows-x64-setup.exe`]),
  "latest-linux.yml": feed(version, [`${prefix}linux-x86_64.AppImage`]),
};

function staging(overrides: Record<string, string | null> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "r2-staging-"));
  temporary.push(directory);
  const files: Record<string, string | null> = {
    ...Object.fromEntries([...INSTALLERS, ...BLOCKMAPS].map((name) => [name, `bytes of ${name}`])),
    ...FEEDS,
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(join(directory, name), content);
  }
  return directory;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete base[name];
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: { ...base, ...env } });
}

type Operation = {
  action: "put" | "copy";
  key: string;
  source?: string;
  from?: string;
  contentType: string;
  cacheControl: string;
  contentDisposition?: string;
};

describe("release channel source of truth", () => {
  it("reads one generic R2 feed from package.json build.publish", () => {
    expect(releaseChannel(packageJson)).toEqual({
      feedUrl: "https://downloads.agent-connector.ai/releases",
      origin: "https://downloads.agent-connector.ai",
      feedPrefix: "releases/",
      latestPrefix: "latest/",
    });
  });

  const entry = { provider: "generic", url: "https://downloads.example.invalid/releases", channel: "latest", useMultipleRangeRequest: false };
  it.each([
    ["no publish entry", []],
    ["a GitHub entry", [{ provider: "github", owner: "o", repo: "r" }]],
    ["a second feed", [entry, { provider: "github", owner: "o", repo: "r" }]],
    ["publish as an object", entry],
    ["another channel", [{ ...entry, channel: "beta" }]],
    ["no channel", [{ ...entry, channel: undefined }]],
    ["multiple range requests left on", [{ ...entry, useMultipleRangeRequest: undefined }]],
    ["plain http", [{ ...entry, url: "http://downloads.example.invalid/releases" }]],
    ["a trailing slash", [{ ...entry, url: "https://downloads.example.invalid/releases/" }]],
    ["the origin root", [{ ...entry, url: "https://downloads.example.invalid" }]],
    ["two path segments", [{ ...entry, url: "https://downloads.example.invalid/a/b" }]],
    ["a query", [{ ...entry, url: "https://downloads.example.invalid/releases?x=1" }]],
    ["the alias prefix", [{ ...entry, url: "https://downloads.example.invalid/latest" }]],
  ])("fails closed for %s", (_label, publish) => {
    expect(() => releaseChannel({ build: { publish } })).toThrow("[release-channel]");
  });

  it("links the website's downloads to aliases the upload creates on the same host", () => {
    const channel = releaseChannel(packageJson);
    const downloads = readFileSync(resolve(root, "web/lib/downloads.ts"), "utf8");
    expect(downloads).toContain(`const RELEASE_CHANNEL_ORIGIN = "${channel.origin}";`);
    const linked = [...downloads.matchAll(/href: latest\("([^"]+)"\)/gu)].map((match) => match[1] as string);
    expect(linked).toEqual(["mac-arm64.dmg", "windows-x64-setup.exe", "linux-x86_64.AppImage"]);

    const { operations } = planR2Upload({
      packageJson,
      tag,
      files: [...INSTALLERS, ...BLOCKMAPS, ...FEED_FILES],
      readFeed: (name: string) => FEEDS[name] as string,
    }) as { operations: Operation[] };
    const aliases = new Set(operations.filter((op) => op.action === "copy").map((op) => `${channel.origin}/${op.key}`));
    for (const rest of linked) expect(aliases).toContain(latestDownloadUrl(channel, rest));
  });

  it("reads the version and every file an electron-builder feed names", () => {
    expect(feedReferences(FEEDS["latest-mac.yml"] as string)).toEqual({
      version,
      files: [`${prefix}mac-arm64.dmg`, `${prefix}mac-arm64.zip`].sort(),
    });
    expect(feedReferences("version: '1.2.3'\npath: \"a b.zip\"\n")).toEqual({ version: "1.2.3", files: ["a b.zip"] });
  });

  it("counts unset and empty secrets as missing", () => {
    expect(missingSecrets({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: " ", R2_BUCKET: "b" })).toEqual([
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]);
  });
});

describe("upload-release-r2 dry run", () => {
  it("plans versioned files first, the latest/ aliases next and the feeds last", () => {
    const result = run(["--dir", staging(), "--tag", tag, "--dry-run"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { feedUrl: string; version: string; operations: Operation[] };
    expect(plan.feedUrl).toBe("https://downloads.agent-connector.ai/releases");
    expect(plan.version).toBe(version);

    const ops = plan.operations;
    expect(ops).toHaveLength(INSTALLERS.length + BLOCKMAPS.length + INSTALLERS.length + FEED_FILES.length);
    const phase = (op: Operation) => (op.action === "copy" ? 1 : op.key.endsWith(".yml") ? 2 : 0);
    expect(ops.map(phase)).toEqual([...ops.map(phase)].sort());
    expect(ops.slice(-3).map((op) => op.key)).toEqual(FEED_FILES.map((name) => `releases/${name}`));

    const byKey = new Map(ops.map((op) => [op.key, op]));
    expect(byKey.get(`releases/${prefix}mac-arm64.dmg`)).toEqual({
      action: "put",
      source: `${prefix}mac-arm64.dmg`,
      key: `releases/${prefix}mac-arm64.dmg`,
      contentType: "application/x-apple-diskimage",
      cacheControl: IMMUTABLE_CACHE,
      immutable: true,
    });
    expect(byKey.get(`releases/${prefix}mac-arm64.dmg.blockmap`)).toMatchObject({
      contentType: "application/octet-stream",
      cacheControl: IMMUTABLE_CACHE,
    });
    expect(byKey.get("latest/windows-x64-setup.exe")).toEqual({
      action: "copy",
      from: `releases/${prefix}windows-x64-setup.exe`,
      key: "latest/windows-x64-setup.exe",
      contentType: "application/vnd.microsoft.portable-executable",
      cacheControl: REVALIDATE_CACHE,
      contentDisposition: `attachment; filename="${prefix}windows-x64-setup.exe"`,
    });
    expect(byKey.get("releases/latest-linux.yml")).toEqual({
      action: "put",
      source: "latest-linux.yml",
      key: "releases/latest-linux.yml",
      contentType: "application/yaml",
      cacheControl: REVALIDATE_CACHE,
      immutable: false,
    });
    expect(ops.filter((op) => op.key.startsWith("latest/")).map((op) => op.key).sort()).toEqual(
      INSTALLERS.map((name) => `latest/${name.slice(prefix.length)}`).sort(),
    );
  });

  it.each([
    ["a feed naming a file that is not staged", { "latest.yml": feed(version, [`${prefix}windows-x64-setup-missing.exe`]) }, "names files that are not staged"],
    ["a feed for another version", { "latest.yml": feed("0.0.1", [`${prefix}windows-x64-setup.exe`]) }, "is for version"],
    ["a missing feed", { "latest-linux.yml": null }, "staging is missing latest-linux.yml"],
    ["an unversioned installer", { "Ave-mac-arm64.dmg": "x" }, "is not named"],
    ["an unknown file", { "notes.txt": "x" }, "is not an installer, blockmap or feed file"],
    ["an orphan blockmap", { [`${prefix}other.exe.blockmap`]: "x" }, "has no installer beside it"],
  ])("refuses %s", (_label, overrides, message) => {
    const result = run(["--dir", staging(overrides), "--tag", tag, "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("refuses a tag that is not v<package.json version>", () => {
    const result = run(["--dir", staging(), "--tag", "v0.0.1", "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`does not equal v${version}`);
  });
});

describe("upload-release-r2 upload", () => {
  /** A stand-in `aws` on PATH that records each call; `head-object` answers
   *  404 unless an `etag` file sits beside it. */
  function fakeAws(etag?: string): { bin: string; log: string } {
    const bin = mkdtempSync(join(tmpdir(), "r2-fake-aws-"));
    temporary.push(bin);
    const log = join(bin, "calls.log");
    if (etag !== undefined) writeFileSync(join(bin, "etag"), etag);
    const script = [
      "#!/bin/sh",
      'here="$(dirname "$0")"',
      'printf "%s\\n" "$*" >> "$here/calls.log"',
      'if [ "$2" = "head-object" ]; then',
      // S3 returns the ETag quoted: {"ETag": "\"<md5>\""}. printf folds each doubled backslash into one.
      '  if [ -f "$here/etag" ]; then printf \'{"ETag": "\\\\"%s\\\\""}\' "$(cat "$here/etag")"; exit 0; fi',
      '  echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254',
      "fi",
      "exit 0",
      "",
    ].join("\n");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "aws"), script);
    chmodSync(join(bin, "aws"), 0o755);
    return { bin, log };
  }

  const secrets = {
    R2_ACCOUNT_ID: "account-id-for-test",
    R2_ACCESS_KEY_ID: "access-key-for-test",
    R2_SECRET_ACCESS_KEY: "secret-for-test",
    R2_BUCKET: "bucket-for-test",
  };

  it.runIf(process.platform !== "win32")("fails before any request when a secret is missing", () => {
    const aws = fakeAws();
    const result = run(["--dir", staging(), "--tag", tag], {
      ...secrets,
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: undefined,
      PATH: `${aws.bin}:${process.env.PATH ?? ""}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required secret(s): R2_SECRET_ACCESS_KEY, R2_BUCKET");
    expect(existsSync(aws.log)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("uploads in plan order against the account's R2 endpoint", () => {
    const aws = fakeAws();
    const result = run(["--dir", staging(), "--tag", tag], { ...secrets, PATH: `${aws.bin}:${process.env.PATH ?? ""}` });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("secret-for-test");
    const calls = readFileSync(aws.log, "utf8").trim().split("\n");
    for (const call of calls) {
      expect(call).toContain("--endpoint-url https://account-id-for-test.r2.cloudflarestorage.com");
      expect(call).toContain("--bucket bucket-for-test");
    }
    const writes = calls.filter((call) => !call.includes("head-object"));
    const versionedPuts = writes.filter((call) => call.includes("--if-none-match *"));
    expect(versionedPuts).toHaveLength(INSTALLERS.length + BLOCKMAPS.length);
    const copies = writes.filter((call) => call.startsWith("s3api copy-object"));
    expect(copies).toHaveLength(INSTALLERS.length);
    for (const call of copies) expect(call).toContain("--metadata-directive REPLACE");
    expect(writes.slice(-3).map((call) => /--key (\S+)/u.exec(call)?.[1])).toEqual(
      FEED_FILES.map((name) => `releases/${name}`),
    );
    for (const call of writes.slice(-3)) {
      expect(call).not.toContain("--if-none-match");
      expect(call).toContain(`--cache-control ${REVALIDATE_CACHE}`);
    }
  });

  it.runIf(process.platform !== "win32")("keeps an identical versioned object and refuses a different one", () => {
    const directory = staging();
    // The plan uploads installers in name order; the first one is identical.
    const name = [...INSTALLERS].sort()[0] as string;
    const sameBytes = createHash("md5").update(readFileSync(join(directory, name))).digest("hex");

    // Every versioned object reports this ETag: identical for `name` only.
    const identical = fakeAws(sameBytes);
    const result = run(["--dir", directory, "--tag", tag], { ...secrets, PATH: `${identical.bin}:${process.env.PATH ?? ""}` });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`keep releases/${name} (identical object already uploaded)`);
    expect(result.stderr).toContain("already exists with different bytes");
    // Nothing after the refusal ran: no alias copy and no feed.
    const calls = readFileSync(identical.log, "utf8");
    expect(calls).not.toContain("copy-object");
    expect(calls).not.toContain(".yml");
  });
});
