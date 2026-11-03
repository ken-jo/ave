import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("build", "install-windows-git.ps1");
const NSH = path.resolve("build", "installer.nsh");
const source = readFileSync(SCRIPT, "utf8");

describe("install-windows-git.ps1 pins", () => {
  it("pins each architecture to an official Git for Windows MinGit asset by size and sha256", () => {
    const tag = /\$Tag = 'v(\d+\.\d+\.\d+)\.windows\.(\d+)'/u.exec(source);
    expect(tag).not.toBeNull();
    expect(source).toContain('$url = "https://github.com/git-for-windows/git/releases/download/$Tag/$($asset.Name)"');
    const assets = [...source.matchAll(/(AMD64|ARM64) = @\{ Name = '([^']+)'; Size = (\d+); Sha256 = '([0-9a-f]{64})' \}/gu)];
    expect(assets.map((m) => [m[1], m[2]])).toEqual([
      ["AMD64", `MinGit-${tag![1]}.${tag![2]}-64-bit.zip`],
      ["ARM64", `MinGit-${tag![1]}.${tag![2]}-arm64.zip`],
    ]);
  });

  it("is run by customInstall with the install dir the app reads git from", () => {
    const nsh = readFileSync(NSH, "utf8");
    expect(nsh).toContain('!define AVE_GIT_INSTALL_SCRIPT "install-windows-git.ps1"');
    expect(nsh).toContain('-File "$PLUGINSDIR\\${AVE_GIT_INSTALL_SCRIPT}" -InstallDir "$INSTDIR" -DownloadDir "$PLUGINSDIR"');
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
    for (const file of options.files ?? ["cmd/git.exe", "mingw64/bin/git-remote-https.exe"]) {
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
    const download = path.join(dir, "download");
    mkdirSync(install);
    mkdirSync(download);
    return { scriptPath, install, download };
  }

  function run({ scriptPath, install, download }: ReturnType<typeof stage>) {
    return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-InstallDir", install, "-DownloadDir", download], { encoding: "utf8", timeout: 60_000 });
  }

  it("places a verified archive at <install>\\git and deletes the download", () => {
    const staged = stage();
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(statSync(path.join(staged.install, "git", "cmd", "git.exe")).isFile()).toBe(true);
    expect(readdirSync(staged.install)).toEqual(["git"]);
    expect(readdirSync(staged.download)).toEqual([]);
  });

  it("refuses an archive whose bytes differ from the pin and places nothing", () => {
    const staged = stage({ pinBytes: Buffer.from("not the archive") });
    mkdirSync(path.join(staged.install, "git", "cmd"), { recursive: true });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(readdirSync(staged.install)).toEqual([]);
    expect(readdirSync(staged.download)).toEqual([]);
  });

  it("refuses a verified archive without the https helper and leaves no partial tree", () => {
    const staged = stage({ files: ["cmd/git.exe"] });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(4);
    expect(existsSync(path.join(staged.install, "git"))).toBe(false);
    expect(readdirSync(staged.install)).toEqual([]);
  });
});
