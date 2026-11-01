import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { appOwnedSandboxHomeRoot, cleanupAsrtSandboxAfterCommand, getBuiltinShellSessionReadPolicy, initializeAsrtSandbox, isAsrtSandboxActive, registerWorkerUnixSocketDir, resetAsrtSandbox, unregisterWorkerUnixSocketDir, useAppOwnedSandboxTempRoot } from "../../permissions/asrt-sandbox.js";
import * as sandboxWritePolicy from "../../permissions/sandbox-write-policy.js";
import { spawnConfinedChild } from "../../permissions/confined-child.js";
import { baseAllowedDirectories } from "../../permissions/base-allowed-directories.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setPluginWorkerConfinementRequestedAtBoot,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { requireSandboxCases } from "../../plugins/isolation/__tests__/sandbox-cases.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { BashTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";
import { buildSafeChildEnv } from "../safe-env.js";
import { TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";

let root: string;
let cwd: string;
let profile: string;
let sessions: string;

let transcript: string;
const CONTENT = "saved-session-native-fixture\n";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-read-shell-")));
  cwd = join(root, "workspace");
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  transcript = join(sessions, "conversation.jsonl");
  mkdirSync(cwd); mkdirSync(sessions, { recursive: true });
  writeFileSync(transcript, CONTENT);
  vi.stubEnv("HOME", root);
  vi.stubEnv("AVE_HOME", profile);
  vi.stubEnv("CLAUDE_CODE_TMPDIR", process.env.CLAUDE_CODE_TMPDIR);
  vi.stubEnv("CLAUDE_TMPDIR", process.env.CLAUDE_TMPDIR);
  // baseAllowedDirectories() grants os.tmpdir() as a write root, and the sandbox scans and sweeps write roots for repositories with
  // identity checks. The run's shared temp directory has concurrent repository churn from other test files, so this file grants a private one.
  const privateTmp = join(root, "tmp");
  mkdirSync(privateTmp);
  vi.stubEnv("TMPDIR", privateTmp);
  // These cases drive the host shell tools and a confined child, which are wrapped only while their scope was requested at boot.
  setShellSandboxRequestedAtBoot(true);
  setPluginWorkerConfinementRequestedAtBoot(true);
});
afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await cleanupTmpDir(root);
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("saved-session shell confinement", () => {
  it("reads default application history with the host bootstrap temp root", async (test) => {
    await requireSandboxCases(test);
    const defaultProfile = join(root, ".ave");
    const defaultSessions = sessionStorePath(defaultProfile);
    const defaultTranscript = join(defaultSessions, "conversation.jsonl");
    mkdirSync(defaultSessions, { recursive: true });
    writeFileSync(defaultTranscript, CONTENT);
    const ordinaryHomeFile = join(root, "private.txt");
    const nestedSecret = join(defaultSessions, ".env");
    writeFileSync(ordinaryHomeFile, "ordinary-home-fixture");
    writeFileSync(nestedSecret, "private-nested-fixture");
    const userData = join(root, "user-data");
    const protectedProject = join(userData, "project");
    const protectedFile = join(protectedProject, "private.txt");
    mkdirSync(protectedProject, { recursive: true });
    writeFileSync(protectedFile, "private-user-data-fixture");
    vi.stubEnv("AVE_HOME", defaultProfile);
    useAppOwnedSandboxTempRoot();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, userDataDir: userData });
    const command = "/bin/cat " + shellQuote(defaultTranscript);
    const read = await spawnWithSandbox(command, cwd, [cwd, ...baseAllowedDirectories()], 15, prepareSandboxFixture(command, cwd));
    expect(read.isError, read.output).toBe(false);
    expect(read.metadata.sandboxed).toBe(true);
    expect(read.output).toContain(CONTENT.trim());
    const ordinaryHomeCommand = "/bin/cat " + shellQuote(ordinaryHomeFile);
    const ordinaryHomeRead = await spawnWithSandbox(ordinaryHomeCommand, cwd, [cwd, ...baseAllowedDirectories()], 15, prepareSandboxFixture(ordinaryHomeCommand, cwd));
    expect(ordinaryHomeRead.isError, ordinaryHomeRead.output).toBe(false);
    expect(ordinaryHomeRead.metadata.sandboxed).toBe(true);
    expect(ordinaryHomeRead.output).toContain("ordinary-home-fixture");
    for (const path of [nestedSecret]) {
      const deniedCommand = "/bin/cat " + shellQuote(path);
      const denied = await spawnWithSandbox(deniedCommand, cwd, [cwd, ...baseAllowedDirectories()], 15, prepareSandboxFixture(deniedCommand, cwd));
      expect(denied.isError, denied.output).toBe(true);
      expect(denied.output).not.toContain("private-nested-fixture");
    }
    const writeCommand = "printf changed > " + shellQuote(defaultTranscript);
    const write = await spawnWithSandbox(writeCommand, cwd, [cwd, ...baseAllowedDirectories()], 15, prepareSandboxFixture(writeCommand, cwd));
    expect(write.isError, write.output).toBe(true);
    expect(readFileSync(defaultTranscript, "utf8")).toBe(CONTENT);
    const protectedCommand = "/bin/cat " + shellQuote(protectedFile);
    const protectedRead = await spawnWithSandbox(protectedCommand, protectedProject, [protectedProject, ...baseAllowedDirectories()], 15, prepareSandboxFixture(protectedCommand, protectedProject));
    expect(protectedRead.isError, protectedRead.output).toBe(true);
    expect(protectedRead.output).not.toContain("private-user-data-fixture");
  });

  it("preserves explicit workspace and private temporary writes after a broad root exhausts discovery", async (test) => {
    await requireSandboxCases(test);
    const entries = join(root, "broad-root-entries");
    mkdirSync(entries);
    for (let index = 0; index < 16_385; index++) writeFileSync(join(entries, String(index)), "");
    useAppOwnedSandboxTempRoot();
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const compose = vi.spyOn(sandboxWritePolicy, "buildMandatorySandboxWritePolicy");
    const command = [
      "printf workspace-written > workspace-result",
      'printf temporary-written > "$TMPDIR/private-result"',
      '/bin/cat workspace-result "$TMPDIR/private-result"',
      'printf "\\nprivate-temp:%s\\n" "$TMPDIR"',
    ].join("; ");
    const result = await spawnWithSandbox(command, cwd, [cwd, ...baseAllowedDirectories(), root], 15, prepareSandboxFixture(command, cwd));
    expect(result.isError, result.output).toBe(false);
    expect(result.metadata.sandboxed).toBe(true);
    expect(result.output).toContain("workspace-writtentemporary-written");
    expect(readFileSync(join(cwd, "workspace-result"), "utf8")).toBe("workspace-written");
    expect(compose).toHaveBeenCalledOnce();
    const composition = compose.mock.results[0]!;
    expect(composition.type).toBe("return");
    if (composition.type !== "return") throw new Error("Sandbox write policy did not return");
    const policy = composition.value;
    expect(policy.allowWrite).toContain(cwd);
    expect(policy.allowWrite).not.toContain(root);
    const privateTemporary = result.output.match(/private-temp:([^\r\n]+)/)?.[1];
    expect(privateTemporary).toBeDefined();
    // Each shell gets a private temp directory inside its private sandbox home.
    const privateHome = policy.allowWrite.find(path => privateTemporary?.startsWith(`${path}/shell-tmp-`));
    expect(privateHome).toBeDefined();
    expect(privateHome?.startsWith(`${appOwnedSandboxHomeRoot()}/`)).toBe(true);
    expect(existsSync(privateTemporary!)).toBe(false);
  }, 30_000);

  it("native sandbox reads configured history while preserving the write floor and neighboring denies", async (test) => {
    await requireSandboxCases(test);
    const neighbors = ["secrets", "audit", "routine"].map((namespace) => {
      const dir = join(profile, namespace); mkdirSync(dir);
      const path = join(dir, "private.jsonl"); writeFileSync(path, "private-neighbor-fixture");
      return path;
    });
    const sibling = join(profile, "ordinary.txt"); writeFileSync(sibling, "ordinary-neighbor-fixture");
    const nestedCredential = join(sessions, ".ssh", "id_rsa");
    mkdirSync(join(sessions, ".ssh")); writeFileSync(nestedCredential, "nested-credential-fixture");
    const nestedEnvironment = join(sessions, ".env"); writeFileSync(nestedEnvironment, "nested-credential-fixture");
    const escape = join(sessions, "escape.jsonl"); symlinkSync(neighbors[0]!, escape);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const run = (command: string, writes = [cwd]) => spawnWithSandbox(command, cwd, writes, 15, prepareSandboxFixture(command, cwd));
    const read = await run("/bin/cat " + shellQuote(transcript));
    expect(read.isError, read.output).toBe(false);
    expect(read.metadata.sandboxed).toBe(true);
    expect(read.output).toContain(CONTENT.trim());
    const siblingRead = await run("/bin/cat " + shellQuote(sibling));
    expect(siblingRead.isError, siblingRead.output).toBe(false);
    expect(siblingRead.metadata.sandboxed).toBe(true);
    expect(siblingRead.output).toContain("ordinary-neighbor-fixture");
    for (const denied of [...neighbors, escape, nestedCredential, nestedEnvironment]) {
      const result = await run("/bin/cat " + shellQuote(denied));
      expect(result.isError, result.output).toBe(true);
      expect(result.output).not.toContain("neighbor-fixture");
      expect(result.output).not.toContain("credential-fixture");
    }
    const moved = join(cwd, "moved.jsonl");
    const created = join(sessions, "new.jsonl");
    const transcriptIdentity = statSync(transcript).ino;
    for (const command of [
      "printf changed > " + shellQuote(transcript),
      "printf created > " + shellQuote(created),
      "/bin/rm " + shellQuote(transcript),
      "/bin/mv " + shellQuote(transcript) + " " + shellQuote(moved),
    ]) {
      // An existing broad write grant must not override saved-history integrity.
      const result = await run(command, [cwd, profile]);
      expect(result.isError, result.output).toBe(true);
    }
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
    expect(statSync(transcript).ino).toBe(transcriptIdentity);
    expect(existsSync(created)).toBe(false);
    if (process.platform === "linux") {
      // Across bubblewrap's separate mounts `mv` gets EXDEV and falls back to a copy before its unlink is refused. The copy is a granted read; the transcript itself must never move.
      if (existsSync(moved)) expect(statSync(moved).ino).not.toBe(transcriptIdentity);
    } else {
      // One filesystem, so `mv` is a rename the sandbox refuses outright.
      expect(existsSync(moved)).toBe(false);
    }
  });

  it("public BashTool reads a configured session under strict path scope", async (test) => {
    await requireSandboxCases(test);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "Native test sandbox initialized",
      confines: { filesystem: true, process: true, network: true },
    });
    const context = { cwd, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true, metadata: {} };
    const read = await new BashTool().execute({ command: "cat " + shellQuote(transcript), timeoutSeconds: 15 }, context);
    expect(read.isError, read.output).toBe(false);
    expect(read.metadata?.sandboxed).toBe(true);
    expect(read.output).toContain(CONTENT.trim());
    const write = await new BashTool().execute({ command: "printf changed > " + shellQuote(transcript), timeoutSeconds: 15 }, { ...context, extraAllowedDirectories: [profile] });
    expect(write.isError).toBe(true);
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
  });

  it("native sandbox grants builtin history reads without opening the same file to a confined child", async (test) => {
    await requireSandboxCases(test);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const command = "/bin/cat " + shellQuote(transcript);
    const builtin = await spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
    expect(builtin.isError, builtin.output).toBe(false);
    expect(builtin.output).toContain(CONTENT.trim());
    const ordinary = join(cwd, "ordinary.txt"); writeFileSync(ordinary, "ordinary-child-fixture");
    let wrapped = false;
    try {
      const { child, confinement } = await spawnConfinedChild({
        command: "/bin/cat", args: [ordinary, transcript], label: "session-read-confined-fixture",
        egressOwner: TEST_WORKER_EGRESS_OWNER,
        grantMode: "allow-list", tempPrincipal: { kind: "plugin", id: "session-read-fixture" },
        allowRead: [cwd, profile], allowWrite: [cwd], baseEnv: buildSafeChildEnv(),
        onWrapped: () => { wrapped = true; },
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          timer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
          child.once("error", reject);
          child.once("close", resolve);
        });
        const stdout = Buffer.concat(output).toString("utf8");
        expect(wrapped).toBe(true);
        expect(confinement).not.toBe("unconfined");
        expect(code, Buffer.concat(errors).toString("utf8")).toBe(1);
        expect(stdout).toContain("ordinary-child-fixture");
        expect(stdout).not.toContain(CONTENT.trim());
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      if (wrapped) await cleanupAsrtSandboxAfterCommand();
    }
  });

  it.for(["user-data", "custom-literal", "custom-glob"] as const)("native sandbox preserves %s protection over the configured session root", async (kind, test) => {
    await requireSandboxCases(test);
    const denyRead = kind === "custom-literal" ? [profile] : kind === "custom-glob" ? [`${root}/configured-*`] : [];
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead,
      ...(kind === "user-data" ? { userDataDir: profile } : {}),
    });
    expect(getBuiltinShellSessionReadPolicy().allowRead).toEqual([]);
    expect(getBuiltinShellSessionReadPolicy().denyRead).toEqual(expect.arrayContaining(denyRead));
    const command = "/bin/cat " + shellQuote(transcript);
    const result = await spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
    expect(result.isError, result.output).toBe(true);
    expect(result.output).not.toContain(CONTENT.trim());
  });

  // A registered worker socket turns on `allowAllUnixSockets` on Linux, which takes the seccomp helper out of the chain; ASRT 0.0.81 then asks bubblewrap 0.8+ for
  // `--disable-userns` . Every shell wrap after a worker starts carries that wrap shape, so it must still run, and a command inside it must not get a user namespace of its own.
  it("runs a sandboxed shell after a worker socket is registered", async (test) => {
    await requireSandboxCases(test);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const socketDir = join(root, "worker-sockets");
    mkdirSync(socketDir);
    const holder = {};
    await registerWorkerUnixSocketDir(socketDir, holder);
    try {
      const run = (command: string) => spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
      const read = await run("/bin/cat " + shellQuote(transcript));
      expect(read.isError, read.output).toBe(false);
      expect(read.metadata.sandboxed).toBe(true);
      expect(read.output).toContain(CONTENT.trim());
      const bwrapHelp = process.platform === "linux" ? spawnSync("bwrap", ["--help"], { encoding: "utf8" }) : undefined;
      const unshare = ["/usr/bin/unshare", "/bin/unshare"].find((path) => existsSync(path));
      if (bwrapHelp !== undefined && `${bwrapHelp.stdout}${bwrapHelp.stderr}`.includes("--disable-userns") && unshare !== undefined) {
        const nested = await run(`${unshare} -U /bin/true && echo nested-userns-created`);
        expect(nested.output).not.toContain("nested-userns-created");
      }
    } finally {
      await unregisterWorkerUnixSocketDir(socketDir, holder);
    }
  });
});
