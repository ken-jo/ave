import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceFiles, parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeConversationRuntime } from "../claude-code-conversation-runtime.js";
import { ClaudeCodeSubscriptionClient } from "../claude-code-subscription-client.js";
import type { ClaudeCodeExecutable } from "../claude-code-executable.js";
import { nativeExecutableBytes } from "../../__tests__/support/native-executable.js";
import * as locations from "../codex-executable-location.js";
import * as managed from "../managed-child-processes.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";

// Direct dependencies are reviewed capabilities; a new helper must reopen this policy review.
const TRANSPORT_IMPORTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "claude-code-subscription-client.ts": {
    "node:child_process": ["ChildProcess", "SpawnOptions"],
    "./oauth-login.js": ["OAuthLoginAttempt", "OpenOAuthLogin"],
    "node:fs": ["constants", "promises"],
    "node:os": ["homedir"],
    "node:path": ["isAbsolute", "join", "posix", "win32"],
    "node:string_decoder": ["StringDecoder"],
    "node:util": ["TextDecoder"],
    "../shared/is-record.js": ["isRecord"],
    "../shared/claude-code-subscription.js": ["CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID", "claudeCodeSubscriptionStatus", "ClaudeCodeSubscriptionErrorCode", "ClaudeCodeSubscriptionStatus"],
    "./managed-child-processes.js": ["forceKillManagedChildProcess", "spawnManaged"],
    "./user-cli-discovery.js": ["cliEnvironmentValue", "cliExecutableCandidates", "cliPathApi", "usableCliDirectory", "CliDiscoveryEnvironment"],
    "./claude-code-executable.js": ["ClaudeCodeNativeRequiredError", "pinClaudeCodeExecutable", "ClaudeCodeExecutable"],
    "./codex-executable-location.js": ["assertCodexLocations", "CodexExecutableLocationError", "createPrivateTempDirectory"],
  },
  "claude-code-conversation-runtime.ts": {
    "node:child_process": ["ChildProcess", "SpawnOptions"],
    "node:crypto": ["randomUUID"],
    "node:fs": ["promises"],
    "node:path": ["join"],
    "node:util": ["TextDecoder"],
    "../engine/llm/types.js": ["StreamEvent", "ToolSchema"],
    "../lib/json-line-reader.js": ["JsonLineReader"],
    "../shared/is-record.js": ["isRecord"],
    "../shared/claude-code-subscription.js": ["CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID"],
    "../shared/tool-timeout-policy.js": ["TOOL_TIMEOUT_POLICY"],
    "./claude-code-subscription-client.js": ["ClaudeCodeSubscriptionError", "claudeCodeLocationError", "sanitizedClaudeCodeEnvironment", "validateClaudeCodeRuntimeDirectories"],
    "./claude-code-stream.js": ["CLAUDE_CODE_MAX_OUTPUT_BYTES", "CLAUDE_CODE_MAX_PROMPT_BYTES", "CLAUDE_CODE_MCP_SERVER_NAME", "claudeCodePrintArgs", "ClaudeCodeStream"],
    "./managed-child-processes.js": ["forceKillManagedChildProcess", "spawnManaged"],
    "./storage/feature-namespace.js": ["writeFileAtomicAtPath"],
    "./subscription-attachment-input.js": ["SubscriptionAttachmentTransportError"],
    "./codex-executable-location.js": ["CodexExecutableLocationError"],
    "./subscription-tool-bridge.js": ["SubscriptionToolBridge"],
    "./claude-code-executable.js": ["ClaudeCodeExecutable"],
  },
  "claude-code-stream.ts": {
    "../shared/is-record.js": ["isRecord"],
  },
  "claude-code-executable.ts": {
    "node:fs": ["promises"],
    "node:path": ["join"],
    "./codex-executable-artifact.js": ["copyNativeExecutableFile", "discardCodexExecutableArtifact", "hashExecutableFile", "openExecutableFile", "verifyCodexExecutableArtifact", "CodexExecutableArtifact"],
    "./codex-executable-location.js": ["assertCodexExecutableLocation", "assertCodexPrivateRuntimeDirectory", "createPrivateObjects", "createPrivateTempDirectory"],
    "./native-executable-format.js": ["isNativeExecutableFile"],
    "./user-cli-discovery.js": ["CliDiscoveryEnvironment"],
  },
};

// Path provenance lives in these filesystem-owning functions. A source change requires reviewing the producer and cleanup together,
// rather than accepting the same variable name after retargeting it. This deliberately freezes direct source, not transitive behavior.
const TRANSPORT_FS_OWNER_DIGESTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "claude-code-subscription-client.ts": {
    "resolveClaudeCodeSubscriptionExecutable": "36bc9fe7fcd9e3e16e2c6ed000dc51c93ecc2607d95bdb612e6475e493cd82a9",
    "locate": "d45d3bd283df7eefb166d3988140fd17d26be73a3d4498f23f1c2568d4a036f0",
    "qualify": "d671cee95ea05b799fdd37e884e004307fdaba78cb9a89c7965e46389c999e62"
  },
  "claude-code-conversation-runtime.ts": {
    "streamTurn": "10159534fafced47164c2004cdb93928ecddd7a51534125005201c7e204fbc1a"
  },
  "claude-code-executable.ts": {
    "pinClaudeCodeExecutable": "d21ff613e6038ac9030c42d5a38c39f0c0045d0ac5e4a6e16d6aa5b12bf6832a"
  }
};

const TRANSPORT_FS_OPERANDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "claude-code-subscription-client.ts": { realpath: ["candidate"], stat: ["executable"], access: ["executable"], lstat: ["candidate"], rm: ["probeHome"] },
  "claude-code-conversation-runtime.ts": { rm: ["configPath"] },
  "claude-code-stream.ts": {},
  "claude-code-executable.ts": { realpath: ["candidate"], rm: ["directory"] },
};

function wholeParentEnvironmentUse(node: ts.PropertyAccessExpression, file: string): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)
    && parent.expression.text === "sanitizedClaudeCodeEnvironment" && parent.arguments[1] === node) return true;
  if (file !== "claude-code-subscription-client.ts") return false;
  if (ts.isParameterDeclaration(parent) && parent.initializer === node && ts.isFunctionDeclaration(parent.parent)
    && parent.parent.name?.text === "sanitizedClaudeCodeEnvironment") return true;
  if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && parent.left.getText() === "options.env" && ts.isBinaryExpression(parent.parent)
    && parent.parent.left.getText() === "this.env" && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    for (let scope: ts.Node | undefined = parent.parent.parent; scope; scope = scope.parent) {
      if (ts.isConstructorDeclaration(scope)) return true;
    }
  }
  return false;
}

// These checks freeze direct transport capabilities; imported implementations retain their own tests and review.
function transportPolicyViolations(source: ts.SourceFile, file: string): string[] {
  const violations: string[] = [];
  const checkedOwners = new Set<ts.Node>();
  const reject = (condition: boolean, reason: string) => { if (condition) violations.push(`${file}: ${reason}`); };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "fs") {
      reject(!(ts.isImportSpecifier(node.parent) || (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)),
        "filesystem alias or computed access bypasses the credential capability guard");
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === "ClaudeCodeExecutable") {
      reject(node.members.map((member) => ts.isPropertySignatureDeclaration(member) || ts.isMethodSignatureDeclaration(member) ? member.name.getText() : "unsupported-member").join(",") !== "executable,identity,verify,discard",
        "native executable contract must not carry interpreter or loader prefix arguments");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "args" && ts.isIdentifier(node.expression) && node.expression.text === "runtime") {
      reject(true, "admitted native runtime must not inject interpreter or loader arguments");
    }
    if (ts.isIdentifier(node)) {
      reject(node.text === "Bun", "alternate runtime aliases must not bypass environment sanitization");
      reject(/^(?:accessToken|refreshToken|oauthAccount|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/u.test(node.text),
        "credential or token identifiers must remain private to the CLI");
      if (node.text === "process") reject(!(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
        && ["env", "platform", ...(file === "claude-code-executable.ts" ? ["arch"] : [])].includes(node.parent.name.text)), "process aliases and computed environment access require policy review");
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (/^(?:ANTHROPIC_|CLAUDE_)/u.test(node.name.text)) {
        const assignment = node.parent;
        const generatedConfig = node.name.text === "CLAUDE_CONFIG_DIR" && ts.isIdentifier(node.expression) && node.expression.text === "env"
          && ts.isBinaryExpression(assignment) && assignment.left === node && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(assignment.right) && assignment.right.text === "isolatedHome";
        reject(!generatedConfig, "provider-prefixed environment values must not be read or forwarded by the host");
      }
      reject(ts.isIdentifier(node.expression) && ["globalThis", "global"].includes(node.expression.text) && ["process", "Bun"].includes(node.name.text),
        "global runtime aliases must not bypass environment sanitization");
      if (ts.isIdentifier(node.expression) && node.expression.text === "fs") {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner) && !ts.isMethodDeclaration(owner)) owner = owner.parent;
        reject(!owner, "filesystem operations must stay in reviewed path-owning functions");
        if (owner && !checkedOwners.has(owner)) {
          checkedOwners.add(owner);
          const name = (owner as ts.FunctionDeclaration | ts.MethodDeclaration).name?.getText() ?? "anonymous";
          const digest = createHash("sha256").update(owner.getText()).digest("hex");
          reject(TRANSPORT_FS_OWNER_DIGESTS[file]?.[name] !== digest, `filesystem owner ${name} changed; review path provenance and update the explicit source freeze`);
        }
        const operands = TRANSPORT_FS_OPERANDS[file]?.[node.name.text];
        reject(!operands, `filesystem capability ${node.name.text} could read, copy or store credentials`);
        if (operands) {
          const call = node.parent;
          reject(!ts.isCallExpression(call) || call.expression !== node || !call.arguments[0]
            || !ts.isIdentifier(call.arguments[0]) || !operands.includes(call.arguments[0].text),
            `filesystem ${node.name.text} must use its reviewed executable or isolated runtime operand`);
        }
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") {
        reject(!wholeParentEnvironmentUse(node, file), "parent environment may only enter the sanitizer or discovery boundary as a whole");
      }
      reject(ts.isIdentifier(node.expression) && node.expression.text === "Bun" && node.name.text === "env",
        "alternate runtime environment access must not bypass sanitization");
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const imports = TRANSPORT_IMPORTS[file]?.[node.moduleSpecifier.text];
      reject(!imports, `unreviewed dependency ${node.moduleSpecifier.text}; credential capabilities require explicit policy review`);
      const bindings = node.importClause?.namedBindings;
      reject(Boolean(node.importClause?.name) || !bindings || !ts.isNamedImports(bindings), "default, namespace or side-effect imports require policy review");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          const name = entry.propertyName?.text ?? entry.name.text;
          reject(!imports?.includes(name), `unreviewed imported capability ${name}; neutral helper names do not establish credential safety`);
          if (node.moduleSpecifier.text === "node:fs" && name === "promises") reject(entry.name.text !== "fs", "filesystem binding must remain visible to the policy guard");
        }
      }
      if (node.moduleSpecifier.text === "node:child_process") reject(node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword,
        "process execution must stay behind the managed-child boundary");
    }
    if (ts.isCallExpression(node)) {
      reject(node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require",
        "dynamic imports must not bypass the credential capability guard");
    }
    if (ts.isImportEqualsDeclaration(node)) reject(true, "import aliases must not bypass the direct dependency allowlist");
    if (ts.isElementAccessExpression(node)) {
      reject(ts.isStringLiteral(node.argumentExpression) && ["process", "Bun"].includes(node.argumentExpression.text),
        "global runtime aliases must not bypass environment sanitization");
      reject(ts.isIdentifier(node.expression) && ["process", "Bun"].includes(node.expression.text), "computed runtime environment access must not bypass sanitization");
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Store names have no typed interface here; this literal guard intentionally fails with the policy reason.
      reject(/\.credentials\.json|Claude Code-credentials|find-generic-password|accessToken|refreshToken|apiKeyHelper|^(?:ANTHROPIC_.+|CLAUDE_.+)$/u.test(node.text),
        "credential-file, keychain or token literals must remain owned by the signed-in CLI");
    }
    node.forEachChild(visit);
  };
  visit(source);
  return violations;
}
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARENT_SECRETS = {
  ANTHROPIC_API_KEY: "fixture-parent-key",
  ANTHROPIC_AUTH_TOKEN: "fixture-parent-token",
  ANTHROPIC_BASE_URL: "https://proxy.example.test",
  anthropic_model: "fixture-parent-model",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture-parent-session",
  CLAUDE_CONFIG_DIR: "/home/example/.claude",
  claude_custom_token: "fixture-parent-custom-token",
};

class PolicyChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;

  close(): void {
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

const roots: string[] = [];
const children: PolicyChild[] = [];
const owners: Array<{ stop(): Promise<void> }> = [];
beforeEach(() => {
  vi.spyOn(locations, "assertCodexLocations").mockResolvedValue();
  vi.spyOn(locations, "assertCodexExecutableLocation").mockResolvedValue();
  vi.spyOn(locations, "createPrivateTempDirectory").mockImplementation((prefix) => fs.mkdtemp(prefix));
  vi.spyOn(managed, "forceKillManagedChildProcess").mockImplementation((child) => { child.kill(); });
  vi.spyOn(managed, "spawnManaged").mockImplementation(() => { throw new Error("Unexpected real process launch"); });
  for (const [key, value] of Object.entries(PARENT_SECRETS)) vi.stubEnv(key, value);
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const child of children.splice(0)) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "ave-subscription-policy-"));
  roots.push(root);
  const paths = { runtimeHome: join(root, "home"), workspaceDir: join(root, "workspace"), runtimeTempDir: join(root, "tmp") };
  await Promise.all(Object.values(paths).map((path) => fs.mkdir(path)));
  const executable = join(root, "installed-runtime");
  await fs.writeFile(executable, "fixture-runtime", { mode: 0o700 });
  const verify = vi.fn(async () => undefined);
  const artifact: ClaudeCodeExecutable = {
    executable, identity: "fixture-admitted-runtime", verify,
    discard: async () => undefined,
  };
  return { ...paths, artifact, verify };
}

function assertIsolatedSpawn(command: string, options: SpawnOptions, f: Awaited<ReturnType<typeof fixture>>, probe = false): void {
  expect(command).toBe(f.artifact.executable);
  expect(options.shell).toBe(false);
  expect(options.cwd).toBe(f.workspaceDir);
  const env = options.env!;
  const expectedHome = probe ? expect.stringContaining(join(f.runtimeTempDir, "probe-")) : f.runtimeHome;
  expect(env.HOME).toEqual(expectedHome);
  expect(env.CLAUDE_CONFIG_DIR).toBe(env.HOME);
  const providerKeys = Object.keys(env).filter((key) => /^(ANTHROPIC_|CLAUDE_)/iu.test(key));
  expect(providerKeys, "Only the host-created isolated config directory may use a provider-prefixed variable").toEqual(["CLAUDE_CONFIG_DIR"]);
  for (const value of Object.values(PARENT_SECRETS)) expect(Object.values(env)).not.toContain(value);
}

describe("subscription launch policy", () => {
  it("isolates every account command and signs in through the admitted binary's own command", async () => {
    const f = await fixture();
    const readFile = vi.spyOn(fs, "readFile");
    const copyFile = vi.spyOn(fs, "copyFile");
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: PolicyChild }> = [];
    const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      const child = new PolicyChild(); children.push(child);
      calls.push({ command, args, options, child });
      setImmediate(() => {
        if (args.includes("--version")) child.stdout.write("2.1.0 (Claude Code)\n");
        else if (args.includes("--help")) child.stdout.write("Commands:\n  login [options]\n  logout\n  status [options]\n");
        else if (args[1] === "status") child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro", accessToken: "fixture-cli-private-token" }));
        if (args[1] !== "login") child.close();
      });
      return child as unknown as ChildProcess;
    });
    const client = new ClaudeCodeSubscriptionClient({ ...f, spawn,
      candidates: () => [f.artifact.executable], resolveExecutable: async (candidate) => candidate,
      _pinExecutableForTest: async () => f.artifact,
    });
    owners.push(client);
    const status = await client.verify();
    expect(status.connection).toBe("connected");
    expect(JSON.stringify(status)).not.toContain("fixture-cli-private-token");
    expect(await client.verifiedRuntime()).toBe(f.artifact);
    await client.startBrowserLogin();
    const login = calls.find((call) => call.args[1] === "login")!;
    expect(login.args).toEqual(["auth", "login"]);
    login.child.close();
    await client.logout();
    expect(calls.map(({ args }) => args)).toEqual([
      ["--bare", "--version"], ["auth", "--help"], ["auth", "status"], ["auth", "login"], ["auth", "logout"],
    ]);
    for (const call of calls) assertIsolatedSpawn(call.command, call.options, f, call.args.includes("--version") || call.args.includes("--help"));
    expect(f.verify).toHaveBeenCalled();
    expect(readFile, "Account commands must not read credential files in the host").not.toHaveBeenCalled();
    expect(copyFile, "Account commands must not copy credential files in the host").not.toHaveBeenCalled();
  });

  it.each([
    ["plain script", "installed-script", false],
    ["command shim", "claude.cmd", false],
    ["package-managed script", "node_modules/@anthropic-ai/claude-code/cli.js", false],
    ["package-managed native binary", "node_modules/@anthropic-ai/claude-code/vendor/claude", true],
    ["platform package native binary", "node_modules/@anthropic-ai/claude-code-darwin-arm64/claude", true],
  ] as const)("refuses %s before account launch", async (_label, relativePath, native) => {
    const f = await fixture();
    const candidate = join(f.runtimeTempDir, relativePath);
    await fs.mkdir(join(candidate, ".."), { recursive: true });
    await fs.writeFile(candidate, native ? nativeExecutableBytes(process.platform) : "#!/usr/bin/env node\nfixture script\n", { mode: 0o700 });
    const spawn = vi.fn(() => { throw new Error("Rejected installation must not launch"); });
    const client = new ClaudeCodeSubscriptionClient({ ...f, spawn, candidates: () => [candidate], resolveExecutable: async (path) => path });
    owners.push(client);
    await expect(client.startBrowserLogin()).rejects.toMatchObject({ code: "claude-code-runtime-native-required" });
    expect(spawn).not.toHaveBeenCalled();
    expect(managed.spawnManaged).not.toHaveBeenCalled();
    expect(await fs.readdir(f.runtimeHome)).toEqual([]);
  });

  it.each([
    { model: undefined, tools: false },
    { model: "claude-sonnet-5-5", tools: false },
    { model: undefined, tools: true },
    { model: "claude-sonnet-5-5", tools: true },
  ])("uses only documented print flags at the conversation boundary ($model, tools=$tools)", async ({ model, tools }) => {
    const f = await fixture();
    const toolNames = tools ? ["mcp__ave-host-tools__read_project_file"] : [];
    const bridge = new SubscriptionToolBridge(tools ? [{ name: "read_project_file", description: "Read a file through the host", inputSchema: { type: "object", properties: {} } }] : []);
    vi.spyOn(bridge, "startMcpServer").mockResolvedValue({ name: "ave-host-tools", command: "/host/mcp", args: [], env: {} });
    const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      assertIsolatedSpawn(command, options, f);
      const config = args[args.indexOf("--mcp-config") + 1]!;
      expect(args).toEqual([
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--permission-mode", "default",
        "--strict-mcp-config", "--mcp-config", config, "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
        "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
        ...(model ? ["--model", model] : []),
        ...(tools ? ["--allowedTools", toolNames.join(",")] : []),
      ]);
      expect(config.startsWith(join(f.runtimeTempDir, "mcp-"))).toBe(true);
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ mcpServers: tools ? { "ave-host-tools": { command: "/host/mcp", args: [], env: {} } } : {} });
      const child = new PolicyChild(); children.push(child);
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID, tools: toolNames, mcp_servers: tools ? [{ name: "ave-host-tools", status: "connected" }] : [], plugins: [] })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: SESSION_ID })}\n`);
        child.close();
      });
      return child as unknown as ChildProcess;
    });
    const runtime = new ClaudeCodeConversationRuntime({ ...f, spawn, bridge,
      model, resolveRuntime: async () => f.artifact,
    });
    owners.push(runtime);
    const events = [];
    for await (const event of runtime.streamTurn("private user prompt")) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(f.runtimeTempDir)).toEqual([]);
  });

  it("locks the reviewed direct transport dependencies and credential capabilities", () => {
    const paths = Object.keys(TRANSPORT_IMPORTS).map((file) => fileURLToPath(new URL(`../${file}`, import.meta.url)));
    const sources = parseSourceFiles(paths);
    for (const path of paths) {
      const source = sources.get(path) as ts.SourceFile | undefined;
      if (!source) throw new Error(`Transport source was not parsed: ${path}`);
      const file = path.split(/[\\/]/u).at(-1)!;
      expect(transportPolicyViolations(source, file)).toEqual([]);
    }
  });

  it.each([
    ["neutral helper dependency", 'import { loadAccount } from "./account-state.js"; loadAccount();', "unreviewed dependency"],
    ["new helper from an existing dependency", 'import { loadAccount } from "./managed-child-processes.js";', "unreviewed imported capability"],
    ["direct token read", "const token = process.env.ANTHROPIC_API_KEY;", "parent environment may only enter"],
    ["computed token read", 'const token = process["env"]["ANTHROPIC_API_KEY"];', "computed runtime environment access"],
    ["generic inherited provider token", "const token = parentEnv.CLAUDE_CUSTOM_TOKEN;", "provider-prefixed environment values"],
    ["global environment alias", 'const token = globalThis["process"]["env"].TOKEN;', "global runtime aliases"],
    ["alternate runtime alias", "const runtime = Bun; const token = runtime.env.TOKEN;", "alternate runtime aliases"],
    ["global alternate runtime alias", "const runtime = globalThis.Bun;", "global runtime aliases"],
    ["approved cleanup name with a literal", 'class Client { async qualify() { const probeHome = "/home/example/.claude"; await fs.rm(probeHome); } }', "review path provenance"],
    ["approved cleanup name from the real home", 'class Client { async qualify() { const probeHome = join(homedir(), ".claude"); await fs.rm(probeHome); } }', "review path provenance"],
    ["approved cleanup name from another identifier", "class Client { async qualify() { const probeHome = sensitivePath; await fs.rm(probeHome); } }", "review path provenance"],
    ["approved executable name from another identifier", "async function resolveClaudeCodeSubscriptionExecutable() { const executable = sensitivePath; await fs.stat(executable); }", "review path provenance"],
    ["script helper dependency", 'import { copySubscriptionPackageArtifact } from "./subscription-package-artifact.js";', "unreviewed dependency"],
    ["interpreter prefix contract", "interface ClaudeCodeExecutable { executable: string; args: readonly string[]; identity: string; verify(): Promise<void>; discard(): Promise<void> }", "must not carry interpreter or loader prefix"],
    ["interpreter prefix at spawn", "const arguments = [...runtime.args];", "must not inject interpreter or loader"],
    ["environment alias", "const inherited = process.env;", "parent environment may only enter"],
    ["alternate runtime environment", "const token = Bun.env.TOKEN;", "alternate runtime environment"],
    ["retargeted cleanup", 'await fs.rm("/home/example/.claude");', "reviewed executable or isolated runtime operand"],
  ])("refuses a policy bypass: %s", (_label, text, reason) => {
    const source = parseSourceTexts(new Map([["transport-policy-case.ts", text]])).get("transport-policy-case.ts") as ts.SourceFile | undefined;
    if (!source) throw new Error("Policy refusal fixture did not parse");
    expect(transportPolicyViolations(source, "claude-code-subscription-client.ts").some((violation) => violation.includes(reason)), reason).toBe(true);
  });
});
