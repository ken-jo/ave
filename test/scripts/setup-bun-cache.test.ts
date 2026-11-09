import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(".github/actions/setup-bun/bun-archive.sh");
const asset = "bun-windows-x64";
const payload = "archive fixture";
const pinned = createHash("sha256").update(payload).digest("hex");
let root: string;
let env: NodeJS.ProcessEnv;
let outputs: string;
let versionFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-archive-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", `${asset}.zip`), payload);
  writeFileSync(join(root, "source", "SHASUMS256.txt"), `${pinned}  ${asset}.zip\n`);
  // This command records fetches and serves fixture bytes; hashing is real.
  const curl = join(root, "bin", "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
set -eu
printf 'fetch\\n' >> "$FIXTURE_ROOT/fetches"
printf '%s\\n' "$@" >> "$FIXTURE_ROOT/curl-args"
if [ "\${FIXTURE_HASH_STDIN:-}" = true ]; then
  sha256sum >> "$FIXTURE_ROOT/curl-stdin"
else
  cat >> "$FIXTURE_ROOT/curl-stdin"
fi
if [ "\${FIXTURE_CURL_EXIT:-0}" != 0 ]; then exit "$FIXTURE_CURL_EXIT"; fi
while [ "$1" != --output ]; do shift; done
cp "$FIXTURE_ROOT/source/$(basename "$3")" "$2"
`);
  chmodSync(curl, 0o755);
  versionFile = join(root, "version");
  outputs = join(root, "outputs");
  writeFileSync(versionFile, "1.4.4\n");
  env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_ROOT: root,
    RUNNER_TEMP: root, RUNNER_OS: "Windows", RUNNER_ARCH: "X64", BUN_VERSION_FILE: versionFile,
    GITHUB_OUTPUT: outputs, VERSION: "1.4.4", ASSET: asset, PINNED: pinned, CACHE_HIT: "false",
    GITHUB_TOKEN: "", GH_TOKEN: "" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (mode: string) => spawnSync("bash", [script, mode], { env, encoding: "utf8" });

describe("runtime archive cache", () => {
  it.each([0, 22])("keeps credentials out of xtrace and logs when curl exits %s", (exitCode) => {
    const token = "trace-private-token";
    const unusedToken = "trace-unused-private-token";
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = unusedToken;
    env.FIXTURE_HASH_STDIN = "true";
    env.FIXTURE_CURL_EXIT = String(exitCode);
    const result = spawnSync("bash", ["-x", script, "verify"], { env, encoding: "utf8" });
    expect(result.status).toBe(exitCode);
    expect(result.stderr).toContain(exitCode === 0 ? "+ sha256sum" : "+ exit 22");
    writeFileSync(join(root, "stdout.log"), result.stdout);
    writeFileSync(join(root, "stderr.log"), result.stderr);
    for (const file of ["stdout.log", "stderr.log", "curl-args", "curl-stdin", "fetches"]) {
      const logged = readFileSync(join(root, file), "utf8");
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(unusedToken);
    }
    const requests = exitCode === 0 ? 2 : 1;
    const digest = createHash("sha256").update(`Authorization: Bearer ${token}\n`).digest("hex");
    expect(readFileSync(join(root, "curl-stdin"), "utf8")).toBe(`${digest}  -\n`.repeat(requests));
    const args = readFileSync(join(root, "curl-args"), "utf8").trim().split("\n");
    expect(args.filter((arg) => arg === "--header")).toHaveLength(requests);
    expect(args.filter((arg) => arg === "@-")).toHaveLength(requests);
  });

  it.each([
    ["primary-token", "secondary-token", "primary-token"],
    ["", "secondary-token", "secondary-token"],
    ["", "", ""],
  ])("authenticates release requests with the available token (%s, %s)", (primary, secondary, expected) => {
    env.GITHUB_TOKEN = primary;
    env.GH_TOKEN = secondary;
    const result = run("verify");
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(join(root, "curl-args"), "utf8").trim().split("\n");
    const stdin = readFileSync(join(root, "curl-stdin"), "utf8");
    expect(args.filter((arg) => arg === "--header")).toHaveLength(expected ? 2 : 0);
    expect(args.filter((arg) => arg === "@-")).toHaveLength(expected ? 2 : 0);
    expect(stdin).toBe((expected ? `Authorization: Bearer ${expected}\n` : "\n").repeat(2));
    for (const token of [primary, secondary].filter(Boolean)) expect(args.join("\n")).not.toContain(token);
    expect(args.join("\n")).not.toContain("Authorization:");
    expect(args.filter((arg) => arg.startsWith("https://"))).toEqual([
      `https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${asset}.zip`,
      "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt",
    ]);
    if (expected) expect(result.stdout + result.stderr).not.toContain(expected);
  });

  it("removes authorization when the download redirects to another host", async () => {
    env.GITHUB_TOKEN = "redirect-token";
    expect(run("verify").status).toBe(0);
    const args = readFileSync(join(root, "curl-args"), "utf8").trim().split("\n");
    expect(args).toContain("--location");
    expect(args).not.toContain("--location-trusted");
    expect(args[args.indexOf("--header") + 1]).toBe("@-");
    const header = readFileSync(join(root, "curl-stdin"), "utf8").split("\n")[0];
    const received: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/release") {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing server port");
        response.writeHead(302, { Location: `http://localhost:${address.port}/asset` });
      }
      response.end("archive");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server port");
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn("curl", ["--fail", "--silent", "--show-error", "--location", "--noproxy", "*",
          "--resolve", `localhost:${address.port}:127.0.0.1`, "--max-time", "10", "--header", "@-",
          `http://127.0.0.1:${address.port}/release`], { env: process.env });
        expect(child.spawnargs.join("\n")).not.toContain("redirect-token");
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
        child.stdin.end(`${header}\n`);
      });
      expect(result.code, result.stderr).toBe(0);
      expect(received).toEqual(["Bearer redirect-token", undefined]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ["Linux", "X64", "bun-linux-x64"],
    ["Linux", "ARM64", "bun-linux-aarch64"],
    ["macOS", "X64", "bun-darwin-x64"],
    ["macOS", "ARM64", "bun-darwin-aarch64"],
    ["Windows", "X64", "bun-windows-x64"],
    ["Windows", "ARM64", "bun-windows-aarch64"],
  ])("keys %s %s by version, asset and reviewed digest", (os, arch, expected) => {
    env.RUNNER_OS = os;
    env.RUNNER_ARCH = arch;
    const result = run("metadata");
    expect(result.status, result.stderr).toBe(0);
    const written = Object.fromEntries(readFileSync(outputs, "utf8").trim().split("\n").map((s) => s.split("=")));
    expect(written.asset).toBe(expected);
    expect(written.pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(written.key).toBe(`bun-archive-v1-1.4.4-${written.asset}-${written.pinned}`);
  });
  it.each(["1.4.5", "latest", "1.4.4\ninvalid"])("refuses an unpinned version %s", (version) => {
    writeFileSync(versionFile, version);
    expect(run("metadata").status).not.toBe(0);
  });
  it("refuses an unsupported architecture", () => {
    env.RUNNER_ARCH = "unknown";
    expect(run("metadata").status).not.toBe(0);
  });
  it("refuses an unsupported OS", () => {
    env.RUNNER_OS = "unknown";
    expect(run("metadata").status).not.toBe(0);
  });
  it("fetches both files on a miss and rechecks a hit with no fetches", () => {
    const miss = run("verify");
    expect(miss.status, miss.stderr).toBe(0);
    expect(readFileSync(join(root, "fetches"), "utf8")).toBe("fetch\nfetch\n");
    env.CACHE_HIT = "true";
    rmSync(join(root, "source"), { recursive: true });
    const hit = run("verify");
    expect(hit.status, hit.stderr).toBe(0);
    expect(readFileSync(join(root, "fetches"), "utf8")).toBe("fetch\nfetch\n");
  });
  it.each(["false", "true"])("rejects corrupted archive bytes on cache-hit=%s", (hit) => {
    expect(run("verify").status).toBe(0);
    writeFileSync(join(root, hit === "true" ? "bun-download" : "source", `${asset}.zip`), "corrupt");
    env.CACHE_HIT = hit;
    const result = run("verify");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned");
  });
  it.each(["wrong", "missing", "duplicate"])("rejects %s release checksums on a hit", (kind) => {
    expect(run("verify").status).toBe(0);
    const entry = `${pinned}  ${asset}.zip\n`;
    writeFileSync(join(root, "bun-download", "SHASUMS256.txt"), kind === "wrong" ? entry.replace(pinned, "0".repeat(64)) : kind === "missing" ? "" : entry + entry);
    env.CACHE_HIT = "true";
    expect(run("verify").status).not.toBe(0);
  });
  it("fails when a reported hit lacks its archive instead of fetching", () => {
    env.CACHE_HIT = "true";
    expect(run("verify").status).not.toBe(0);
  });
});

describe("POSIX install step", () => {
  const steps: { name?: string; run?: string }[] = parse(readFileSync(resolve(".github/actions/setup-bun/action.yml"), "utf8")).runs.steps;
  const install = steps.find((step) => step.name === "Install the pinned bun release");
  if (!install?.run) throw new Error("action.yml has no POSIX install step");
  const installRun = install.run;
  const posixAsset = "bun-linux-x64";
  const fixtureBun = "#!/bin/sh\necho fixture-bun\n";

  it.each(["false", "true"])("installs only a verified archive into the job-local home on cache-hit=%s", (hit) => {
    mkdirSync(join(root, "zip", posixAsset), { recursive: true });
    writeFileSync(join(root, "zip", posixAsset, "bun"), fixtureBun);
    const archive = join(root, "source", `${posixAsset}.zip`);
    // The real unzip in the step reads this archive; python's zipfile only builds it.
    const zipped = spawnSync("python3", ["-m", "zipfile", "-c", archive, posixAsset], { cwd: join(root, "zip"), encoding: "utf8" });
    expect(zipped.status, zipped.stderr).toBe(0);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(join(root, "source", "SHASUMS256.txt"), `${digest}  ${posixAsset}.zip\n`);
    Object.assign(env, { ASSET: posixAsset, PINNED: digest, ACTION_PATH: resolve(".github/actions/setup-bun"),
      GITHUB_PATH: join(root, "github-path") });
    if (hit === "true") {
      mkdirSync(join(root, "bun-download"));
      for (const file of [`${posixAsset}.zip`, "SHASUMS256.txt"]) {
        writeFileSync(join(root, "bun-download", file), readFileSync(join(root, "source", file)));
      }
      env.CACHE_HIT = "true";
    }
    const result = spawnSync("bash", ["-c", installRun], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const bin = join(root, "bun-home", ".bun", "bin");
    expect(readFileSync(join(root, "github-path"), "utf8")).toBe(`${bin}\n`);
    for (const tool of ["bun", "bunx"]) {
      expect(readFileSync(join(bin, tool), "utf8")).toBe(fixtureBun);
      expect(statSync(join(bin, tool)).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(root, "fetches"))).toBe(hit !== "true");
  });

  it("installs nothing when a restored archive fails the pin", () => {
    mkdirSync(join(root, "bun-download"));
    writeFileSync(join(root, "bun-download", `${posixAsset}.zip`), "corrupt");
    writeFileSync(join(root, "bun-download", "SHASUMS256.txt"), `${pinned}  ${posixAsset}.zip\n`);
    Object.assign(env, { ASSET: posixAsset, CACHE_HIT: "true", ACTION_PATH: resolve(".github/actions/setup-bun"),
      GITHUB_PATH: join(root, "github-path") });
    const result = spawnSync("bash", ["-c", installRun], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned");
    expect(existsSync(join(root, "bun-home"))).toBe(false);
    expect(existsSync(join(root, "github-path"))).toBe(false);
  });
});
