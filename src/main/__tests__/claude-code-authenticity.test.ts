import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateClaudeCodeExecutable, ClaudeCodeAuthenticityError, ClaudeCodeVersionUnsupportedError, createClaudeCodeReleaseFetch,
  isAllowedClaudeCodeReleaseRequest,
} from "../claude-code-authenticity.js";
import * as locations from "../codex-executable-location.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import * as systemDirectory from "../windows-path-kind-launcher.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("../windows-path-kind-launcher.js", () => ({ queryWindowsSystemDirectory: vi.fn() }));
vi.mock("../codex-executable-location.js", async () => {
  const { promises: fs } = await import("node:fs");
  return { assertCodexExecutableLocation: vi.fn(async () => undefined), createPrivateTempDirectory: vi.fn((prefix: string) => fs.mkdtemp(prefix)) };
});

const FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
const UNRELATED_FINGERPRINT = "1111111111111111111111111111111111111111";
const SOURCE = "/home/example/.local/share/claude/versions/2.1.311";
const CONTENT = Buffer.from("sealed native fixture bytes");
const CONTENT_HASH = createHash("sha256").update(CONTENT).digest("hex");
const HOST = process.platform;
const roots: string[] = [];
interface VerifierCall { command: string; args: readonly string[]; options: ExecFileOptions }
const calls: VerifierCall[] = [];
let processReply: (call: VerifierCall) => string | Error;
let fetchReply: (url: string) => Response;
let releaseFetch: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

function validSignature(primary = FINGERPRINT, signer = FINGERPRINT): string {
  return `[GNUPG:] GOODSIG ${signer.slice(-16)} Release Signing\n[GNUPG:] VALIDSIG ${signer} 2026-10-27 1793059200 0 4 0 1 10 00 ${primary}\n`;
}
function manifest(hash = CONTENT_HASH, platform = "linux-x64", version = "2.1.311"): string {
  return JSON.stringify({ version, platforms: { [platform]: { binary: "claude", checksum: hash } } });
}
async function artifact(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ave-publisher-proof-"));
  roots.push(root);
  const executable = join(root, "runtime");
  await fs.writeFile(executable, CONTENT, { mode: 0o500 });
  return executable;
}
async function authenticate(platform: NodeJS.Platform = "linux", source = SOURCE, arch: NodeJS.Architecture = "x64"): Promise<string> {
  const executable = await artifact();
  await authenticateClaudeCodeExecutable(executable, source, CONTENT_HASH, platform, arch, releaseFetch as unknown as typeof fetch);
  return executable;
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(systemDirectory.queryWindowsSystemDirectory).mockResolvedValue("C:\\Windows\\System32");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("GNUPGHOME", "/home/example/private-signing-home");
  vi.stubEnv("ANTHROPIC_API_KEY", "parent-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "parent-session");
  processReply = ({ command, args }) => command.endsWith("powershell.exe") ? "authenticated"
    : args.includes("--verify") && command.endsWith("/gpg") ? validSignature() : "";
  vi.mocked(execFile).mockImplementation(((command: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const call = { command, args, options };
    calls.push(call);
    const reply = processReply(call);
    callback(reply instanceof Error ? reply : null, reply instanceof Error ? "" : reply, "");
    return {} as ChildProcess;
  }) as typeof execFile);
  fetchReply = (url) => new Response(url.endsWith("manifest.json") ? manifest() : "fixture-signature-or-key");
  releaseFetch = vi.fn(async (url: string) => fetchReply(url));
  // Authentication must use the supplied host transport, never the process-global fetch.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Process-global fetch used"); }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("native publisher verifier simulations", () => {
  it("tests the platform publisher requirement against the sealed copy before admission", async () => {
    const executable = await authenticate("darwin");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("/usr/bin/codesign");
    expect(call.args.slice(0, 5)).toEqual(["--verify", "--strict", "--all-architectures", "--test-requirement", expect.any(String)]);
    expect(call.args.at(-1)).toBe(executable);
    const requirement = call.args[4]!;
    for (const value of ["anchor apple generic", "1.2.840.113635.100.6.2.6", "1.2.840.113635.100.6.1.13", 'subject.OU] = "Q6L2SF6YDW"', 'subject.CN] = "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)"', 'identifier "com.anthropic.claude-code"']) expect(requirement).toContain(value);
    expect(locations.assertCodexExecutableLocation).toHaveBeenCalledWith("/usr/bin/codesign", "native");
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  // Which signatures codesign rejects is proven against the real verifier in claude-code-authenticity-native.test.ts; this only maps its refusal.
  it("maps any non-zero codesign result to the typed publisher refusal without a second verifier", async () => {
    processReply = () => new Error("Platform rejected fixture signature");
    await expect(authenticate("darwin")).rejects.toMatchObject({ name: "ClaudeCodeAuthenticityError", reason: "publisher-rejected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/codesign");
  });

  it("simulates a valid Authenticode verifier with exact signer identity and code-signing usage", async () => {
    const executable = await authenticate("win32");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(call.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(call.args[3]!, "base64").toString("utf16le");
    expect(script.indexOf("$PSModuleAutoLoadingPreference = 'None'")).toBeLessThan(script.indexOf("Import-Module"));
    expect(script).toContain("Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')");
    expect(script.indexOf("Import-Module")).toBeLessThan(script.indexOf("Get-AuthenticodeSignature"));
    for (const value of ["Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:AVE_SIGNATURE_FILE", "$signature.Status -ne 'Valid'", "$subject -cne 'Anthropic, PBC'", "1.3.6.1.5.5.7.3.3", "X509EnhancedKeyUsageExtension", "SubjectName.Decode", "^O=(?:", "exit 1"]) expect(script).toContain(value);
    expect(script).not.toContain(executable);
    expect(call.options.env?.AVE_SIGNATURE_FILE).toBe(executable);
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it.skipIf(HOST !== "win32")("rejects an unsigned file with the actual system verifier despite a shadow signature module", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const executable = await authenticate("win32");
    const verifierArgs = calls[0]!.args;
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const helper = join(process.cwd(), "resources", "windows-path-kind", process.arch, "ave-path-kind.exe");
    const systemDirectory = actual.execFileSync(helper, ["--system-directory"], { encoding: "utf8", shell: false, env: {}, timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }).trim();
    const shadowRoot = join(dirname(executable), "modules");
    const moduleDirectory = join(shadowRoot, "Microsoft.PowerShell.Security");
    await fs.mkdir(moduleDirectory, { recursive: true });
    const marker = join(dirname(executable), "shadow-loaded");
    await fs.writeFile(join(moduleDirectory, "Microsoft.PowerShell.Security.psm1"),
      "function Get-AuthenticodeSignature { [IO.File]::WriteAllText($env:AVE_SHADOW_MARKER, 'loaded'); throw 'Shadow verifier executed' }\nExport-ModuleMember -Function Get-AuthenticodeSignature\n");
    const result = actual.spawnSync(join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"), [...verifierArgs], {
      encoding: "utf8", shell: false, windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
      env: { SystemRoot: dirname(systemDirectory), WINDIR: dirname(systemDirectory), PATH: systemDirectory,
        PSModulePath: shadowRoot, AVE_SIGNATURE_FILE: executable, AVE_SHADOW_MARKER: marker },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("authenticated");
    expect(await fs.readdir(dirname(executable))).not.toContain("shadow-loaded");
  });

  it("selects the simulated OS system directory despite spoofed parent system variables", async () => {
    vi.stubEnv("SystemRoot", "Z:\\untrusted");
    vi.stubEnv("SYSTEMROOT", "Z:\\untrusted");
    vi.stubEnv("WINDIR", "Y:\\untrusted");
    vi.stubEnv("PATH", "X:\\untrusted");
    vi.mocked(systemDirectory.queryWindowsSystemDirectory).mockResolvedValue("D:\\OperatingSystem\\System32");
    await authenticate("win32");
    expect(systemDirectory.queryWindowsSystemDirectory).toHaveBeenCalledTimes(1);
    expect(calls[0]!.command).toBe("D:\\OperatingSystem\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]!.options.env).toMatchObject({
      SystemRoot: "D:\\OperatingSystem", WINDIR: "D:\\OperatingSystem",
      PATH: "D:\\OperatingSystem\\System32;D:\\OperatingSystem",
    });
    expect(JSON.stringify(calls)).not.toContain("untrusted");
  });

  it("refuses a failed native directory query without invoking any verifier or searching another path", async () => {
    vi.mocked(systemDirectory.queryWindowsSystemDirectory).mockRejectedValue(new Error("Native helper failed"));
    await expect(authenticate("win32")).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
    expect(calls).toEqual([]);
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it.each(["platform signature refusal", "unexpected verifier result"])("fails closed on %s", async (reason) => {
    processReply = () => reason === "platform signature refusal" ? new Error("Untrusted signer") : "Valid";
    await expect(authenticate("win32")).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });

  it.each(["darwin", "win32", "linux"] as const)("never executes the candidate on %s and gives verification tools a minimal environment", async (platform) => {
    const executable = await authenticate(platform);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).not.toBe(executable);
      expect(call.command).not.toBe(SOURCE);
      expect(call.options.shell).toBe(false);
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.maxBuffer).toBe(256 * 1024);
      expect(Object.keys(call.options.env ?? {}).some((name) => /^(ANTHROPIC_|CLAUDE_|GNUPGHOME$)/iu.test(name))).toBe(false);
      expect(Object.values(call.options.env ?? {})).not.toContain("parent-key");
      expect(Object.values(call.options.env ?? {})).not.toContain("parent-session");
      expect(Object.values(call.options.env ?? {})).not.toContain("/home/example/private-signing-home");
    }
  });

  it("refuses a mismatched sealed hash before any platform verifier or network request", async () => {
    const executable = await artifact();
    await expect(authenticateClaudeCodeExecutable(executable, SOURCE, "0".repeat(64), "darwin", "arm64", releaseFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
    expect(calls).toEqual([]);
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it("refuses bytes replaced during successful platform verification", async () => {
    const executable = await artifact();
    const { writeFileSync, chmodSync } = await import("node:fs");
    processReply = () => { chmodSync(executable, 0o700); writeFileSync(executable, "replacement"); return ""; };
    await expect(authenticateClaudeCodeExecutable(executable, SOURCE, CONTENT_HASH, "darwin", "arm64", releaseFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });

  it("refuses unsupported platforms before any verifier executes", async () => {
    await expect(authenticate("freebsd")).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
    expect(calls).toEqual([]);
  });
});

describe("signed release checksum verifier simulations", () => {
  it("verifies an isolated detached signature with its pinned primary key before using the exact binary checksum", async () => {
    const executable = await authenticate();
    expect(calls.map(({ command }) => command)).toEqual(["/usr/bin/gpg", "/usr/bin/gpg"]);
    const [importCall, verifyCall] = calls;
    const home = importCall!.args[importCall!.args.indexOf("--homedir") + 1]!;
    expect(dirname(home)).toBe(dirname(executable));
    expect(importCall!.args).toEqual(["--no-options", "--homedir", home, "--batch", "--no-tty", "--no-autostart", "--no-auto-key-retrieve", "--import", join(home, "release.asc")]);
    expect(verifyCall!.args).toEqual(["--no-options", "--homedir", home, "--batch", "--no-tty", "--no-autostart", "--no-auto-key-retrieve", "--status-fd", "1", "--verify", join(home, "manifest.json.sig"), join(home, "manifest.json")]);
    expect(await fs.readdir(dirname(executable))).toEqual(["runtime"]);
    expect(releaseFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://downloads.claude.ai/keys/claude-code.asc",
      "https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json",
      "https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json.sig",
    ]);
    for (const [, options] of releaseFetch.mock.calls) {
      expect(options).toMatchObject({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) });
    }
  });

  it("accepts a verified signing subkey only when GPG binds it to the pinned primary", async () => {
    processReply = ({ args }) => args.includes("--verify") ? validSignature(FINGERPRINT, UNRELATED_FINGERPRINT) : "";
    await expect(authenticate()).resolves.toEqual(expect.any(String));
  });

  it.each([
    ["wrong primary key", validSignature(UNRELATED_FINGERPRINT)],
    ["no cryptographic result", "[GNUPG:] GOODSIG BAA929FF1A7ECACE Release Signing\n"],
    ["bad signature", `${validSignature()}[GNUPG:] BADSIG BAA929FF1A7ECACE Release Signing\n`],
    ["revoked key", `${validSignature()}[GNUPG:] REVKEYSIG BAA929FF1A7ECACE Release Signing\n`],
    ["expired key", `${validSignature()}[GNUPG:] EXPKEYSIG BAA929FF1A7ECACE Release Signing\n`],
    ["expired signature", `${validSignature()}[GNUPG:] EXPSIG BAA929FF1A7ECACE Release Signing\n`],
    ["multiple signatures", `${validSignature()}${validSignature()}`],
  ])("refuses %s without trusting a good-looking signer name", async (_reason, status) => {
    processReply = ({ args }) => args.includes("--verify") ? status : "";
    await expect(authenticate()).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
    expect(await fs.readdir(roots.at(-1)!)).toEqual(["runtime"]);
  });

  it.each([
    ["changed bytes", manifest("0".repeat(64))],
    ["different architecture", manifest(CONTENT_HASH, "linux-arm64")],
    ["different release", manifest(CONTENT_HASH, "linux-x64", "2.1.310")],
    ["malformed manifest", "not-json"],
    ["unsupported binary name", JSON.stringify({ version: "2.1.311", platforms: { "linux-x64": { binary: "launcher", checksum: CONTENT_HASH } } })],
  ])("refuses a signed manifest with %s", async (_reason, data) => {
    fetchReply = (url) => new Response(url.endsWith("manifest.json") ? data : "fixture-signature-or-key");
    await expect(authenticate()).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });

  it.each(["x64", "arm64"] as const)("matches the musl checksum for %s without accepting another architecture", async (arch) => {
    fetchReply = (url) => new Response(url.endsWith("manifest.json") ? manifest(CONTENT_HASH, `linux-${arch}-musl`) : "fixture-signature-or-key");
    await expect(authenticate("linux", SOURCE, arch)).resolves.toEqual(expect.any(String));
  });

  it("accepts a versioned cask source without running a version probe", async () => {
    await expect(authenticate("linux", "/home/linuxbrew/.linuxbrew/Caskroom/claude-code/2.1.311/claude")).resolves.toEqual(expect.any(String));
    expect(calls.every(({ command }) => command === "/usr/bin/gpg")).toBe(true);
  });

  it.each([
    ["/usr/bin/dpkg-query", "2.1.311-1", ["--show", "--showformat=${Version}", "claude-code"]],
    ["/usr/bin/rpm", "2.1.311", ["--query", "--file", "/usr/bin/claude", "--queryformat", "%{VERSION}"]],
    // apk-tools `info --who-owns` at its default verbosity: "<path> [symlink target ]is owned by <name>-<version>-r<N>" (src/app_info.c).
    ["/sbin/apk", "/usr/bin/claude is owned by claude-code-2.1.311-r1\n", ["info", "--who-owns", "/usr/bin/claude"]],
    ["/sbin/apk", "/usr/bin/claude symlink target is owned by claude-code-2.1.311-r0\n", ["info", "--who-owns", "/usr/bin/claude"]],
  ] as const)("uses %s only to locate signed metadata for a packaged binary (%s)", async (query, version, args) => {
    processReply = ({ command, args }) => command === query ? version
      : command.endsWith("/gpg") ? args.includes("--verify") ? validSignature() : ""
      : new Error("Database absent");
    await expect(authenticate("linux", "/usr/bin/claude")).resolves.toEqual(expect.any(String));
    expect(releaseFetch.mock.calls.map(([url]) => url)).toContain("https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json");
    expect(calls).toContainEqual(expect.objectContaining({ command: query, args }));
    expect(calls.some(({ command }) => command === "/usr/bin/claude")).toBe(false);
    expect(calls.at(-1)!.args).toContain("--verify");
  });

  it.each([
    ["another path", "/usr/local/bin/claude is owned by claude-code-2.1.311-r1"],
    ["another package", "/usr/bin/claude is owned by claude-code-helper-2.1.311-r1"],
    ["the quiet package-name form", "claude-code"],
    ["the former unsupported format", "claude-code-2.1.311-r0 owns /usr/bin/claude"],
  ])("refuses apk output naming %s without fetching metadata", async (_reason, output) => {
    processReply = ({ command }) => command === "/sbin/apk" ? output : new Error("Database absent");
    await expect(authenticate("linux", "/usr/bin/claude")).rejects.toMatchObject({ reason: "publisher-rejected" });
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it("refuses an apk-located version whose signed manifest names another release", async () => {
    processReply = ({ command, args }) => command === "/sbin/apk" ? "/usr/bin/claude is owned by claude-code-2.1.311-r1"
      : command.endsWith("/gpg") ? args.includes("--verify") ? validSignature() : ""
      : new Error("Database absent");
    fetchReply = (url) => new Response(url.endsWith("manifest.json") ? manifest(CONTENT_HASH, "linux-x64", "2.1.310") : "fixture-signature-or-key");
    await expect(authenticate("linux", "/usr/bin/claude")).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });

  it.each([
    ["a versioned native install", "/home/example/.local/share/claude/versions/2.1.88"],
    ["a versioned cask payload", "/home/linuxbrew/.linuxbrew/Caskroom/claude-code/2.0.76/claude"],
  ])("refuses %s below the supported minimum before any metadata request", async (_reason, source) => {
    const failure = authenticate("linux", source);
    await expect(failure).rejects.toBeInstanceOf(ClaudeCodeVersionUnsupportedError);
    await expect(failure).rejects.toMatchObject({ version: source.match(/\d+\.\d+\.\d+/u)![0] });
    expect(calls).toEqual([]);
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it("refuses an apk-located release below the supported minimum before any metadata request", async () => {
    processReply = ({ command }) => command === "/sbin/apk" ? "/usr/bin/claude is owned by claude-code-2.1.88-r0" : new Error("Database absent");
    await expect(authenticate("linux", "/usr/bin/claude")).rejects.toMatchObject({ name: "ClaudeCodeVersionUnsupportedError", version: "2.1.88" });
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it("does not treat package database version output as publisher authentication", async () => {
    processReply = ({ command }) => command === "/usr/bin/dpkg-query" ? "2.1.311-1" : new Error("Signature rejected");
    await expect(authenticate("linux", "/usr/bin/claude")).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });

  it.each(["/custom/claude", "/tmp/../../release.json", "/home/example/versions/2.1.311-malicious"])("refuses an unknown version locator %s without probing the candidate", async (source) => {
    await expect(authenticate("linux", source)).rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
    expect(calls).toEqual([]);
    expect(releaseFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", "release-metadata-unavailable"],
    ["missing detached signature", "release-metadata-unavailable"],
    ["oversized metadata", "publisher-rejected"],
  ] as const)("refuses %s as %s and removes temporary verification material", async (reason, expected) => {
    fetchReply = () => {
      if (reason === "unreachable") throw new Error("Network unavailable");
      return reason === "missing detached signature" ? new Response("missing", { status: 404 }) : new Response("x".repeat(256 * 1024 + 1));
    };
    await expect(authenticate()).rejects.toMatchObject({ name: "ClaudeCodeAuthenticityError", reason: expected });
    expect(await fs.readdir(roots.at(-1)!)).toEqual(["runtime"]);
    expect(calls).toEqual([]);
  });

  it("does not expose raw verifier diagnostics in the typed failure", async () => {
    processReply = () => new Error("Sensitive path and subprocess diagnostics");
    await expect(authenticate()).rejects.toThrow(/^Subscription runtime publisher could not be authenticated$/u);
  });
});

describe("release metadata transport", () => {
  it.each([
    ["GET", "https://downloads.claude.ai/keys/claude-code.asc", true],
    ["GET", "https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json", true],
    ["get", "https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json.sig", true],
    ["POST", "https://downloads.claude.ai/keys/claude-code.asc", false],
    ["GET", "http://downloads.claude.ai/keys/claude-code.asc", false],
    ["GET", "https://downloads.claude.ai.example/keys/claude-code.asc", false],
    ["GET", "https://user:secret@downloads.claude.ai/keys/claude-code.asc", false],
    ["GET", "https://downloads.claude.ai/keys/claude-code.asc?token=1", false],
    ["GET", "https://downloads.claude.ai/claude-code-releases/latest", false],
    ["GET", "https://downloads.claude.ai/claude-code-releases/2.1.311/linux-x64/claude", false],
    ["GET", "https://downloads.claude.ai/claude-code-releases/2.1.311-x/manifest.json", false],
    ["GET", "not a url", false],
  ] as const)("admits only the fixed verification requests: %s %s -> %s", (method, url, allowed) => {
    expect(isAllowedClaudeCodeReleaseRequest(method, url)).toBe(allowed);
  });

  it("sends allowed requests on the host stack without redirects or credentials, and refuses others before sending", async () => {
    const networkFetch = vi.fn(async () => new Response("ok"));
    const transport = createClaudeCodeReleaseFetch(networkFetch as unknown as typeof fetch);
    await transport("https://downloads.claude.ai/keys/claude-code.asc", { redirect: "follow", credentials: "include" });
    expect(networkFetch).toHaveBeenCalledWith("https://downloads.claude.ai/keys/claude-code.asc", expect.objectContaining({ redirect: "error", credentials: "omit" }));
    await expect(transport("https://example.com/keys/claude-code.asc")).rejects.toThrow(/outside the verification allowlist/u);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });
});
