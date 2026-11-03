import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstallerGit } from "../../src/marketplace/git/installer-git.js";

const SCRIPT = path.resolve("build", "install-windows-git.ps1");
const NSH = path.resolve("build", "installer.nsh");
const source = readFileSync(SCRIPT, "utf8");
const ASSETS = [...source.matchAll(/(AMD64|ARM64) = @\{ Name = '([^']+)'; Size = (\d+); Sha256 = '([0-9a-f]{64})'; Prefix = '([a-z0-9]+)' \}/gu)]
  .map((m) => ({ arch: m[1]!, name: m[2]!, prefix: m[5]! }));
/** The pinned archive's real top level for this machine (x64 MinGit has ucrt64\, arm64 has clangarm64\; neither has mingw64\). */
const NATIVE = ASSETS.find((asset) => asset.arch === (process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE));

describe("install-windows-git.ps1 pins", () => {
  it("pins each architecture to an official Git for Windows MinGit asset by size and sha256", () => {
    const tag = /\$Tag = 'v(\d+\.\d+\.\d+)\.windows\.(\d+)'/u.exec(source);
    expect(tag).not.toBeNull();
    expect(source).toContain('$url = "https://github.com/git-for-windows/git/releases/download/$Tag/$($asset.Name)"');
    expect(ASSETS.map((asset) => [asset.arch, asset.name, asset.prefix])).toEqual([
      ["AMD64", `MinGit-${tag![1]}.${tag![2]}-64-bit.zip`, "ucrt64"],
      ["ARM64", `MinGit-${tag![1]}.${tag![2]}-arm64.zip`, "clangarm64"],
    ]);
  });

  it("is run by customInstall with the install dir the app reads git from", () => {
    const nsh = readFileSync(NSH, "utf8");
    expect(nsh).toContain('!define AVE_GIT_INSTALL_SCRIPT "install-windows-git.ps1"');
    expect(nsh).toContain('-File "$PLUGINSDIR\\${AVE_GIT_INSTALL_SCRIPT}" -InstallDir "$INSTDIR" -DownloadDir "$INSTDIR"');
    const customInstall = nsh.slice(nsh.indexOf("!macro customInstall"), nsh.indexOf("!macroend", nsh.indexOf("!macro customInstall")));
    expect(customInstall).toContain("Call aveInstallMarketplaceGit");
  });
});

describe.runIf(process.platform === "win32")("install-windows-git.ps1 on Windows", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ave-install-git-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A MinGit-shaped zip, and a copy of the script that fetches it from disk with pins of `pinBytes` (the zip itself by default). */
  function stage(options: { pinBytes?: Buffer; files?: string[] } = {}) {
    const tree = path.join(dir, "tree");
    const prefix = NATIVE!.prefix;
    for (const file of options.files ?? ["cmd/git.exe", `${prefix}/bin/git-remote-https.exe`, `${prefix}/libexec/git-core/git-upload-pack.exe`, "usr/bin/ssh.exe"]) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      writeFileSync(path.join(tree, file), "stub");
    }
    const zip = path.join(dir, "asset.zip");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${tree}', '${zip}')`]);
    const pinned = options.pinBytes ?? readFileSync(zip);
    const script = source
      .replace(/\$url = "[^"]+"/u, `$url = '${pathToFileURL(zip).href}'`)
      .replace(/Size = \d+; Sha256 = '[0-9a-f]{64}'/gu, `Size = ${pinned.length}; Sha256 = '${createHash("sha256").update(pinned).digest("hex")}'`);
    const scriptPath = path.join(dir, "install-windows-git.ps1");
    writeFileSync(scriptPath, script);
    const install = path.join(dir, "install");
    mkdirSync(install);
    return { scriptPath, install };
  }

  // customInstall downloads into $INSTDIR itself, which only an administrator can write.
  function run({ scriptPath, install }: ReturnType<typeof stage>) {
    return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-InstallDir", install, "-DownloadDir", install], { encoding: "utf8", timeout: 60_000 });
  }

  it("places a verified archive at <install>\\git and deletes the download", () => {
    const staged = stage();
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const root = path.join(staged.install, "git");
    expect(statSync(path.join(root, "cmd", "git.exe")).isFile()).toBe(true);
    expect(readdirSync(staged.install)).toEqual(["git"]);
    // The layout the app reads must match what the script placed.
    expect(findInstallerGit(root)).toEqual({ path: path.join(root, "cmd", "git.exe"), root, prefix: NATIVE!.prefix });
  });

  it("refuses an archive whose bytes differ from the pin and places nothing", () => {
    const staged = stage({ pinBytes: Buffer.from("not the archive") });
    mkdirSync(path.join(staged.install, "git", "cmd"), { recursive: true });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(readdirSync(staged.install)).toEqual([]);
  });

  it("refuses a verified archive laid out under mingw64 and leaves no partial tree", () => {
    const staged = stage({ files: ["cmd/git.exe", "mingw64/bin/git-remote-https.exe", "mingw64/libexec/git-core/git-upload-pack.exe"] });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(4);
    expect(existsSync(path.join(staged.install, "git"))).toBe(false);
    expect(readdirSync(staged.install)).toEqual([]);
  });
});
