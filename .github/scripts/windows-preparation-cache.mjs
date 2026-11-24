import { execFileSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  restoreWindowsPreparation, sealWindowsPreparation, verifySealedWindowsPreparation, windowsPreparationInputs, windowsPreparationKey,
} from "../../scripts/lib/windows-preparation-cache.mts";

const require = createRequire(import.meta.url);
const { TARGETS, assertSrtWinReceiptModule, assertSrtWinVendor, assertUpstreamSrtWinVendor, srtWinBuildInputDigests } = require("../../scripts/lib/srt-win-integrity.cjs");
const VENDOR = "node_modules/@anthropic-ai/sandbox-runtime/vendor";
const RECEIPTS = "src/permissions/generated/srt-win-build-receipts";
const ARCHES = Object.keys(TARGETS);

function installedSrtInputs(root) {
  const packageId = require("../../src/permissions/srt-win-pins.json").package;
  const resolveFromRoot = createRequire(join(root, "package.json")).resolve;
  const vendor = join(dirname(resolveFromRoot(`${packageId}/package.json`)), "vendor");
  if (vendor !== realpathSync(join(root, VENDOR))) throw new Error("Unexpected installed native helper package");
  return srtWinBuildInputDigests(vendor);
}

function nativeFiles(arch) {
  return [
    ...["ave-job", "ave-job-failure", "ave-job-query-failure"].map(name => `resources/windows-job/${arch}/${name}.exe`),
    `resources/windows-path-kind/${arch}/ave-path-kind.exe`,
    ...ARCHES.flatMap(target => ["upstream-srt-win.exe", "srt-win.exe", "build-receipt.json"]
      .map(name => `${VENDOR}/srt-win/${target}/${name}`)),
    `${RECEIPTS}.js`,
    `${RECEIPTS}.json`,
  ];
}

function compilerIdentity(root, env) {
  if (!env.ImageOS || !env.ImageVersion) throw new Error("Missing Windows runner image identity");
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
  const compiler = JSON.parse(run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-windows-job.ps1", "-ToolchainIdentity", "-Arch", process.arch,
  ]));
  return {
    image: env.ImageOS, imageVersion: env.ImageVersion, arch: process.arch, compiler,
    node: process.version, bun: run("bun.exe", ["--version"]), git: run("git", ["--version"]),
  };
}

function writeOutput(destination, write) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    write(temporary);
    renameSync(temporary, destination);
  }
  finally { rmSync(temporary, { force: true }); }
}

function copyOutput(source, destination) {
  writeOutput(destination, temporary => copyFileSync(source, temporary));
}

async function main(operation, root, env) {
  const { RUNNER_TEMP: temp, GITHUB_OUTPUT: outputs, GITHUB_ENV: environment, AVE_WINDOWS_PREP_KEY: key } = env;
  if (process.platform !== "win32" || !temp || !isAbsolute(temp) || !outputs || !environment) {
    throw new Error("Windows preparation cache requires hosted runner paths");
  }
  const store = join(realpathSync(temp), "windows-preparation-cache");
  if (operation === "key") {
    if (!env.ImageOS || !env.ImageVersion) {
      console.log("Runner image identity unavailable, building preparation outputs");
      return;
    }
    const manifest = await windowsPreparationInputs(root, { ...compilerIdentity(root, env), srtWin: installedSrtInputs(root) });
    writeFileSync(join(temp, "windows-preparation-inputs.json"), JSON.stringify(manifest, null, 2) + "\n");
    appendFileSync(outputs, `key=${windowsPreparationKey(manifest)}\n`);
    return;
  }
  if (key && !/^ave-windows-native-helpers-v2-[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid Windows preparation key");
  const native = nativeFiles(process.arch);
  const pinTest = "ave-path-pin-test.exe";
  const required = [...native, pinTest].map(file => `native/${file}`);
  if (operation === "restore") {
    const exactHit = env.AVE_WINDOWS_PREP_EXACT_HIT === "true";
    const directory = key && exactHit ? mkdtempSync(join(realpathSync(temp), "windows-preparation-use-")) : undefined;
    const verified = await restoreWindowsPreparation(store, key, required, exactHit, {
      verifyInputs: () => installedSrtInputs(root),
      verifyIdentity(directory) {
        const vendor = join(directory, "native", VENDOR);
        const receipts = JSON.parse(readFileSync(join(directory, "native", `${RECEIPTS}.json`), "utf8"));
        assertSrtWinReceiptModule(dirname(join(directory, "native", RECEIPTS)));
        assertSrtWinVendor(vendor, ARCHES, receipts);
        assertUpstreamSrtWinVendor(vendor);
      },
      stage: directory && {
        directory,
        install(readVerified) {
          // Check every buffer before replacing any helper. Installation
          // writes the same bytes without reopening a staged path.
          const outputs = [
            ...native.map(file => [join(root, file), readVerified(`native/${file}`)]),
            [join(tmpdir(), pinTest), readVerified(`native/${pinTest}`)],
          ];
          for (const [destination, bytes] of outputs) writeOutput(destination, temporary => writeFileSync(temporary, bytes));
          const now = new Date();
          for (const file of native.slice(0, 4)) utimesSync(join(root, file), now, now);
        },
      },
    });
    const canSave = key && env.AVE_WINDOWS_PREP_EXACT_HIT !== "true"
      && env.GITHUB_REF === "refs/heads/main" && ["push", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME);
    appendFileSync(environment, `AVE_WINDOWS_PREP_STORE=${verified ? directory : canSave ? store : ""}\nAVE_WINDOWS_PREP_VERIFIED=${verified}\n`);
    console.log(verified ? "Using verified Windows preparation outputs" : "Building Windows preparation outputs");
    return;
  }
  if (!key || env.AVE_WINDOWS_PREP_STORE !== store || env.AVE_WINDOWS_PREP_VERIFIED !== "false") throw new Error("Expected newly built Windows preparation outputs");
  if (operation === "verify-publication") {
    await verifySealedWindowsPreparation(store, key, required, env.AVE_WINDOWS_PREP_SEAL_DIGEST);
    return;
  }
  if (operation !== "seal") throw new Error("Unknown Windows preparation command");
  for (const file of native) copyOutput(join(root, file), join(store, "native", file));
  copyOutput(join(tmpdir(), pinTest), join(store, "native", pinTest));
  const digest = await sealWindowsPreparation(store, key, required);
  appendFileSync(outputs, `digest=${digest}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv[2], process.cwd(), process.env);
}
