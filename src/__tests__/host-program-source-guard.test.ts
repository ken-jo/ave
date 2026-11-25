// windows-native
// Main-process code launches host programs by absolute path: a literal program name must be absolute, and the sites that launch a variable bare name resolve it through the shared PATH-only resolver.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const RESOLVER = "shared/host-program-path.ts";

function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productFiles(path);
    return /\.(?:ts|mts|cts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const LAUNCH = /(?<![\w$.])(?:(?:childProcess|child_process|cp)\.)?(spawn|spawnSync|execFile|execFileSync|exec|execSync|execFileAsync|execAsync|spawnManaged|spawnGatedManagedProcess)\(\s*(["'`])((?:(?!\2)[^\\]|\\.)*)\2/gu;
const THIS_LAUNCH = /\bthis\.(spawn)\(\s*(["'`])((?:(?!\2)[^\\]|\\.)*)\2/gu;

function isAbsoluteProgram(program: string): boolean {
  return program.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(program) || program.startsWith("${");
}

function bareLiteralLaunches(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => [...text.matchAll(LAUNCH), ...text.matchAll(THIS_LAUNCH)]
    .filter((match) => !isAbsoluteProgram(match[3] ?? ""))
    .map((match) => `${path}:${text.slice(0, match.index).split("\n").length} ${match[1]}("${match[3]}")`));
}

// Every file that can launch a program, each reviewed: it names its program absolutely, takes it from an absolute-only source, or resolves it with the shared resolver. A new launch site joins this list only after that review.
const LAUNCH_FILES = [
  "hooks/script-hook-runner.ts",
  "lib/shell-resolver.ts",
  "main/acp-subscription-runtime-client.ts",
  "main/acp-subscription-session-client.ts",
  "main/auto-updater.ts",
  "main/browser/browser-download-files.ts",
  "main/claude-code-authenticity.ts",
  "main/claude-code-conversation-runtime.ts",
  "main/claude-code-subscription-client.ts",
  "main/codex-executable-location.ts",
  "main/codex-native-spawn.ts",
  "main/corp-ca-extract.ts",
  "main/document-engine-system-command.ts",
  "main/editor-command.ts",
  "main/host-api/mapped-drive-root.ts",
  "main/host-runtime-probe.ts",
  "main/managed-child-processes.ts",
  "main/process-group-reaper.ts",
  "main/python-runtime.ts",
  "main/tailnet-cli.ts",
  "main/terminal/shell-process.ts",
  "main/terminal/terminal-inner-pty.ts",
  "main/terminal/terminal-tty-handoff.ts",
  "main/windows-job-launcher.ts",
  "main/windows-path-kind-launcher.ts",
  "marketplace/git/global-config.ts",
  "marketplace/git/run-git.ts",
  "marketplace/git/ssh-preflight.ts",
  "mcp/mcp-client.ts",
  "observation/libreoffice-process.ts",
  "permissions/asrt-sandbox.ts",
  "permissions/asrt-windows-support.ts",
  "permissions/confined-child.ts",
  "permissions/judge/external-judge.ts",
  "permissions/mxc-extension-process.ts",
  "permissions/mxc-policy-pipe.ts",
  "permissions/mxc-runtime-root.ts",
  "permissions/mxc-windows.ts",
  "permissions/offline-process-sandbox.ts",
  "permissions/srt-win-integrity.ts",
  "permissions/verified-shell-command.ts",
  "permissions/windows-acl-grant-holder.ts",
  "permissions/windows-process-start-time.ts",
  "permissions/worker-spawn.ts",
  "plugins/installed-entry-fs.ts",
  "plugins/isolation/child-loopback-link.ts",
  "shared/ave-home-configuration.ts",
  "shared/ave-home.ts",
  "shared/host-git.ts",
  "shared/host-git-probe.ts",
  "shared/verified-executable.ts",
  "shared/windows-path-facts.ts",
  "tools/grep-search.ts",
  "tools/image-preparation.ts",
  "tools/preview-document-process.ts",
  "tools/shell-tools.ts",
];

const LAUNCH_IMPORT = /import\s+(?!type\b)[^;]*?from\s+["']node:child_process["']|(?:require|import)\(["']node:child_process["']\)|\b(?:spawnManaged|spawnGatedManagedProcess)\(/u;

// Sites whose program is a variable that may be a bare name; each must pass it through the resolver.
const RESOLVED_SITES = [
  "marketplace/git/ssh-preflight.ts",
  "main/tailnet-cli.ts",
  "lib/shell-resolver.ts",
  "mcp/mcp-client.ts",
  "permissions/worker-spawn.ts",
  "main/managed-child-processes.ts",
  "main/corp-ca-extract.ts",
  "hooks/script-hook-runner.ts",
  "permissions/confined-child.ts",
];

describe("host program launch source guard", () => {
  const files = productFiles(SRC)
    .map((path) => ({ path: relative(SRC, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }))
    .filter(({ path }) => path !== RESOLVER);

  it("finds no literal bare program name in a launch call", () => {
    expect(bareLiteralLaunches(files)).toEqual([]);
  });

  it("flags a planted bare launch and passes an absolute one", () => {
    const planted = [{ path: "planted.ts", text: 'execFile("ssh", ["-G"]);\nspawn(\n  "/usr/bin/ssh", []);\nthis.spawn(`node`, []);\ndb.exec("PRAGMA x");' }];
    expect(bareLiteralLaunches(planted)).toEqual(['planted.ts:1 execFile("ssh")', 'planted.ts:4 spawn("node")']);
  });

  it("keeps the set of files that can launch a program to the reviewed list", () => {
    expect(files.filter(({ text }) => LAUNCH_IMPORT.test(text)).map(({ path }) => path).sort()).toEqual([...LAUNCH_FILES].sort());
  });

  it.each(RESOLVED_SITES)("%s resolves its program through the shared resolver", (site) => {
    const file = files.find(({ path }) => path === site);
    expect(file?.text, site).toMatch(/\b(?:resolveHostProgram|findHostProgram)\(/u);
  });

  it("does not search PATH for offline wrapper programs", () => {
    const site = "permissions/offline-process-sandbox.ts";
    const file = files.find(({ path }) => path === site);
    expect(file?.text, site).toBeDefined();
    expect(file?.text, site).not.toMatch(/\b(?:resolveHostProgram|findHostProgram)\b/u);
  });
});
