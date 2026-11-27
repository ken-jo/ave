// The holder helper build without a toolchain: stale detection, the exact cargo arguments, the deployment target,
// other platforms, and the package wiring. A real build and the helper's argument checks run on macOS arm64.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTimedFile } from "./fixtures/timed-file.js";
import {
  buildMacosHolderSweep, MACOS_HOLDER_SWEEP_NEVER_SIGNALS, macosHolderSweepCargoArgs, macosHolderSweepOutput, macosHolderSweepToolchain,
} from "../../scripts/build-macos-holder-sweep.mjs";
import { machoImageDigest } from "../../scripts/lib/macho-image-digest.mjs";
import { machoFixture } from "./fixtures/macho-fixture.js";

const roots: string[] = [];
const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-02-01T00:00:00Z");
const SOURCES = ["rust-toolchain.toml", "scripts/build-macos-holder-sweep.mjs", "scripts/lib/macho-image-digest.mjs",
  "native/macos-holder-sweep/Cargo.toml", "native/macos-holder-sweep/Cargo.lock", "native/macos-holder-sweep/src/main.rs"];

const write = writeTimedFile;

function fixtureRoot(built?: Date): string {
  const root = mkdtempSync(join(tmpdir(), "ave-holder-sweep-"));
  roots.push(root);
  write(root, "package.json", OLD, JSON.stringify({ build: { mac: { minimumSystemVersion: "15.0" } } }));
  for (const source of SOURCES) write(root, source, OLD, source === "rust-toolchain.toml" ? '[toolchain]\nchannel = "1.92.0"\nprofile = "minimal"\n' : source);
  if (built) {
    for (const executable of [undefined, MACOS_HOLDER_SWEEP_NEVER_SIGNALS]) {
      const output = macosHolderSweepOutput(root, "arm64", executable);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, machoFixture());
      utimesSync(output, built, built);
    }
  }
  return root;
}

interface Call { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }

// Stands in for cargo: records the call and writes a synthesized helper where cargo would.
function fakeCargo(calls: Call[], code = Buffer.from("code-bytes-0123456789abcdef")) {
  return ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const targetDir = args[args.indexOf("--target-dir") + 1];
    const output = join(targetDir, "aarch64-apple-darwin", "release", "ave-holder-sweep");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, machoFixture({ code: args.includes("fixture") ? Buffer.from("never-signals-variant-0000") : code }));
    return { status: 0, error: undefined };
  }) as never;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("macOS holder helper build", () => {
  it("builds with the pinned toolchain, offline and locked, for arm64 at the app's minimum macOS version", () => {
    const root = fixtureRoot();
    const calls: Call[] = [];
    const build = buildMacosHolderSweep({ root, arch: "arm64", platform: "darwin", log: () => {}, spawn: fakeCargo(calls), env: { PATH: "/usr/bin", HOME: root } });
    expect(calls).toHaveLength(1);
    const [{ command, args, env }] = calls;
    expect(command).toBe("cargo");
    expect(args.slice(0, 6)).toEqual(["build", "--locked", "--offline", "--release", "--target", "aarch64-apple-darwin"]);
    expect(args).toEqual(macosHolderSweepCargoArgs(args[args.indexOf("--manifest-path") + 1], args[args.indexOf("--target-dir") + 1]));
    expect(env.RUSTUP_TOOLCHAIN).toBe("1.92.0");
    expect(env.MACOSX_DEPLOYMENT_TARGET).toBe("15.0");
    expect(env.CARGO_HOME).not.toBe(join(root, ".cargo"));
    expect(String(env.CARGO_ENCODED_RUSTFLAGS).split("\x1f").every((flag) => flag.startsWith("--remap-path-prefix="))).toBe(true);
    const output = readFileSync(macosHolderSweepOutput(root, "arm64"));
    expect(build).toMatchObject({ imageSha256: machoImageDigest(output) });
  });

  it("builds the never-signalling variant only for tests", () => {
    const root = fixtureRoot();
    const calls: Call[] = [];
    buildMacosHolderSweep({ root, arch: "arm64", platform: "darwin", testBuilds: true, log: () => {}, spawn: fakeCargo(calls), env: { PATH: "/usr/bin" } });
    expect(calls.map(({ args }) => args.slice(args.indexOf("--bin") + 2))).toEqual([[], ["--features", "fixture"]]);
    expect(machoImageDigest(readFileSync(macosHolderSweepOutput(root, "arm64", MACOS_HOLDER_SWEEP_NEVER_SIGNALS))))
      .not.toBe(machoImageDigest(readFileSync(macosHolderSweepOutput(root, "arm64"))));
  });

  it("rebuilds a stale or missing helper and keeps a fresh one, reporting its digest either way", () => {
    const fresh = fixtureRoot(NEW);
    const calls: Call[] = [];
    const kept = buildMacosHolderSweep({ root: fresh, arch: "arm64", platform: "darwin", ifStale: true, log: () => {}, spawn: fakeCargo(calls) });
    expect(calls).toHaveLength(0);
    expect(kept?.imageSha256).toBe(machoImageDigest(machoFixture()));
    const stale = fixtureRoot(NEW);
    write(stale, "native/macos-holder-sweep/src/main.rs", new Date("2026-03-01T00:00:00Z"));
    buildMacosHolderSweep({ root: stale, arch: "arm64", platform: "darwin", ifStale: true, log: () => {}, spawn: fakeCargo(calls) });
    expect(calls).toHaveLength(1);
  });

  it("does nothing elsewhere with --if-stale and refuses a plain build there, or another architecture", () => {
    const root = fixtureRoot();
    expect(buildMacosHolderSweep({ root, platform: "linux", ifStale: true })).toBeNull();
    expect(() => buildMacosHolderSweep({ root, platform: "linux" })).toThrow("macOS only");
    expect(() => macosHolderSweepOutput(root, "x64")).toThrow("unsupported");
  });

  it("refuses a toolchain file without an exact channel", () => {
    const root = fixtureRoot();
    write(root, "rust-toolchain.toml", OLD, '[toolchain]\nchannel = "stable"\n');
    expect(() => macosHolderSweepToolchain(root)).toThrow("exact Rust channel");
  });

  it("is wired into the app build, the test preparation, packaging, signing and the ignore list", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(packageJson.scripts.build).toContain("node scripts/build-macos-holder-sweep.mjs --if-stale &&");
    expect(packageJson.scripts["test:prepare"]).toContain("node scripts/build-macos-holder-sweep.mjs --if-stale --test-builds");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own arch macro, as package.json spells it.
    expect(packageJson.build.mac.extraResources).toContainEqual({ from: "resources/macos-holder-sweep/${arch}/ave-holder-sweep", to: "macos-holder-sweep/${arch}/ave-holder-sweep" });
    expect(JSON.stringify(packageJson.build.mac.extraResources)).not.toContain(MACOS_HOLDER_SWEEP_NEVER_SIGNALS);
    expect(readFileSync(resolve(".gitignore"), "utf8").split("\n")).toContain("/resources/macos-holder-sweep/");
    expect(readFileSync(resolve("scripts/build-main-esbuild.mjs"), "utf8")).toContain("__AVE_MACOS_HOLDER_SWEEP_SHA256__");
    expect(readFileSync(resolve(packageJson.build.beforePack), "utf8")).toContain("recordMacosHolderSweepPackageBuild");
    expect(readFileSync(resolve(packageJson.build.afterPack), "utf8")).toContain("assertPackagedMacosHolderSweep");
    expect(readFileSync(resolve(packageJson.build.afterSign), "utf8")).toContain("assertSignedMacosHolderSweep");
    expect(readFileSync(resolve("native/macos-holder-sweep/Cargo.lock"), "utf8").match(/\[\[package\]\]/gu)).toHaveLength(1);
  });

  it.runIf(process.platform === "darwin" && process.arch === "arm64")("refuses bad arguments with 64 and finds nothing on a label no process carries", () => {
    const helper = resolve("resources/macos-holder-sweep/arm64/ave-holder-sweep");
    const run = (...args: string[]) => spawnSync(helper, args, { encoding: "utf8" });
    for (const args of [[], ["sweep", "dev.ave.holder.a"], ["sweep", "com.apple.x", "dev.ave.holder.ctl"],
      ["sweep", "dev.ave.holder.ctl", "dev.ave.holder.ctl"], ["sweep", "dev.ave.holder.UPPER", "dev.ave.holder.ctl"],
      ["list", "dev.ave.holder.a", "dev.ave.holder.ctl"], ["sweep", `dev.ave.holder.${"a".repeat(97)}`, "dev.ave.holder.ctl"]]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).toBe(64);
      expect(result.stdout).toBe("");
    }
    const clean = run("sweep", "dev.ave.holder.test.nobody", "dev.ave.holder.ctl");
    expect(clean.status).toBe(0);
    expect(clean.stdout.trim().split("\n").at(-1)).toBe("result clean signalled=0");
    expect(run("prove", "dev.ave.holder.test.nobody", "dev.ave.holder.ctl").status).toBe(5);
  });
});
