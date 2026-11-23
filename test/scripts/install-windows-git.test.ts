import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findInstallerGit } from "../../src/shared/host-git-executable.js";

const SCRIPT = path.resolve("build", "install-windows-git.ps1");
const NSH = path.resolve("build", "installer.nsh");
const source = readFileSync(SCRIPT, "utf8");
const ASSETS = [...source.matchAll(/(AMD64|ARM64) = @\{ Name = '([^']+)'; Size = (\d+); Sha256 = '([0-9a-f]{64})'; Prefix = '([a-z0-9]+)' \}/gu)]
  .map((m) => ({ arch: m[1]!, name: m[2]!, prefix: m[5]! }));
const ARCHITECTURE_SOURCE = source.slice(source.indexOf("Add-Type -TypeDefinition @'"), source.indexOf("$asset = $Assets[$arch]"));
const NATIVE_MACHINE_CALL = "[AveGitArchitecture]::NativeMachine()";

function installerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" };
  delete env.PROCESSOR_ARCHITECTURE;
  delete env.PROCESSOR_ARCHITEW6432;
  return env;
}

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

  it("uses explicit redirects for authenticated downloads and retains the anonymous request", () => {
    expect(source).toContain("$request.AllowAutoRedirect = $false");
    expect(source).toContain("if ($Uri.Scheme -ne 'https')");
    expect(source).toContain("$Uri.DnsSafeHost -in @('github.com', 'api.github.com')");
    expect(source).toContain('$request.Headers[\'Authorization\'] = "Bearer $Token"');
    expect(source).toContain("if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }");
    expect(source).toContain("Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600");
  });
});

describe.runIf(process.platform === "win32")("install-windows-git.ps1 on Windows", () => {
  let dir: string;
  let native: (typeof ASSETS)[number];
  beforeAll(() => {
    const arch = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${ARCHITECTURE_SOURCE}\nWrite-Output $arch`], {
      env: installerEnv(), encoding: "utf8",
    }).trim();
    const asset = ASSETS.find((candidate) => candidate.arch === arch);
    if (!asset) throw new Error(`No pinned archive for native architecture ${arch}`);
    native = asset;
  });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ave-install-git-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A MinGit-shaped zip, and a copy of the script that fetches it from disk with pins of `pinBytes` (the zip itself by default). */
  function stage(options: { pinBytes?: Buffer; files?: string[]; nativeMachine?: number; prefix?: string } = {}) {
    const tree = path.join(dir, "tree");
    const prefix = options.prefix ?? native.prefix;
    for (const file of options.files ?? ["cmd/git.exe", `${prefix}/bin/git-remote-https.exe`, `${prefix}/libexec/git-core/git-upload-pack.exe`, "usr/bin/ssh.exe"]) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      writeFileSync(path.join(tree, file), "stub");
    }
    const zip = path.join(dir, "asset.zip");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${tree}', '${zip}')`], { env: installerEnv() });
    const pinned = options.pinBytes ?? readFileSync(zip);
    let script = source
      .replace(/\$url = "[^"]+"/u, `$url = '${pathToFileURL(zip).href}'`)
      .replace(/Size = \d+; Sha256 = '[0-9a-f]{64}'/gu, `Size = ${pinned.length}; Sha256 = '${createHash("sha256").update(pinned).digest("hex")}'`);
    if (options.nativeMachine !== undefined) script = script.replace(NATIVE_MACHINE_CALL, String(options.nativeMachine));
    const scriptPath = path.join(dir, "install-windows-git.ps1");
    writeFileSync(scriptPath, script);
    const install = path.join(dir, "install");
    mkdirSync(install);
    return { scriptPath, install };
  }

  // customInstall downloads into $INSTDIR itself, which only an administrator can write.
  function run({ scriptPath, install }: ReturnType<typeof stage>, shell = "powershell.exe") {
    return spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-InstallDir", install, "-DownloadDir", install], {
      env: installerEnv(), encoding: "utf8", timeout: 60_000,
    });
  }

  it("recomputes authorization at each redirect and strips it from asset hosts", () => {
    const start = source.indexOf("function Save-AuthenticatedRelease(");
    const end = source.indexOf("\n\ntry {", start);
    const download = source.slice(start, end)
      .replace("[Net.WebRequest]::Create($Uri)", "(New-FixtureRequest $Uri)");
    const output = path.join(dir, "download");
    const fixture = `${download}
$ErrorActionPreference = 'Stop'
$script:requests = @()
$script:locations = @('https://api.github.com/asset', 'https://objects.githubusercontent.com/asset', 'https://github.com.evil.invalid/asset')
function New-FixtureRequest([Uri]$Uri) {
  $request = [pscustomobject]@{ Uri = $Uri; Headers = @{}; AllowAutoRedirect = $true; Timeout = 0; ReadWriteTimeout = 0 }
  $request | Add-Member ScriptMethod GetResponse {
    $script:requests += @{ uri = $this.Uri.AbsoluteUri; authorization = $this.Headers['Authorization']; automatic = $this.AllowAutoRedirect }
    $index = $script:requests.Count - 1
    $location = if ($index -lt $script:locations.Count) { $script:locations[$index] } else { $null }
    $response = [pscustomobject]@{ StatusCode = $(if ($location) { 302 } else { 200 }); Headers = @{ Location = $location } }
    $response | Add-Member ScriptMethod GetResponseStream { [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('verified bytes')) }
    $response | Add-Member ScriptMethod Dispose {}
    return $response
  }
  return $request
}
Save-AuthenticatedRelease -Uri 'https://github.com/asset' -Path $env:FIXTURE_OUTPUT -Token 'fixture-token'
ConvertTo-Json -Compress -InputObject @($script:requests)
`;
    const scriptPath = path.join(dir, "redirect-fixture.ps1");
    writeFileSync(scriptPath, fixture);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
      env: { ...installerEnv(), FIXTURE_OUTPUT: output }, encoding: "utf8", timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { uri: "https://github.com/asset", authorization: "Bearer fixture-token", automatic: false },
      { uri: "https://api.github.com/asset", authorization: "Bearer fixture-token", automatic: false },
      { uri: "https://objects.githubusercontent.com/asset", authorization: null, automatic: false },
      { uri: "https://github.com.evil.invalid/asset", authorization: null, automatic: false },
    ]);
    expect(readFileSync(output, "utf8")).toBe("verified bytes");
  });

  it("places a verified archive at <install>\\git and deletes the download", () => {
    const staged = stage();
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const root = path.join(staged.install, "git");
    expect(statSync(path.join(root, "cmd", "git.exe")).isFile()).toBe(true);
    expect(readdirSync(staged.install)).toEqual(["git"]);
    // The layout the app reads must match what the script placed.
    expect(findInstallerGit(root)).toEqual({ path: path.join(root, "cmd", "git.exe"), root, prefix: native.prefix });
  });

  it.each([
    { machine: 0x8664, arch: "AMD64", prefix: "ucrt64" },
    { machine: 0xAA64, arch: "ARM64", prefix: "clangarm64" },
  ])("maps native machine $arch to its pinned layout", ({ machine, prefix }) => {
    const staged = stage({ nativeMachine: machine, prefix });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(findInstallerGit(path.join(staged.install, "git"))?.prefix).toBe(prefix);
    expect(readdirSync(staged.install)).toEqual(["git"]);
  });

  it("selects the native layout from a 32-bit shell without architecture variables", () => {
    const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
    const bits = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "[IntPtr]::Size"], { env: installerEnv(), encoding: "utf8" });
    expect(bits.trim()).toBe("4");
    const staged = stage();
    const result = run(staged, shell);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(findInstallerGit(path.join(staged.install, "git"))?.prefix).toBe(native.prefix);
  });

  it("keeps exit 5 for an unsupported native machine", () => {
    const staged = stage({ nativeMachine: 0x014c });
    const result = run(staged);
    expect(result.status, result.stdout + result.stderr).toBe(5);
    expect(result.stdout).toContain("no pinned MinGit for 0x014C");
    expect(readdirSync(staged.install)).toEqual([]);
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
