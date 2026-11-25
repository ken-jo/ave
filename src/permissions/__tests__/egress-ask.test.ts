vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// The egress ask callback's decision table (egress-ask.ts): who opened the connection decides whether it is allowed outright, refused, or asked about, and every answer is the literal `true` or a deny with a reason, with one audit row each.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxAskCallback, SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import type { SandboxEgressDecisionAuditEntry } from "../../audit/sandbox-audit.js";
import {
  egressAllowlistMatches,
  EGRESS_DENY_REASONS,
  type EgressApprovalRequest,
  type EgressApprovalAnswer,
} from "../egress-ask.js";
import { createEgressAskCallback, type EgressAskDeps } from "../../__tests__/support/egress-permission.js";
import { fixtureSecret } from "../../audit/__tests__/secret-fixtures.js";
import { EgressGrantStore, egressDestinationNetwork } from "../egress-grants.js";
import type { EgressIdentityStrength } from "../../shared/sandbox-capability-info.js";
import type { EgressInvocationOwner, ShellEgressOwner } from "../egress-invocations.js";
import { egressIdentityStrength, noteAsrtUnixSocketPolicy } from "../egress-identity.js";
import * as denyMonitor from "../egress-deny-monitor.js";
import * as terminalObservation from "../../tools/agent-terminal-observation.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { EGRESS_GRANT_SCOPE_LADDERS } from "../../shared/egress-grant-scopes.js";
import { _resetAveHomePrivacyForTest, ensureAveHomePrivate, setAveHomeConfigurationRefusedAtBoot } from "../../shared/ave-home.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { createShellNetworkPermissionEvaluator } from "../egress-approval.js";
import { PermissionManager } from "../permission-manager.js";
import { deferred } from "../../__tests__/support/deferred.js";
import * as projectRuleFiles from "../rules/project-rule-files.js";
import * as featureNamespace from "../../main/storage/feature-namespace.js";

it("applies the same deny fence to held and directly resolved shell answers", () => {
  const source = readFileSync(new URL("../egress-ask.ts", import.meta.url), "utf8");
  expect(source.match(/grantAnswer\([^\n]+checkDeny\)/g)).toHaveLength(2);
  expect(source).toMatch(/isCurrent: \(\) => .*checkDeny\(\) === undefined/);
});
import { configureHostResources } from "../../main/host-resources.js";
import { setAveHomeConfigurationOwner } from "../../shared/ave-home-configuration-access.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { requireSymlinkCapability } from "../../__tests__/support/symlink-capability.js";
import { migrateAveHomeConfiguration } from "../../shared/ave-home-configuration.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { _resetAveHomeTrustForTest, evaluateAveHomeTrustAtBoot, readAveHomeInputSync } from "../../shared/ave-home-trust.js";

const matchingScopes = Object.values(EGRESS_GRANT_SCOPE_LADDERS).flat();

// Real git checkouts: a shell call's "This project" keys on the repository root of its working directory (projectRuleRoot), so the owner contexts name directories that resolve.
function gitCheckout(root: string): string {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "ave-egress-ask-work-")));
const PROJECT = gitCheckout(join(WORK, "project"));
const PROJECT_SUBDIR = join(PROJECT, "packages", "app");
mkdirSync(PROJECT_SUBDIR, { recursive: true });
const OTHER = gitCheckout(join(WORK, "other"));
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

const SHELL_TOKEN = "5".repeat(32);
const WORKER_TOKEN = "6".repeat(32);
const TERMINAL_TOKEN = "7".repeat(32);
const OTHER_SHELL_TOKEN = "8".repeat(32);
const OTHER_TERMINAL_TOKEN = "9".repeat(32);
const TERMINAL_TAB = "terminal:0a1b2c3d-1";
const OTHER_TERMINAL_TAB = "terminal:0a1b2c3d-2";

const interactiveShell: ShellEgressOwner = {
  kind: "shell",
  toolName: "bash",
  toolUseId: "toolu_1",
  context: { sessionId: "session-1", workspaceRoot: PROJECT, approvalSurface: "interactive" },
};

// A connection as ASRT decides it: who, and what the destination resolved to.
interface Connection {
  attributionKey: string | undefined;
  identity: "listener" | "username";
  addresses: readonly string[];
  resolution: "pinned" | "upstream";
}

const listener = (
  token: string,
  addresses: readonly string[] = [],
  resolution: Connection["resolution"] = "pinned",
): Connection => ({ attributionKey: token, identity: "listener", addresses, resolution });

// Both phases of one connection, the way the patched ASRT calls them: the name phase first, and the resolved phase only after its `true`.
function bothPhases(raw: SandboxAskCallback) {
  return async (params: { host: string; port: number | undefined }, connection: Connection | undefined) => {
    if (connection === undefined) return raw(params, undefined);
    const { addresses, resolution, ...who } = connection;
    const byName = await raw(params, { ...who, phase: "name" });
    if (byName !== true) return byName;
    return raw(params, { ...who, phase: "resolved", addresses, resolution });
  };
}

let dir: string;
let grants: EgressGrantStore;
let owners: Map<string, EgressInvocationOwner>;
let audit: SandboxEgressDecisionAuditEntry[];
let asked: EgressApprovalRequest[];
let answer: (request: EgressApprovalRequest) => Promise<EgressApprovalAnswer>;
let strength: EgressIdentityStrength;
let askEnabled: boolean;
let requesterPresent: boolean;
let networkRule: EgressAskDeps["networkRule"];
const signals = new Map<string, AbortSignal>();

function rawCallback(identityStrength: EgressAskDeps["identityStrength"] = () => strength, evaluateShellPermission?: EgressAskDeps["evaluateShellPermission"]) {
  return createEgressAskCallback({
    identityStrength,
    ownerOf: (token) => owners.get(token),
    abortSignalOf: (token) => signals.get(token),
    workerAllowedDomains: (pluginId) => (pluginId === "fixture_plugin" ? ["api.fixture.example", "*.cdn.example:443"] : []),
    grants,
    networkRule: (subject) => networkRule(subject),
    evaluateShellPermission,
    shellAskEnabled: () => askEnabled,
    requester: () => (requesterPresent
      ? async (request) => {
          asked.push(request);
          return answer(request);
        }
      : undefined),
    audit: (entry) => audit.push(entry),
    now: () => new Date("2026-10-19T00:00:00.000Z"),
  });
}

function callback() {
  return bothPhases(rawCallback());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-egress-ask-"));
  grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
  owners = new Map<string, EgressInvocationOwner>([
    [SHELL_TOKEN, interactiveShell],
    [OTHER_SHELL_TOKEN, { ...interactiveShell, toolUseId: "toolu_2" }],
    [WORKER_TOKEN, { kind: "worker", role: "worker", pluginId: "fixture_plugin", instanceId: "w1" }],
    [TERMINAL_TOKEN, { kind: "terminal", tabId: TERMINAL_TAB }],
    [OTHER_TERMINAL_TOKEN, { kind: "terminal", tabId: OTHER_TERMINAL_TAB }],
  ]);
  audit = [];
  asked = [];
  answer = async () => ({ allow: false, reason: "denied by the user" });
  strength = "kernel-channel";
  askEnabled = true;
  requesterPresent = true;
  networkRule = async () => undefined;
  signals.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("egress ask callback — refused home folder", () => {
  it("allows a persistent answer once when boot refused the home folder, and asks again next time", async () => {
    setAveHomeConfigurationRefusedAtBoot(dir);
    try {
      const ask = callback();
      answer = async () => ({ allow: true, scope: "always" });
      expect(await ask({ host: "pypi.org", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
      expect(audit.at(-1)).toMatchObject({ decision: "allow", scope: "once" });
      answer = async () => ({ allow: false, reason: "denied by the user" });
      expect(await ask({ host: "pypi.org", port: 443 }, listener(OTHER_SHELL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
      expect(asked).toHaveLength(2);
      expect(await grants.listPersistent()).toEqual([]);
    } finally {
      _resetAveHomePrivacyForTest();
    }
  });
});

describe("egress ask callback — attribution", () => {
  // The identity is judged first only so that the refusal is attributed to a verified worker alone.
  it("refuses offline service destinations before grants, routing or endpoint allowlists, attributed only to a verified worker", async () => {
    owners.set(WORKER_TOKEN, { kind: "worker", role: "worker", pluginId: undefined, network: "offline" });
    const allowlist = vi.fn(() => ["*"]);
    const identity = vi.fn(() => "kernel-channel" as const);
    const rule = vi.fn(async () => ({ decision: "allow" as const, pattern: "Network(*)", scope: "user" as const }));
    const ask = createEgressAskCallback({
      identityStrength: identity, ownerOf: token => owners.get(token), abortSignalOf: () => undefined,
      workerAllowedDomains: allowlist, grants, networkRule: rule, shellAskEnabled: () => true,
      requester: () => async request => { asked.push(request); return { allow: true, scope: "always" }; },
      audit: entry => audit.push(entry),
    });
    expect(await ask({ host: "model.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "listener", phase: "name" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.offline });
    expect(await ask({ host: "model.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", phase: "name" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(allowlist).not.toHaveBeenCalled();
    expect(rule).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(audit.map((row) => [row.reason, row.invocation.kind])).toEqual([
      [EGRESS_DENY_REASONS.offline, "worker"],
      [EGRESS_DENY_REASONS.unattributed, "unattributed"],
    ]);
  });

  it("distinguishes host-owned listeners from shared labels and terminal scope", async () => {
    const platform = process.platform;
    setProcessPlatform("win32");
    answer = async () => ({ allow: true, scope: "once" });
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: egressIdentityStrength,
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => [],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => async (request) => { asked.push(request); return answer(request); },
      audit: () => {},
    }));
    try {
      expect(egressIdentityStrength("shell", { identity: "listener" })).toBe("kernel-channel");
      expect(egressIdentityStrength("shell", { identity: "username" })).toBe("shared");
      expect(egressIdentityStrength("shell")).toBe("shared");
      expect(egressIdentityStrength("extension", { identity: "listener" })).toBe("kernel-channel");
      expect(egressIdentityStrength("extension", { identity: "username" })).toBe("shared");
      expect(egressIdentityStrength("extension")).toBe("shared");
      expect(await ask({ host: "one.example", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
      expect(await ask({ host: "two.example", port: 443 }, { ...listener(OTHER_SHELL_TOKEN), identity: "username" })).toBe(true);
      expect(await ask({ host: "three.example", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
      expect(asked.map((request) => request.scopes)).toEqual([
        ["once", "session", "project", "always"],
        ["once", "session"],
        ["once", "tab"],
      ]);
    } finally {
      setProcessPlatform(platform);
    }
  });

  it("denies without asking when the connection names no invocation, an unknown one, or only a username on a kernel-channel host", async () => {
    const ask = callback();
    expect(await ask({ host: "example.com", port: 443 }, { attributionKey: undefined, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await ask({ host: "example.com", port: 443 }, undefined))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    // A key that names nobody, or that it refused, is not handed back for the proxy's own record either.
    expect(await ask({ host: "example.com", port: 443 }, listener("f".repeat(32))))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    // A live shell's key presented on the shared front end: it may have been read off that shell, so it vouches for nobody.
    expect(await ask({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(asked).toEqual([]);
    expect(audit.map((row) => [row.decision, row.basis, row.invocation])).toEqual([
      ["deny", "policy", { kind: "unattributed" }],
      ["deny", "policy", { kind: "unattributed" }],
      ["deny", "policy", { kind: "unattributed" }],
      ["deny", "policy", { kind: "unattributed" }],
    ]);
  });

  it("accepts a username identity only where the identity is shared (Windows until its kernel channel lands)", async () => {
    strength = "shared";
    const ask = callback();
    expect(await ask({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toBe(true);
  });

  it("judges the identity by the kind of process (Windows: MXC shells, srt-win extensions)", async () => {
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: (kind) => (kind === "shell" ? "kernel-channel" : "shared"),
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => ["api.fixture.example"],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: () => {},
    }));
    expect(await ask({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
  });

  it("denies a malformed destination", async () => {
    const ask = callback();
    expect(await ask({ host: "exa mple.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(await ask({ host: "example.com", port: 0 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(await ask({ host: "example.com", port: undefined }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(asked).toEqual([]);
  });
});

describe.each(["win32", "darwin"] as const)("egress grant reuse after %s identity changes", (platform) => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
    setProcessPlatform(platform);
    noteAsrtUnixSocketPolicy(false);
  });

  afterEach(() => {
    noteAsrtUnixSocketPolicy(false);
    setProcessPlatform(originalPlatform);
  });

  it.each(["project", "always"] as const)("rechecks a persisted %s grant against the current identity", async (scope) => {
    const destination = { host: "github.com", port: 443 };
    const strongAsk = bothPhases(rawCallback(egressIdentityStrength));
    answer = async () => ({ allow: true, scope });
    expect(await strongAsk(destination, listener(SHELL_TOKEN))).toBe(true);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "prompt", scope });
    const persisted = await grants.listPersistent();

    // Reload the real store as on restart, with another live shell invocation.
    grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2" } });
    const handleProxyAsk = bothPhases(rawCallback(egressIdentityStrength));
    noteAsrtUnixSocketPolicy(platform === "darwin");
    const weak = { ...listener(OTHER_SHELL_TOKEN), identity: platform === "win32" ? "username" as const : "listener" as const };
    askEnabled = false;
    const beforeDisabled = asked.length;
    expect(await handleProxyAsk(destination, weak)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(asked).toHaveLength(beforeDisabled);
    askEnabled = true;
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await handleProxyAsk(destination, weak)).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked.at(-1)?.scopes).toEqual(["once", "session"]);
    expect(audit.at(-1)).toMatchObject({ decision: "deny", basis: "prompt", scope: null });

    // The stored grant remains usable when the channel is strong again.
    noteAsrtUnixSocketPolicy(false);
    const beforeStrong = asked.length;
    expect(await handleProxyAsk(destination, listener(OTHER_SHELL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(beforeStrong);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "grant", scope });
    expect(await grants.listPersistent()).toEqual(persisted);

    // A narrower grant still covers this conversation on the shared channel.
    noteAsrtUnixSocketPolicy(platform === "darwin");
    answer = async () => ({ allow: true, scope: "session" });
    expect(await handleProxyAsk(destination, weak)).toBe(true);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "prompt", scope: "session" });
    const beforeReuse = asked.length;
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await handleProxyAsk(destination, weak)).toBe(true);
    expect(asked).toHaveLength(beforeReuse);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "grant", scope: "session" });
    expect(await handleProxyAsk(destination, { ...weak, attributionKey: SHELL_TOKEN }))
      .toEqual({ allow: false, reason: "denied by the user" });
  });

  it("preserves tab ownership and the terminal origin when a persistent grant cannot be reused", async () => {
    const destination = { host: "github.com", port: 443 };
    const terminalSubject = {
      token: TERMINAL_TOKEN, sessionId: undefined, tabId: TERMINAL_TAB, projectRoot: undefined, origin: "terminal" as const,
    };
    await grants.grant("always", ["once", "tab", "always"], terminalSubject, destination);
    const handleProxyAsk = bothPhases(rawCallback(egressIdentityStrength));
    noteAsrtUnixSocketPolicy(platform === "darwin");
    answer = async () => ({ allow: true, scope: "tab" });
    expect(await handleProxyAsk(destination, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked.at(-1)?.scopes).toEqual(["once", "tab"]);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "prompt", scope: "tab" });
    const beforeReuse = asked.length;
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await handleProxyAsk(destination, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(beforeReuse);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "grant", scope: "tab" });
    expect(await handleProxyAsk(destination, listener(OTHER_TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });

    noteAsrtUnixSocketPolicy(false);
    expect(await handleProxyAsk(destination, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    if (platform === "darwin") {
      const beforeStrong = asked.length;
      expect(await handleProxyAsk(destination, listener(OTHER_TERMINAL_TOKEN))).toBe(true);
      expect(asked).toHaveLength(beforeStrong);
      expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "grant", scope: "always" });
    }
  });
});

describe("egress ask callback — plugin workers", () => {
  it("allows the extension's own hosts and denies every other host without asking", async () => {
    const ask = callback();
    expect(await ask({ host: "API.Fixture.Example.", port: 443 }, listener(WORKER_TOKEN))).toBe(true);
    expect(await ask({ host: "a.cdn.example", port: 443 }, listener(WORKER_TOKEN))).toBe(true);
    expect(await ask({ host: "a.cdn.example", port: 80 }, listener(WORKER_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
    expect(await ask({ host: "github.com", port: 443 }, listener(WORKER_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
    expect(asked).toEqual([]);
    expect(audit.map((row) => [row.decision, row.basis])).toEqual([
      ["allow", "extension-allowlist"],
      ["allow", "extension-allowlist"],
      ["deny", "policy"],
      ["deny", "policy"],
    ]);
  });

  it("never lets a shell grant reach a worker (I4)", async () => {
    await grants.grant("always", ["once", "session", "project", "always"], {
      token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const,
    }, { host: "github.com", port: 443 });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(WORKER_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
  });

  it("denies a worker no extension owns everything but the model endpoints", async () => {
    owners.set(WORKER_TOKEN, { kind: "worker", role: "worker", pluginId: undefined });
    const ask = callback();
    expect(await ask({ host: "api.fixture.example", port: 443 }, listener(WORKER_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
  });
});

describe("egress ask callback — workspace terminal tab (design F)", () => {
  // Lets the callback's real-I/O steps (the grant file read) run while setTimeout is faked.
  async function untilAsked(count: number): Promise<void> {
    for (let i = 0; i < 1000 && asked.length < count; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toHaveLength(count);
  }

  // An answer that only comes when the ask is ended (the banner timed out or the tab closed).
  const answerOnlyOnAbort = (request: EgressApprovalRequest): Promise<EgressApprovalAnswer> =>
    new Promise((resolve) => {
      request.abortSignal?.addEventListener("abort", () => resolve({ allow: false, reason: "network approval answer was rejected" }), { once: true });
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks in the tab with This tab in place of This session, always (a terminal is never background)", async () => {
    const ask = callback();
    expect(await ask({ host: "GitHub.com", port: 443 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      origin: "terminal",
      tabId: TERMINAL_TAB,
      destination: { host: "github.com", port: 443 },
      scopes: ["once", "tab", "always"],
      network: "public",
    });
    expect(asked[0]).not.toHaveProperty("sessionId");
    expect(audit.at(-1)).toMatchObject({
      entryKind: "egress-decision",
      invocation: { kind: "terminal", tabId: TERMINAL_TAB },
      destination: { host: "GitHub.com", port: 443 },
      decision: "deny",
      basis: "prompt",
      scope: null,
      reason: "denied by the user",
    });
  });

  it.each([
    ["public", "github.com", [], "pinned", ["once", "tab", "always"]],
    ["local (loopback)", "127.0.0.1", [], "pinned", ["once", "tab"]],
    ["local (RFC 1918 by resolution)", "nas.corp.example", ["10.20.30.40"], "pinned", ["once", "tab"]],
    ["local (local-network name)", "printer.local", [], "upstream", ["once", "tab"]],
    ["unverified (the upstream resolves the name)", "intranet.corp.test", [], "upstream", ["once", "tab"]],
  ] as const)("offers the %s class exactly its scopes", async (_label, host, addresses, resolution, scopes) => {
    // Allowed by name (the class the name says), the banner is shown again when the resolution gives another class; the last banner is that class.
    answer = async () => ({ allow: true, scope: "once" });
    await callback()({ host, port: 8443 }, listener(TERMINAL_TOKEN, addresses, resolution));
    const byName = egressDestinationNetwork(host) === _label.split(" ")[0];
    expect(asked).toHaveLength(byName ? 1 : 2);
    expect(asked.at(-1)?.scopes).toEqual(scopes);
    expect(asked.at(-1)?.network).toBe(_label.split(" ")[0]);
  });

  it("refuses a reserved address without a banner, and a name that resolves to one after its banner by name", async () => {
    answer = async () => ({ allow: true, scope: "once" });
    expect(await callback()({ host: "169.254.169.254", port: 80 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(asked).toEqual([]);
    expect(await callback()({ host: "meta.example", port: 80 }, listener(TERMINAL_TOKEN, ["169.254.169.254"])))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(asked.map((request) => [request.destination.host, request.network])).toEqual([["meta.example", "public"]]);
    expect(audit.map((row) => [row.decision, row.basis, row.invocation])).toEqual([
      ["deny", "policy", { kind: "terminal", tabId: TERMINAL_TAB }],
      ["deny", "policy", { kind: "terminal", tabId: TERMINAL_TAB }],
    ]);
  });

  it("caps a terminal at This tab where the identity is shared", async () => {
    strength = "shared";
    await callback()({ host: "github.com", port: 443 }, { attributionKey: TERMINAL_TOKEN, identity: "username", addresses: [], resolution: "pinned" });
    expect(asked[0]?.scopes).toEqual(["once", "tab"]);
  });

  it("This tab covers later connections from that tab only, and an audit row names the scope", async () => {
    answer = async () => ({ allow: true, scope: "tab" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(audit.map((row) => [row.decision, row.basis, row.scope, row.invocation])).toEqual([
      ["allow", "prompt", "tab", { kind: "terminal", tabId: TERMINAL_TAB }],
      ["allow", "grant", "tab", { kind: "terminal", tabId: TERMINAL_TAB }],
    ]);
    expect(grants.listTab()).toEqual([
      { scope: "tab", tabId: TERMINAL_TAB, host: "github.com", port: 443, network: "public", grantedAt: expect.any(String) },
    ]);
    // Another tab, and a shell call in the same workspace, are asked again.
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_TERMINAL_TOKEN))).not.toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).not.toBe(true);
    expect(asked).toHaveLength(3);
  });

  it("a conversation grant never covers a terminal, and a terminal's Always never covers a shell call, nor the reverse", async () => {
    await grants.grant("session", ["session"], { token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "github.com", port: 443 });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    // Always from the terminal's banner: every terminal tab, no shell call.
    answer = async () => ({ allow: true, scope: "always" });
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(OTHER_TERMINAL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(2);
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(SHELL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(3);
    // Always and This project from a shell call's card: no terminal tab.
    answer = async () => ({ allow: true, scope: "always" });
    expect(await ask({ host: "pypi.org", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    answer = async () => ({ allow: true, scope: "project" });
    expect(await ask({ host: "crates.io", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "pypi.org", port: 443 }, listener(TERMINAL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "crates.io", port: 443 }, listener(TERMINAL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(7);
    expect((await grants.listPersistent()).map((grant) => [grant.scope, grant.origin, grant.host])).toEqual([
      ["always", "terminal", "registry.npmjs.org"],
      ["always", "shell", "pypi.org"],
      ["project", "shell", "crates.io"],
    ]);
  });

  it("Allow once lets exactly one connection through and is never held: the next connection asks again", async () => {
    answer = async () => ({ allow: true, scope: "once" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(2);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([
      ["allow", "prompt", "once"],
      ["deny", "prompt", null],
    ]);
    expect(grants.listTab()).toEqual([]);
    expect(await grants.listPersistent()).toEqual([]);
  });

  it("a local destination's This tab grant is offered and kept; a persistent grant never covers it", async () => {
    await grants.grant("always", ["always"], { token: TERMINAL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "terminal" as const },
      { host: "127.0.0.1", port: 8080 });
    answer = async () => ({ allow: true, scope: "tab" });
    const ask = callback();
    expect(await ask({ host: "127.0.0.1", port: 8080 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(await ask({ host: "127.0.0.1", port: 8080 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ decision: "allow", basis: "grant", scope: "tab" });
  });

  it("folds concurrent connections to one destination from one tab into one banner; other destinations ask on their own", async () => {
    const requestKey = (tabId: string, host: string) => `${tabId}\n${host}`;
    const releases = new Map<string, (value: EgressApprovalAnswer) => void>();
    answer = (request) => new Promise((resolve) => {
      if (request.origin !== "terminal") throw new Error("Expected a terminal approval");
      releases.set(requestKey(request.tabId, request.destination.host), resolve);
    });
    const respond = (tabId: string, host: string, value: EgressApprovalAnswer) => {
      const key = requestKey(tabId, host);
      const release = releases.get(key);
      expect(release).toBeTypeOf("function");
      releases.delete(key);
      release!(value);
    };
    const ask = callback();
    const otherHost = ask({ host: "registry.npmjs.org", port: 443 }, listener(TERMINAL_TOKEN));
    const otherTab = ask({ host: "github.com", port: 443 }, listener(OTHER_TERMINAL_TOKEN));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    const first = ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    const second = ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    const third = ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    await vi.waitFor(() => expect(asked).toHaveLength(3));
    expect([...releases.keys()].sort()).toEqual([
      requestKey(TERMINAL_TAB, "github.com"),
      requestKey(TERMINAL_TAB, "registry.npmjs.org"),
      requestKey(OTHER_TERMINAL_TAB, "github.com"),
    ].sort());
    // Allow once on the shared banner lets one of the three through; the other two fold into the next banner, whose This tab covers both.
    respond(TERMINAL_TAB, "github.com", { allow: true, scope: "once" });
    respond(TERMINAL_TAB, "registry.npmjs.org", { allow: false, reason: "denied by the user" });
    respond(OTHER_TERMINAL_TAB, "github.com", { allow: false, reason: "denied by the user" });
    await vi.waitFor(() => expect(asked).toHaveLength(4));
    expect(asked[3]).toMatchObject({ origin: "terminal", tabId: TERMINAL_TAB, destination: { host: "github.com", port: 443 } });
    expect([...releases.keys()]).toEqual([requestKey(TERMINAL_TAB, "github.com")]);
    respond(TERMINAL_TAB, "github.com", { allow: true, scope: "tab" });
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(await otherHost).toEqual({ allow: false, reason: "denied by the user" });
    expect(await otherTab).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(4);
    expect(audit.filter((row) => row.destination.host === "github.com" && row.invocation?.kind === "terminal" && (row.invocation as { tabId: string }).tabId === TERMINAL_TAB)
      .map((row) => [row.decision, row.basis, row.scope]).sort()).toEqual([
      ["allow", "prompt", "once"],
      ["allow", "prompt", "tab"],
      ["allow", "prompt", "tab"],
    ]);
  });

  it("denies after 120 s without an answer, with the timeout reason, and a later connection asks again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    answer = answerOnlyOnAbort;
    const ask = callback();
    let settled: unknown;
    const pending = ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN)).then((value) => { settled = value; return value; });
    await untilAsked(1);
    const signal = asked[0]!.abortSignal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBeUndefined();
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.terminalTimeout });
    expect(signal.aborted).toBe(true);
    expect(audit.at(-1)).toMatchObject({
      invocation: { kind: "terminal", tabId: TERMINAL_TAB },
      decision: "deny",
      basis: "prompt",
      reason: EGRESS_DENY_REASONS.terminalTimeout,
    });
    // The coalesced ask is gone: the next connection gets a new banner.
    void ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    await untilAsked(2);
  });

  it("an answer before the deadline wins and clears the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    answer = async () => ({ allow: true, scope: "once" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing the tab ends its banner at once, not at the timeout, and its refusal is not the closed tab's", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tab = new AbortController();
    signals.set(TERMINAL_TOKEN, tab.signal);
    answer = answerOnlyOnAbort;
    const pending = callback()({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    await untilAsked(1);
    tab.abort(new Error("terminal tab closed"));
    const result = await pending;
    expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny", reason: EGRESS_DENY_REASONS.unattributed });
    expect(result).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can take a shorter deadline (the native acceptance test's)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    answer = answerOnlyOnAbort;
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: () => "kernel-channel",
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => [],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => async (request) => { asked.push(request); return answer(request); },
      audit: () => {},
      terminalAskTimeoutMs: 2_000,
    }));
    const pending = ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    await untilAsked(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.terminalTimeout });
  });

  it("denies without a banner when asks are off, but keeps granted hosts", async () => {
    await grants.grant("tab", ["tab"], { token: TERMINAL_TOKEN, sessionId: undefined, tabId: TERMINAL_TAB, projectRoot: undefined, origin: "terminal" as const },
      { host: "registry.npmjs.org", port: 443 });
    askEnabled = false;
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(TERMINAL_TOKEN))).toBe(true);
    expect(asked).toEqual([]);
  });

  it("fails closed when no approval surface exists or the answer names a scope the banner did not offer", async () => {
    requesterPresent = false;
    expect(await callback()({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.noSurface });
    requesterPresent = true;
    answer = async () => ({ allow: true, scope: "session" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.failed}: egress grant: scope session was not offered` });
  });

  it("refuses a terminal identity that only the proxy username vouches for on a kernel-channel host", async () => {
    expect(await callback()({ host: "github.com", port: 443 }, { attributionKey: TERMINAL_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(asked).toEqual([]);
  });
});

describe("egress ask callback — shell calls", () => {
  it("asks for an ungranted host with every scope, and denies on the person's deny", async () => {
    const ask = callback();
    expect(await ask({ host: "GitHub.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toEqual([{
      evaluation: expect.objectContaining({ permission: expect.objectContaining({ decision: "ask" }) }),
      origin: "shell",
      headless: false,
      ownerUnattended: false,
      approvalSurface: "interactive",
      workspaceRoot: PROJECT,
      sessionId: "session-1",
      toolName: "bash",
      toolUseId: "toolu_1",
      destination: { host: "github.com", port: 443 },
      scopes: ["once", "session", "project", "always"],
      network: "public",
      abortSignal: undefined,
    }]);
    expect(audit.at(-1)).toMatchObject({
      entryKind: "egress-decision",
      invocation: { kind: "shell", toolName: "bash", toolUseId: "toolu_1" },
      destination: { host: "GitHub.com", port: 443 },
      decision: "deny",
      basis: "prompt",
      scope: null,
      reason: "denied by the user",
    });
  });

  it("caps the scopes at This session where the identity is shared", async () => {
    strength = "shared";
    const ask = callback();
    await ask({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "username", addresses: [], resolution: "pinned" });
    expect(asked[0]?.scopes).toEqual(["once", "session"]);
  });

  it("offers only the scopes the call can hold", async () => {
    owners.set(SHELL_TOKEN, {
      ...interactiveShell,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "interactive" },
    });
    const ask = callback();
    await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    expect(asked[0]?.scopes).toEqual(["once", "always"]);
  });

  it("Allow once covers that call only and ends with it", async () => {
    answer = async () => ({ allow: true, scope: "once" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([
      ["allow", "prompt", "once"],
      ["allow", "grant", "once"],
    ]);
    // Another call in the same conversation is asked again; so is another port.
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
    expect(await ask({ host: "github.com", port: 22 }, listener(SHELL_TOKEN))).not.toBe(true);
    grants.releaseToken(SHELL_TOKEN);
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).not.toBe(true);
    expect(asked).toHaveLength(4);
  });

  it("This session covers every call in that conversation, not another conversation", async () => {
    answer = async () => ({ allow: true, scope: "session" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2" } });
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
  });

  it("This project covers calls in that workspace from any conversation, and persists", async () => {
    answer = async () => ({ allow: true, scope: "project" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2" } });
    // A fresh store (an app restart) reads the grant back from disk.
    grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    answer = async () => ({ allow: false, reason: "denied by the user" });
    const restarted = callback();
    expect(await restarted({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, workspaceRoot: OTHER } });
    expect(await restarted({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
  });

  it("offers the owner's five choices on a kernel-channel host and keys This project on the repository root", async () => {
    // Owner 2026-10-25 (five-choice network card): Deny plus once, session, project and always; no once/always cap.
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, workspaceRoot: PROJECT_SUBDIR } });
    answer = async () => ({ allow: true, scope: "project" });
    expect(await callback()({ host: "pypi.org", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(asked[0]?.scopes).toEqual(["once", "session", "project", "always"]);
    expect(await grants.listPersistent()).toEqual([expect.objectContaining({ scope: "project", origin: "shell", projectRoot: PROJECT.replace(/\\/g, "/").replace(/^[A-Z]:/, (drive) => drive.toLowerCase()), host: "pypi.org" })]);
    // A later call from the repository root, in another conversation, is covered; another repository is asked again.
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2", workspaceRoot: PROJECT } });
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await callback()({ host: "pypi.org", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, workspaceRoot: OTHER } });
    expect(await callback()({ host: "pypi.org", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
    expect(asked).toHaveLength(2);
  });

  // A relative working directory is a host contract violation: the connection is denied and audited, never asked with a narrower card.
  it("denies and audits a call whose working directory is not an absolute path", async () => {
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, workspaceRoot: "relative/dir" } });
    expect(await callback()({ host: "pypi.org", port: 443 }, listener(SHELL_TOKEN))).not.toBe(true);
    expect(asked).toEqual([]);
    expect(audit).toEqual([expect.objectContaining({ decision: "deny" })]);
  });

  it("Always covers every workspace and persists", async () => {
    answer = async () => ({ allow: true, scope: "always" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    owners.set(OTHER_SHELL_TOKEN, {
      ...interactiveShell,
      context: { sessionId: "session-9", workspaceRoot: "/elsewhere", approvalSurface: "unavailable" },
    });
    expect(await callback()({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
  });

  it("asks once for concurrent connections to one destination from one call", async () => {
    let release: (value: EgressApprovalAnswer) => void = () => {};
    answer = () => new Promise((resolve) => { release = resolve; });
    const ask = callback();
    const first = ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    const second = ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    release({ allow: true, scope: "once" });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(asked).toHaveLength(1);
  });

  it("attributes nothing to a key whose identity it refused: no deny-monitor note, observation, audit owner or proxy record", async () => {
    const notes = vi.spyOn(denyMonitor, "noteCallbackDecision");
    const observations = vi.spyOn(terminalObservation, "observeAgentTerminalEgressDecision");
    const sharedFront = { attributionKey: SHELL_TOKEN, identity: "username" as const, addresses: [], resolution: "pinned" as const };
    expect(await callback()({ host: "github.com", port: 443 }, sharedFront))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(notes.mock.calls).toEqual([[undefined, "github.com", 443]]);
    expect(observations.mock.calls.map(([key]) => key)).toEqual([undefined]);
    expect(audit.map((row) => row.invocation)).toEqual([{ kind: "unattributed" }]);
    expect(asked).toEqual([]);
    // The listener's own key is accepted and attributed as before.
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(notes.mock.calls.at(-1)).toEqual([SHELL_TOKEN, "github.com", 443]);
    expect(observations.mock.calls.at(-1)?.[0]).toBe(SHELL_TOKEN);
  });

  it.each(["remembered grant", "allow rule", "held answer", "prompt answer"] as const)("gives a %s allow only to an invocation that is still live", async (path) => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    const github = { host: "github.com", port: 443 };
    const connection = listener(SHELL_TOKEN, ["140.82.112.3"]);
    if (path === "remembered grant") {
      await grants.grant("always", ["once", "session", "project", "always"], { token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" }, { ...github, network: "public" });
      expect(await callback()(github, connection)).toBe(true);
      controller.abort();
    } else if (path === "allow rule") {
      networkRule = async () => ({ decision: "allow", pattern: "Network(github.com)", scope: "user" });
      expect(await callback()(github, connection)).toBe(true);
      controller.abort();
    } else if (path === "held answer") {
      answer = async () => ({ allow: true, scope: "session" });
      const raw = rawCallback();
      expect(await raw(github, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "name" })).toBe(true);
      controller.abort();
      expect(await raw(github, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" }))
        .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    } else {
      // The person answers after the call was cancelled.
      answer = async () => { controller.abort(); return { allow: true, scope: "session" }; };
    }
    expect(await callback()(github, connection)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny", reason: EGRESS_DENY_REASONS.unattributed });
    if (path === "held answer" || path === "prompt answer") {
      // Nothing it answered became a grant another call in the conversation could use.
      answer = async () => ({ allow: false, reason: "denied by the user" });
      expect(await callback()(github, listener(OTHER_SHELL_TOKEN, ["140.82.112.3"]))).toEqual({ allow: false, reason: "denied by the user" });
    }
  });

  it.each(["before resolution", "while redeeming"] as const)("honors a deny saved %s of a held answer", async (when) => {
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("strict");
    answer = async () => ({ allow: true, scope: "session" });
    const ask = rawCallback(undefined, createShellNetworkPermissionEvaluator(manager));
    const destination = { host: "policy.example", port: 443 };
    const saveDeny = async () => {
      await manager.addRulePersist({ pattern: "Network(policy.example:443)", action: "deny" }, { kind: "user" });
    };
    const who = { attributionKey: SHELL_TOKEN, identity: "listener" as const };
    expect(await ask(destination, { ...who, phase: "name" })).toBe(true);
    const noteUse = vi.spyOn(grants, "noteUse");
    if (when === "before resolution") await saveDeny();
    else {
      const grant = grants.grant.bind(grants);
      vi.spyOn(grants, "grant").mockImplementationOnce(async (...args) => {
        await saveDeny();
        await grant(...args);
      });
    }
    expect(await ask(destination, { ...who, phase: "resolved", addresses: ["8.8.8.8"], resolution: "pinned" }))
      .toEqual({ allow: false, reason: "denied by host rule Network(policy.example:443)" });
    expect(grants.matchingLoadedScope({ token: SHELL_TOKEN, origin: "shell", sessionId: "session-1", tabId: undefined, projectRoot: PROJECT },
      { ...destination, network: "public" }, ["session"])).toBeUndefined();
    expect(noteUse).not.toHaveBeenCalled();
    expect(asked).toHaveLength(1);
  });

  it("gives nothing to a token whose owner was replaced", async () => {
    networkRule = async () => ({ decision: "allow", pattern: "Network(github.com)", scope: "user" });
    const github = { host: "github.com", port: 443 };
    const lookups = { count: 0 };
    const replaced = createEgressAskCallback({
      identityStrength: () => strength,
      // The token is looked up once to judge it, then names another call.
      ownerOf: (token) => (token === SHELL_TOKEN && lookups.count++ > 0 ? { ...interactiveShell } : owners.get(token)),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => [],
      grants,
      networkRule: (subject) => networkRule(subject),
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: (entry) => audit.push(entry),
    });
    expect(await replaced(github, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" } });
  });

  it.each(["abort", "revoke"] as const)("grants nothing after %s while a persistent egress grant waits in the store", async interruption => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    let current = true;
    if (interruption === "revoke") {
      const sessionId = "session-1";
      const remoteControllerAuthority = bindRemoteControllerToSession({
        kind: "tailnet-controller",
        actorId: "tailnet:controller-digest",
        pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
        pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => current },
      }, sessionId);
      owners.set(SHELL_TOKEN, {
        ...interactiveShell,
        context: { ...interactiveShell.context, sessionId, permissionContext: { remoteControllerAuthority } },
      });
    }
    const notes = vi.spyOn(denyMonitor, "noteCallbackDecision");
    const observations = vi.spyOn(terminalObservation, "observeAgentTerminalEgressDecision");
    const store = grants as unknown as { loadPersistent(): Promise<unknown> };
    const load = store.loadPersistent.bind(grants);
    let rereading!: () => void;
    const reread = new Promise<void>((resolve) => { rereading = resolve; });
    let ungate!: () => void;
    const gate = new Promise<void>((resolve) => { ungate = resolve; });
    answer = async () => {
      // The store's next read is the re-read inside its write queue.
      vi.spyOn(store, "loadPersistent").mockImplementationOnce(async () => { rereading(); await gate; return load(); });
      return { allow: true, scope: "always" };
    };
    const github = { host: "github.com", port: 443 };
    const decision = rawCallback()(github, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" });
    await reread;
    if (interruption === "abort") controller.abort();
    else current = false;
    ungate();
    const result = await decision;
    const stored = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    expect(await stored.matchingScope({ token: OTHER_SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" },
      { ...github, network: "public" }, matchingScopes)).toBeUndefined();
    if (interruption === "revoke") {
      expect(result).toEqual({ allow: false, reason: "remote-controller-revoked" });
      expect(audit).toEqual([expect.objectContaining({ invocation: { kind: "shell", toolName: "bash", toolUseId: "toolu_1" }, decision: "deny", reason: "remote-controller-revoked" })]);
    } else {
      expect(result).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
      expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny", reason: EGRESS_DENY_REASONS.unattributed });
      expect(notes.mock.calls.at(-1)).toEqual([undefined, "github.com", 443]);
      expect(observations.mock.calls.at(-1)?.[0]).toBeUndefined();
    }
  });

  it.each(["remembered", "rule", "mode"] as const)("denies a controller's next resolved connection under a %s allow when the owner changes", async basis => {
    const sessionId = "session-1";
    let ownerMatches = true;
    const refreshCurrent = vi.fn(async () => ownerMatches);
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller",
      actorId: "tailnet:controller-digest",
      pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => true, refreshCurrent },
    }, sessionId);
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId,
      permissionContext: { remoteControllerAuthority } } });
    const destination = { host: "github.com", port: 443 };
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode(basis === "mode" ? "allow" : "strict");
    if (basis === "remembered") {
      await grants.grant("always", ["always"],
        { token: SHELL_TOKEN, sessionId, tabId: undefined, projectRoot: PROJECT, origin: "shell" }, destination);
    } else if (basis === "rule") {
      manager.setRules([{ pattern: "Network(github.com)", action: "allow" }]);
    }
    const raw = rawCallback(undefined, createShellNetworkPermissionEvaluator(manager));
    const resolved = { attributionKey: SHELL_TOKEN, identity: "listener" as const, phase: "resolved" as const,
      addresses: ["140.82.112.3"], resolution: "pinned" as const };
    expect(await raw(destination, resolved)).toBe(true);
    ownerMatches = false;
    expect(await raw(destination, resolved)).toEqual({ allow: false, reason: "remote-controller-revoked" });
    expect(refreshCurrent).toHaveBeenCalledTimes(2);
    expect(asked).toHaveLength(0);
    expect(audit.map(entry => entry.decision)).toEqual(["allow", "deny"]);
    expect(audit[0]?.basis).toBe(basis === "remembered" ? "grant" : basis === "mode" ? "policy" : "rule");
  });

  it("refreshes the owner again before returning a newly approved resolved connection", async () => {
    const sessionId = "session-1";
    const refreshCurrent = vi.fn(async () => false).mockResolvedValueOnce(true);
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller",
      actorId: "tailnet:controller-digest",
      pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => true, refreshCurrent },
    }, sessionId);
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId,
      permissionContext: { remoteControllerAuthority } } });
    answer = async () => ({ allow: true, scope: "once", oneConnection: true });
    const destination = { host: "github.com", port: 443 };
    const resolved = { attributionKey: SHELL_TOKEN, identity: "listener" as const, phase: "resolved" as const,
      addresses: ["140.82.112.3"], resolution: "pinned" as const };
    expect(await rawCallback()(destination, resolved)).toEqual({ allow: false, reason: "remote-controller-revoked" });
    expect(asked).toHaveLength(1);
    expect(refreshCurrent).toHaveBeenCalledTimes(2);
    expect(audit).toEqual([expect.objectContaining({ decision: "deny", reason: "remote-controller-revoked" })]);
  });

  it.each(["revoke destination", "save deny rule"] as const)("refuses a resolved connection when the desk can %s during the final probe", async mutation => {
    const sessionId = "session-1";
    const arrived = deferred<void>();
    const release = deferred<void>();
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller",
      actorId: "tailnet:controller-digest",
      pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => {
        arrived.resolve();
        await release.promise;
        return true;
      } },
    }, sessionId);
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context,
      permissionContext: { remoteControllerAuthority } } });
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("strict");
    const destination = { host: "github.com", port: 443 };
    const grant = { ...destination, scope: "always", network: "public", origin: "shell" } as const;
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId, projectRoot: PROJECT, tabId: undefined, origin: "shell" }, grant);
    const noteUse = vi.spyOn(grants, "noteUse");
    const pending = rawCallback(undefined, createShellNetworkPermissionEvaluator(manager))(destination, {
      attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned",
    });
    try {
      await arrived.promise;
      if (mutation === "revoke destination") {
        expect(await grants.revoke(grant)).toEqual({ removed: true, tokens: [] });
      } else {
        await manager.addRulePersist({ pattern: "Network(github.com:443)", action: "deny" }, { kind: "user" });
      }
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ allow: false, ...(mutation === "save deny rule" ? { reason: "denied by host rule Network(github.com:443)" } : {}) });
    expect(noteUse).not.toHaveBeenCalled();
    expect(asked).toHaveLength(0);
    expect(audit).toEqual([expect.objectContaining({ decision: "deny" })]);
  });

  it.each(["separate writer", "unpublished commit", "unreadable file"] as const)(
    "refuses a resolved connection when project rules change during the probe (%s)", async change => {
      const sessionId = "session-1";
      const probing = deferred<void>();
      const finishProbe = deferred<void>();
      const remoteControllerAuthority = bindRemoteControllerToSession({
        kind: "tailnet-controller",
        actorId: "tailnet:controller-digest",
        pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
        pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => {
          probing.resolve();
          await finishProbe.promise;
          return true;
        } },
      }, sessionId);
      owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId,
        permissionContext: { remoteControllerAuthority } } });
      const rulesPath = join(dir, "permissions.json");
      const manager = new PermissionManager(rulesPath);
      manager.setMode("strict");
      const scope = { kind: "project", projectCwd: PROJECT } as const;
      const pattern = "Network(github.com:443)";
      await manager.addRulePersist({ pattern, action: "allow" }, scope);
      const location = projectRuleFiles.projectRulesLocation(dir, PROJECT);
      const pending = rawCallback(undefined, createShellNetworkPermissionEvaluator(manager))({ host: "github.com", port: 443 }, {
        attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned",
      });
      const writing = deferred<void>();
      const finishPublish = deferred<void>();
      let write: Promise<void> | undefined;
      const update = projectRuleFiles.updateProjectRulesFile;
      const writerSpy = vi.spyOn(projectRuleFiles, "updateProjectRulesFile");
      try {
        await probing.promise;
        if (change === "unpublished commit") {
          writerSpy.mockImplementationOnce(async (...args) => {
            const committed = await update(...args);
            writing.resolve();
            await finishPublish.promise;
            return committed;
          });
          write = manager.addRulePersist({ pattern, action: "deny" }, scope);
          await writing.promise;
        } else {
          await new PermissionManager(rulesPath).addRulePersist({ pattern, action: "deny" }, scope);
        }
        expect(JSON.parse(readFileSync(location.filePath, "utf8")).rules).toContainEqual({ pattern, action: "deny" });
        if (change === "unreadable file") {
          renameSync(location.filePath, `${location.filePath}.saved`);
          mkdirSync(location.filePath);
        }
        finishProbe.resolve();
        expect(await pending).toEqual({ allow: false, reason: "Permission policy changed before execution." });
        expect(asked).toHaveLength(0);
        expect(audit).toEqual([expect.objectContaining({ decision: "deny" })]);
      } finally {
        finishProbe.resolve();
        finishPublish.resolve();
        await write;
        writerSpy.mockRestore();
      }
    },
  );

  describe.each(["remote", "local", "terminal"] as const)("persistent egress grant use by %s", origin => {
    it.each(["unrelated save", "unrelated save after its rename", "matching revoke"] as const)("checks the grant during a pending mutation (%s)", async mutation => {
      const terminal = origin === "terminal";
      const token = terminal ? TERMINAL_TOKEN : SHELL_TOKEN;
      const sessionId = "session-1";
      const subject = { token, sessionId, tabId: terminal ? TERMINAL_TAB : undefined,
        projectRoot: terminal ? undefined : PROJECT, origin: terminal ? "terminal" as const : "shell" as const };
      const destination = { host: "github.com", port: 443 };
      const grant = { ...destination, scope: "always", network: "public", origin: subject.origin } as const;
      await grants.grant("always", ["always"], subject, grant);
      const staging = deferred<void>();
      const finishWrite = deferred<void>();
      const writeFile = featureNamespace.writeFileAtomicAtPath;
      const holdWriter = vi.spyOn(featureNamespace, "writeFileAtomicAtPath").mockImplementationOnce(async (...args) => {
        // Held after the rename, the file already holds the save while the store still caches the previous version.
        if (mutation === "unrelated save after its rename") await writeFile(...args);
        staging.resolve();
        await finishWrite.promise;
        if (mutation !== "unrelated save after its rename") await writeFile(...args);
      });
      let write: Promise<unknown> | undefined;
      const startMutation = async () => {
        write = mutation === "matching revoke" ? grants.revoke(grant)
          : grants.grant("always", ["always"], subject, { ...destination, host: "example.com" });
        await staging.promise;
      };
      const matchingScope = grants.matchingScope.bind(grants);
      if (origin === "remote") {
        const remoteControllerAuthority = bindRemoteControllerToSession({
          kind: "tailnet-controller",
          actorId: "tailnet:controller-digest",
          pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
          pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => {
            await startMutation();
            return true;
          } },
        }, sessionId);
        owners.set(token, { ...interactiveShell, context: { ...interactiveShell.context, sessionId,
          permissionContext: { remoteControllerAuthority } } });
      } else {
        vi.spyOn(grants, "matchingScope").mockImplementationOnce(async (...args) => {
          const matched = await matchingScope(...args);
          await startMutation();
          return matched;
        });
      }
      const noteUse = vi.spyOn(grants, "noteUse");
      const manager = new PermissionManager(join(dir, "permissions.json"));
      manager.setMode("strict");
      try {
        const result = await rawCallback(undefined, createShellNetworkPermissionEvaluator(manager))(destination, {
          attributionKey: token, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned",
        });
        if (mutation !== "matching revoke") {
          expect(result).toBe(true);
          expect(noteUse).toHaveBeenCalledWith("always", expect.objectContaining({ token }), { ...destination, network: "public" });
        } else {
          expect(result).toMatchObject({ allow: false });
          expect(noteUse).not.toHaveBeenCalled();
        }
        expect(asked).toHaveLength(0);
        expect(audit).toEqual([expect.objectContaining({ decision: mutation === "matching revoke" ? "deny" : "allow" })]);
      } finally {
        finishWrite.resolve();
        await write;
        holdWriter.mockRestore();
      }
    });
  });

  it.for(["removed grant", "unreadable grant", "untrusted grant", "linked user rules", "linked project rules", "unchanged",
    "grant untrusted before the call"] as const)(
    "proves the covered egress sources after the owner probe (%s)", async (change, { skip }) => {
      if (change.startsWith("linked")) requireSymlinkCapability(dir, "file", skip);
      const home = join(realpathSync(dir), ".ave");
      configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
      setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
      setFixtureOwner(dir);
      vi.stubEnv("AVE_HOME", home);
      const privacy = ensureAveHomePrivate(home);
      expect(privacy.enforcement).not.toBe("none");
      migrateAveHomeConfiguration(home, privacy);
      evaluateAveHomeTrustAtBoot(home);
      const grantFile = join(home, "permissions", "shell-egress-hosts.json");
      const userFile = join(home, "permissions.json");
      const projectFile = projectRuleFiles.projectRulesLocation(home, PROJECT).filePath;
      const manager = new PermissionManager(userFile);
      const sessionId = "session-1";
      const destination = { host: "github.com", port: 443 };
      const probing = deferred<void>();
      const finishProbe = deferred<void>();
      const remoteControllerAuthority = bindRemoteControllerToSession({
        kind: "tailnet-controller",
        actorId: "tailnet:controller-digest",
        pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
        pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => {
          probing.resolve();
          await finishProbe.promise;
          return true;
        } },
      }, sessionId);
      owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId,
        permissionContext: { remoteControllerAuthority } } });
      grants = new EgressGrantStore(grantFile);
      let unreadable: { mockRestore(): void } | undefined;
      try {
        // The last case is allowed by its user rule alone: a grant file that read as absent supplied nothing to prove.
        const userAllows = change === "linked user rules" || change === "grant untrusted before the call";
        await manager.addRulePersist({ pattern: userAllows ? "Network(github.com:443)" : "Network(example.com)", action: "allow" }, { kind: "user" });
        await manager.addRulePersist({ pattern: change === "linked project rules" ? "Network(github.com:443)" : "Network(example.org)", action: "allow" }, { kind: "project", projectCwd: PROJECT });
        await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId, projectRoot: PROJECT, tabId: undefined, origin: "shell" }, destination);
        for (const path of [grantFile, userFile, projectFile]) expect(readAveHomeInputSync(path).status).toBe("trusted");
        if (change === "grant untrusted before the call") {
          writeFileSync(grantFile, `${readFileSync(grantFile, "utf8")}\n`);
          expect(readAveHomeInputSync(grantFile)).toMatchObject({ status: "untrusted", reason: "changed" });
          // A fresh store loads the pending-review file, which reads as absent.
          grants = new EgressGrantStore(grantFile);
        }
        const noteUse = vi.spyOn(grants, "noteUse");
        const pending = rawCallback(undefined, createShellNetworkPermissionEvaluator(manager))(destination, {
          attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned",
        });
        try {
          await probing.promise;
          if (change === "removed grant") {
            rmSync(grantFile);
            expect(readAveHomeInputSync(grantFile).status).toBe("absent");
          } else if (change === "unreadable grant") {
            const read = homeTrust.readAveHomeInputSync;
            unreadable = vi.spyOn(homeTrust, "readAveHomeInputSync").mockImplementation((path, options) => {
              if (path === grantFile) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
              return read(path, options);
            });
            expect(() => homeTrust.readAveHomeInputSync(grantFile)).toThrow("EACCES");
          } else if (change === "untrusted grant") {
            writeFileSync(grantFile, `${readFileSync(grantFile, "utf8")}\n`);
            expect(readAveHomeInputSync(grantFile)).toMatchObject({ status: "untrusted", reason: "changed" });
          } else if (change.startsWith("linked")) {
            const file = change === "linked user rules" ? userFile : projectFile;
            const original = readFileSync(file);
            const sameBytes = join(dir, "same-bytes.json");
            renameSync(file, sameBytes);
            symlinkSync(sameBytes, file, "file");
            expect(readFileSync(file)).toEqual(original);
            expect(readAveHomeInputSync(file)).toMatchObject({ status: "untrusted", reason: "link" });
          }
        } finally {
          finishProbe.resolve();
        }
        if (change === "unchanged") {
          expect(await pending).toBe(true);
          expect(noteUse).toHaveBeenCalledOnce();
        } else if (change === "grant untrusted before the call") {
          expect(await pending).toBe(true);
          expect(noteUse).not.toHaveBeenCalled();
        } else {
          expect(await pending).toEqual({ allow: false, reason: "Permission policy changed before execution." });
          expect(noteUse).not.toHaveBeenCalled();
        }
        if (change === "removed grant" || change === "untrusted grant") {
          // The refused snapshot is not kept: the next lookup reads the file again and finds no usable grant.
          expect(await grants.matchingScope({ token: SHELL_TOKEN, sessionId, projectRoot: PROJECT, tabId: undefined, origin: "shell" },
            { ...destination, network: "public" }, ["always"])).toBeUndefined();
        }
        expect(asked).toHaveLength(0);
        expect(audit).toEqual([expect.objectContaining({ decision: change === "unchanged" || change === "grant untrusted before the call" ? "allow" : "deny" })]);
      } finally {
        unreadable?.mockRestore();
        setAveHomeConfigurationOwner(undefined);
        _resetAveHomeTrustForTest();
        _resetAveHomePrivacyForTest();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["prompt", "remembered grant"] as const)("does not act on a %s for a call that ended while its policy was evaluated", async (path) => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    const github = { host: "github.com", port: 443 };
    if (path === "remembered grant") {
      await grants.grant("always", ["once", "session", "project", "always"], { token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" }, { ...github, network: "public" });
    }
    const noteUse = vi.spyOn(grants, "noteUse");
    networkRule = async () => { controller.abort(); return undefined; };
    answer = async () => ({ allow: true, scope: "session" });
    const result = await rawCallback()(github, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" });
    expect(asked).toEqual([]);
    expect(noteUse).not.toHaveBeenCalled();
    expect(result).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny" });
  });

  it("reports no missing approver for a call that ended while its policy was evaluated", async () => {
    const onNoApprover = vi.fn();
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, headless: true, approvalSurface: "unavailable", onNoApprover } });
    const github = { host: "github.com", port: 443 };
    expect(await callback()(github, listener(SHELL_TOKEN))).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(onNoApprover).toHaveBeenCalledOnce();
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    networkRule = async () => { controller.abort(); return undefined; };
    expect(await callback()(github, listener(SHELL_TOKEN))).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(onNoApprover).toHaveBeenCalledOnce();
    expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny" });
  });

  const ASK_SECRET = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
  const ASK_FAILURE = String.raw`approval surface failed with ${ASK_SECRET} at C:\Users\alice\private\approval.sock`;

  it.each(["denied answer", "failed ask"] as const)("does not attribute a %s to a call that ended while it was asked", async (path) => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    answer = async () => {
      controller.abort();
      if (path === "failed ask") throw new Error(ASK_FAILURE);
      return { allow: false, reason: "denied by the user" };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await rawCallback()({ host: "github.com", port: 443 },
        { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" });
      expect(asked).toHaveLength(1);
      expect(result).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
      expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny", reason: EGRESS_DENY_REASONS.unattributed });
      // The failure the refusal no longer names is still kept for diagnosis, with its secret and home path masked.
      const failureLogs = warn.mock.calls.filter(([message]) => message === "[egress-ask] egress decision failed after its invocation ended");
      expect(failureLogs).toEqual(path === "failed ask"
        ? [[expect.any(String), { reason: String.raw`approval surface failed with [REDACTED:TOKEN] at [home]\private\approval.sock` }]] : []);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the unattributed refusal and its audit row when the ended call's failure log throws", async () => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    answer = async () => {
      controller.abort();
      throw new Error(ASK_FAILURE);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("log sink failed"); });
    try {
      const result = await rawCallback()({ host: "github.com", port: 443 },
        { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" });
      expect(warn).toHaveBeenCalledWith("[egress-ask] egress decision failed after its invocation ended", expect.anything());
      expect(result).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
      expect(audit.at(-1)).toMatchObject({ invocation: { kind: "unattributed" }, decision: "deny", reason: EGRESS_DENY_REASONS.unattributed });
    } finally {
      warn.mockRestore();
    }
  });

  it.each([["held answer", SHELL_TOKEN], ["pending ask", TERMINAL_TOKEN]] as const)("never credits an earlier invocation's %s to a later one under the same token and owner", async (path, token) => {
    const first = new AbortController();
    signals.set(token, first.signal);
    const github = { host: "github.com", port: 443 };
    const byName = { attributionKey: token, identity: "listener", phase: "name" } as const;
    const resolved = { ...byName, phase: "resolved", addresses: ["140.82.112.3"], resolution: "pinned" } as const;
    const raw = rawCallback();
    const replace = (): void => {
      first.abort();
      signals.set(token, new AbortController().signal);
    };
    if (path === "held answer") {
      answer = async () => ({ allow: true, scope: "session" });
      expect(await raw(github, byName)).toBe(true);
      replace();
      answer = async () => ({ allow: false, reason: "denied by the user" });
      expect(await raw(github, resolved)).toEqual({ allow: false, reason: "denied by the user" });
      expect(asked).toHaveLength(2);
      return;
    }
    const replies: ((reply: EgressApprovalAnswer) => void)[] = [];
    let onAsk = (): void => {};
    answer = () => new Promise((resolve) => { replies.push(resolve); onAsk(); });
    const asking = new Promise<void>((resolve) => { onAsk = resolve; });
    const earlier = raw(github, resolved);
    await asking;
    replace();
    let lookedUp!: (scope: undefined) => void;
    vi.spyOn(grants, "matchingScope").mockImplementationOnce(() => new Promise((resolve) => { lookedUp = resolve; }));
    let laterAsked = false;
    onAsk = () => { laterAsked = true; };
    const later = raw(github, resolved);
    // Nothing awaits between a terminal's grant lookup and its ask, so the later connection reaches the ask before the earlier card's answer lands.
    lookedUp(undefined);
    replies[0]?.({ allow: true, scope: "tab" });
    expect(await earlier).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(laterAsked).toBe(true);
    replies[1]?.({ allow: false, reason: "denied by the user" });
    expect(await later).toEqual({ allow: false, reason: "denied by the user" });
  });

  it("hands the ask the call's abort signal", async () => {
    const controller = new AbortController();
    signals.set(SHELL_TOKEN, controller.signal);
    answer = async (request) => {
      expect(request.abortSignal).toBe(controller.signal);
      return { allow: false, reason: "network approval timed out" };
    };
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "network approval timed out" });
  });

  it("denies without asking when asks are off, but keeps granted hosts", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "registry.npmjs.org", port: 443 });
    askEnabled = false;
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(asked).toEqual([]);
  });

  it("strict unavailable shell calls stop before a human-only requester", async () => {
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, headless: true, approvalSurface: "unavailable" } });
    answer = async () => ({ allow: true, scope: "once" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(asked).toEqual([]);
    owners.set(SHELL_TOKEN, interactiveShell);
    requesterPresent = false;
    expect(await callback()({ host: "other.example", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.noSurface });
    expect(asked).toEqual([]);
  });

  it("fails closed: a throwing ask, an unoffered scope or an unreadable grant file is a deny", async () => {
    answer = async () => { throw new Error("renderer went away"); };
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.failed}: renderer went away` });
    owners.set(SHELL_TOKEN, {
      ...interactiveShell,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "interactive" },
    });
    answer = async () => ({ allow: true, scope: "project" });
    const unoffered = await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    expect(unoffered).toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.failed}: egress grant: scope project was not offered` });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "shell-egress-hosts.json"), "{ not json");
    grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    const unreadable = await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    expect(unreadable).toMatchObject({ allow: false });
    expect((unreadable as { reason: string }).reason).toMatch(/^network approval failed: shell egress grant file .* is not valid: invalid JSON$/u);
    expect(audit.every((row) => row.decision === "deny")).toBe(true);
  });

  it("keeps the answer when the audit row cannot be written", async () => {
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: () => "kernel-channel",
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => ["api.fixture.example"],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: () => { throw new Error("disk full"); },
    }));
    expect(await ask({ host: "api.fixture.example", port: 443 }, listener(WORKER_TOKEN))).toBe(true);
  });
});

describe("egressAllowlistMatches (ASRT's allowedDomains matcher)", () => {
  it.each([
    [["example.com"], "example.com", 443, true],
    [["example.com"], "api.example.com", 443, false],
    [["*.example.com"], "api.example.com", 443, true],
    [["*.example.com"], "example.com", 443, false],
    [["Example.COM"], "example.com", 443, true],
    [["example.com:8443"], "example.com", 443, false],
    [["example.com:8443"], "example.com", 8443, true],
    [["10.0.0.5"], "10.0.0.5", 80, true],
    [["*.0.0.5"], "10.0.0.5", 80, false],
    [[], "example.com", 443, false],
  ] as const)("%j matches %s:%d → %s", (entries, host, port, expected) => {
    expect(egressAllowlistMatches(entries, { host, port })).toBe(expected);
  });
});

describe("egress ask callback — local, private and reserved destinations", () => {
  it.each([
    ["169.254.169.254", 80],
    ["[fe80::1]", 443],
    ["0.0.0.0", 8080],
    ["[::]", 8080],
    ["168.63.129.16", 80],
    ["[fd00:ec2::254]", 80],
    ["224.0.0.251", 5353],
  ])("refuses %s without asking, for shells and workers alike", async (host, port) => {
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: () => "kernel-channel",
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => [host.replace(/^\[|\]$/gu, "")],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => async (request) => { asked.push(request); return { allow: true, scope: "once" }; },
      audit: () => {},
    }));
    expect(await ask({ host, port }, listener(SHELL_TOKEN))).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(await ask({ host, port }, listener(WORKER_TOKEN))).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(asked).toEqual([]);
  });

  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["[::ffff:7f00:1]", "127.0.0.1"],
    ["[::1]", "::1"],
    ["localhost", "localhost"],
    ["foo.localhost", "foo.localhost"],
    ["10.1.2.3", "10.1.2.3"],
    ["172.20.0.1", "172.20.0.1"],
    ["192.168.1.10", "192.168.1.10"],
    ["100.64.0.7", "100.64.0.7"],
    ["[fd12:3456::1]", "fd12:3456::1"],
  ])("asks about %s as a local destination, shown as %s, with no persistent scope", async (host, shown) => {
    await callback()({ host, port: 8080 }, listener(SHELL_TOKEN));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ destination: { host: shown, port: 8080 }, scopes: ["once", "session"], network: "local" });
  });

  it("asks by name, then shows the card again when the name resolves to a private address, and refuses a reserved one", async () => {
    answer = async () => ({ allow: true, scope: "session" });
    expect(await callback()({ host: "nas.example", port: 445 }, listener(SHELL_TOKEN, ["10.20.30.40"]))).toBe(true);
    // The name card (public) came first; its answer was held, not granted, because the name turned out to be private: the local card decided.
    expect(asked.map((request) => [request.network, request.scopes])).toEqual([
      ["public", ["once", "session", "project", "always"]],
      ["local", ["once", "session"]],
    ]);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "prompt", "session"]]);
    expect(await callback()({ host: "meta.example", port: 80 }, listener(SHELL_TOKEN, ["169.254.169.254"])))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(asked.map((request) => request.destination.host)).toEqual(["nas.example", "nas.example", "meta.example"]);
    expect(await grants.matchingScope({ token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" as const }, { host: "meta.example", port: 80 }, matchingScopes))
      .toBeUndefined();
  });

  it("turns an answer given by name into the grant it chose when the name resolves to what the card said", async () => {
    answer = async () => ({ allow: true, scope: "project" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN, ["140.82.112.3"]))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "prompt", "project"]]);
    expect(await grants.matchingScope({ token: OTHER_SHELL_TOKEN, sessionId: "session-2", tabId: undefined, projectRoot: PROJECT, origin: "shell" as const }, { host: "github.com", port: 443 }, matchingScopes))
      .toBe("project");
  });

  it("writes no grant and no audit row for a name-phase allow the resolved phase never confirms", async () => {
    answer = async () => ({ allow: true, scope: "always" });
    const raw = rawCallback();
    expect(await raw({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "name" })).toBe(true);
    expect(audit).toEqual([]);
    expect(await grants.matchingScope({ token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" as const }, { host: "github.com", port: 443 }, matchingScopes))
      .toBeUndefined();
  });

  it("ends every refusal it can make from the name in the name phase", async () => {
    const raw = rawCallback();
    const byName = (token: string | undefined, host: string, port = 443) =>
      raw({ host, port }, { attributionKey: token, identity: "listener", phase: "name" });
    expect(await byName(undefined, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await byName("f".repeat(32), "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });
    expect(await byName(WORKER_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
    expect(await byName(SHELL_TOKEN, "169.254.169.254", 80)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(await byName(TERMINAL_TOKEN, "169.254.169.254", 80)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    askEnabled = false;
    expect(await byName(SHELL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(await byName(TERMINAL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    askEnabled = true;
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, approvalSurface: "unavailable" } });
    answer = async () => ({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(await byName(SHELL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(asked).toEqual([]);
  });

  it("matches grants by origin in the name phase: a shell's Always grant does not let a terminal through, nor a tab grant a shell", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "github.com", port: 443 });
    const raw = rawCallback();
    const byName = (token: string) => raw({ host: "github.com", port: 443 }, { attributionKey: token, identity: "listener", phase: "name" });
    // The shell passes by its grant, without a card.
    expect(await byName(SHELL_TOKEN)).toBe(true);
    expect(asked).toEqual([]);
    // The terminal is asked in its banner (and refused here by the default answer).
    expect(await byName(TERMINAL_TOKEN)).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked.map((request) => request.origin)).toEqual(["terminal"]);
    // A tab grant, in turn, covers that tab and never a shell call.
    answer = async () => ({ allow: true, scope: "tab" });
    expect(await callback()({ host: "pypi.org", port: 443 }, listener(TERMINAL_TOKEN, ["151.101.0.223"]))).toBe(true);
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await byName(TERMINAL_TOKEN)).toEqual({ allow: false, reason: "denied by the user" });
    expect(await raw({ host: "pypi.org", port: 443 }, { attributionKey: TERMINAL_TOKEN, identity: "listener", phase: "name" })).toBe(true);
    expect(await raw({ host: "pypi.org", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "name" }))
      .toEqual({ allow: false, reason: "denied by the user" });
  });

  it("spends a terminal's Allow once on one connection across both phases, never as a grant", async () => {
    answer = async () => ({ allow: true, scope: "once" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN, ["140.82.112.3"]))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN, ["140.82.112.3"]))).toBe(true);
    // Each connection had its own banner: "once" is not held for the next.
    expect(asked).toHaveLength(2);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "prompt", "once"], ["allow", "prompt", "once"]]);
    expect(await grants.matchingScope({ token: TERMINAL_TOKEN, sessionId: undefined, tabId: TERMINAL_TAB, projectRoot: undefined, origin: "terminal" as const }, { host: "github.com", port: 443 }, matchingScopes))
      .toBeUndefined();
  });

  it("does not let an Always grant for a name cover it once it resolves to a private address", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "rebind.example", port: 443 });
    expect(await callback()({ host: "rebind.example", port: 443 }, listener(SHELL_TOKEN, ["93.184.215.14"]))).toBe(true);
    expect(asked).toHaveLength(0);
    expect(await callback()({ host: "rebind.example", port: 443 }, listener(SHELL_TOKEN, ["192.168.0.10"])))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ network: "local", scopes: ["once", "session"] });
  });

  it("treats a name the upstream proxy resolves as unverified: at most this conversation, and an Always grant does not cover it", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "intranet.corp.test", port: 443 });
    expect(await callback()({ host: "intranet.corp.test", port: 443 }, listener(SHELL_TOKEN, [], "upstream")))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ destination: { host: "intranet.corp.test", port: 443 }, scopes: ["once", "session"], network: "unverified" });
    // The same name, resolved and pinned here, is public: the grant covers it.
    expect(await callback()({ host: "intranet.corp.test", port: 443 }, listener(SHELL_TOKEN, ["93.184.215.14"]))).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("keeps a local-network name local even when the upstream resolves it", async () => {
    await callback()({ host: "nas.local", port: 445 }, listener(SHELL_TOKEN, [], "upstream"));
    expect(asked[0]).toMatchObject({ network: "local", scopes: ["once", "session"] });
  });

  it("refuses a context without a phase, or a resolved phase without the resolved addresses (contract violation)", async () => {
    const raw = rawCallback();
    expect(await raw({ host: "example.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener" } as unknown as SandboxAskContext))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(await raw({ host: "example.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved" } as unknown as SandboxAskContext))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(await raw({ host: "example.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "resolved", addresses: [] } as unknown as SandboxAskContext))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.malformed });
    expect(asked).toEqual([]);
  });

  it("never lets a persistent grant cover a local destination", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, tabId: undefined, projectRoot: undefined, origin: "shell" as const },
      { host: "127.0.0.1", port: 8080 });
    expect(await callback()({ host: "127.0.0.1", port: 8080 }, listener(SHELL_TOKEN))).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
  });

  it("still lets a worker reach a local model endpoint its list names", async () => {
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: () => "kernel-channel",
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => ["localhost:11434"],
      grants,
      networkRule: async () => undefined,
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: () => {},
    }));
    expect(await ask({ host: "localhost", port: 11434 }, listener(WORKER_TOKEN))).toBe(true);
  });
});

// Owner 2026-10-25: the network card's "Always deny" and edited rules are `Network(...)` host rules, consulted before grants.
describe("egress ask callback — host rules", () => {
  const github = { host: "github.com", port: 443 };
  const publicGithub = () => listener(SHELL_TOKEN, ["140.82.112.3"]);

  it("asks the host rules with the shell's conversation and project, and never for a worker", async () => {
    const seen: unknown[] = [];
    networkRule = async (subject) => { seen.push(subject); return undefined; };
    await callback()(github, publicGithub());
    await callback()({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" });
    expect(seen[0]).toEqual({ host: "github.com", port: 443, sessionId: "session-1", projectCwd: PROJECT });
    expect(seen.every((subject) => (subject as { host: string }).host === "github.com")).toBe(true);
  });

  it("denies on a deny rule without asking or consulting grants", async () => {
    await grants.grant("always", ["once", "session", "project", "always"], { token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" }, { ...github, network: "public" });
    networkRule = async () => ({ decision: "deny", pattern: "Network(github.com)", scope: "user" });
    expect(await callback()(github, publicGithub())).toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.denyRule} Network(github.com)` });
    expect(asked).toEqual([]);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["deny", "rule", null]]);
  });

  it("allows a public destination on an allow rule without asking", async () => {
    networkRule = async () => ({ decision: "allow", pattern: "Network(*.github.com)", scope: "user" });
    expect(await callback()(github, publicGithub())).toBe(true);
    expect(asked).toEqual([]);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "rule", null]]);
  });

  it("asks instead of allowing when an allow rule's name resolves to a private address", async () => {
    networkRule = async () => ({ decision: "allow", pattern: "Network(github.com)", scope: "user" });
    expect(await callback()(github, listener(SHELL_TOKEN, ["10.0.0.5"]))).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.network).toBe("local");
  });

  it("asks on an ask rule even when a grant covers the destination", async () => {
    await grants.grant("always", ["once", "session", "project", "always"], { token: SHELL_TOKEN, sessionId: "session-1", tabId: undefined, projectRoot: PROJECT, origin: "shell" }, { ...github, network: "public" });
    networkRule = async () => ({ decision: "ask", pattern: "Network(github.com)", scope: "user" });
    expect(await callback()(github, publicGithub())).toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
  });

  // Security review of #223: host rules keep the grant invariants. They are shell-origin, and a shared identity uses no persistent one.
  it("never consults host rules for a terminal tab", async () => {
    let consulted = false;
    networkRule = async () => { consulted = true; return { decision: "allow", pattern: "Network(github.com)", scope: "user" }; };
    expect(await callback()(github, listener(TERMINAL_TOKEN, ["140.82.112.3"]))).toEqual({ allow: false, reason: "denied by the user" });
    expect(consulted).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it.each([["user", false], ["project", false], ["session", true]] as const)("a shared identity honors a %s allow rule: %s", async (scope, honored) => {
    strength = "shared";
    networkRule = async () => ({ decision: "allow", pattern: "Network(github.com)", scope });
    const result = await callback()(github, { ...publicGithub(), identity: "username" });
    if (honored) {
      expect(result).toBe(true);
      expect(asked).toEqual([]);
    } else {
      expect(result).toEqual({ allow: false, reason: "denied by the user" });
      expect(asked).toHaveLength(1);
    }
  });

  it("a shared identity still meets a persistent deny rule", async () => {
    strength = "shared";
    networkRule = async () => ({ decision: "deny", pattern: "Network(github.com)", scope: "user" });
    expect(await callback()(github, { ...publicGithub(), identity: "username" })).toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.denyRule} Network(github.com)` });
  });

  it("turns a host rule lookup failure into an audited deny", async () => {
    networkRule = async () => { throw new Error("project rules file is corrupt"); };
    expect(await callback()(github, publicGithub())).toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.failed}: project rules file is corrupt` });
    expect(audit.map((row) => [row.decision, row.basis])).toEqual([["deny", "policy"]]);
  });
});
