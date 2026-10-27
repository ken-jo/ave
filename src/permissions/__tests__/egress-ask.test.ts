// The egress ask callback's decision table (egress-ask.ts): who opened the connection decides whether it is allowed outright, refused, or asked about, and every answer is the literal `true` or a deny with a reason, with one audit row each.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxAskCallback, SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import type { SandboxEgressDecisionAuditEntry } from "../../audit/sandbox-audit.js";
import {
  createEgressAskCallback,
  egressAllowlistMatches,
  EGRESS_DENY_REASONS,
  type EgressApprovalRequest,
  type EgressApprovalAnswer,
  type EgressAskDeps,
} from "../egress-ask.js";
import { EgressGrantStore, egressDestinationNetwork } from "../egress-grants.js";
import type { EgressIdentityStrength } from "../../shared/sandbox-capability-info.js";
import type { EgressInvocationOwner, ShellEgressOwner } from "../egress-invocations.js";
import { egressIdentityStrength, noteAsrtUnixSocketPolicy } from "../egress-identity.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { EGRESS_GRANT_SCOPE_LADDERS } from "../../shared/egress-grant-scopes.js";

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
const signals = new Map<string, AbortSignal>();

function rawCallback(identityStrength: EgressAskDeps["identityStrength"] = () => strength) {
  return createEgressAskCallback({
    identityStrength,
    ownerOf: (token) => owners.get(token),
    abortSignalOf: (token) => signals.get(token),
    workerAllowedDomains: (pluginId) => (pluginId === "fixture_plugin" ? ["api.fixture.example", "*.cdn.example:443"] : []),
    grants,
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
  signals.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("egress ask callback — attribution", () => {
  it("offers strong scopes only to the host-owned shell lane on a shared host", async () => {
    const platform = process.platform;
    setProcessPlatform("win32");
    answer = async () => ({ allow: true, scope: "once" });
    const ask = bothPhases(createEgressAskCallback({
      identityStrength: egressIdentityStrength,
      ownerOf: (token) => owners.get(token),
      abortSignalOf: () => undefined,
      workerAllowedDomains: () => [],
      grants,
      shellAskEnabled: () => true,
      requester: () => async (request) => { asked.push(request); return answer(request); },
      audit: () => {},
    }));
    try {
      expect(egressIdentityStrength("shell", { identity: "listener" })).toBe("kernel-channel");
      expect(egressIdentityStrength("shell", { identity: "username" })).toBe("shared");
      expect(egressIdentityStrength("shell")).toBe("shared");
      expect(egressIdentityStrength("extension", { identity: "listener" })).toBe("shared");
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
    expect(await ask({ host: "example.com", port: 443 }, listener("f".repeat(32))))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    // A live shell's key presented on the shared front end: it may have been read off that shell, so it vouches for nobody.
    expect(await ask({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
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
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: () => {},
    }));
    expect(await ask({ host: "api.fixture.example", port: 443 }, { attributionKey: WORKER_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
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
    expect(await handleProxyAsk(destination, weak)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
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

  it("closing the tab ends its banner at once, with the requester's reason, not the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tab = new AbortController();
    signals.set(TERMINAL_TOKEN, tab.signal);
    answer = answerOnlyOnAbort;
    const pending = callback()({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN));
    await untilAsked(1);
    tab.abort(new Error("terminal tab closed"));
    expect(await pending).toEqual({ allow: false, reason: "network approval answer was rejected" });
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
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(asked).toEqual([]);
  });
});

describe("egress ask callback — shell calls", () => {
  it("asks for an ungranted host with every scope, and denies on the person's deny", async () => {
    const ask = callback();
    expect(await ask({ host: "GitHub.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toEqual([{
      origin: "shell",
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
    const fixtureRoot = WORK.replaceAll("\\", "/").replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    expect(await grants.listPersistent()).toEqual([expect.objectContaining({ scope: "project", origin: "shell", projectRoot: `${fixtureRoot}/project`, host: "pypi.org" })]);
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
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    expect(await ask({ host: "registry.npmjs.org", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(asked).toEqual([]);
  });

  it("denies a background call nobody can answer (I5) and a host with no approval surface", async () => {
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, approvalSurface: "unavailable" } });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    owners.set(SHELL_TOKEN, interactiveShell);
    requesterPresent = false;
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN)))
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
    expect(await byName("f".repeat(32), "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await byName(WORKER_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
    expect(await byName(SHELL_TOKEN, "169.254.169.254", 80)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(await byName(TERMINAL_TOKEN, "169.254.169.254", 80)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    askEnabled = false;
    expect(await byName(SHELL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    expect(await byName(TERMINAL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    askEnabled = true;
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, approvalSurface: "unavailable" } });
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
      shellAskEnabled: () => true,
      requester: () => undefined,
      audit: () => {},
    }));
    expect(await ask({ host: "localhost", port: 11434 }, listener(WORKER_TOKEN))).toBe(true);
  });
});
