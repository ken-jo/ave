/**
 * The egress ask callback's decision table (egress-ask.ts): who opened the
 * connection decides whether it is allowed outright, refused, or asked about,
 * and every answer is the literal `true` or a deny with a reason, with one
 * audit row each.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxAskCallback, SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import type { SandboxEgressDecisionAuditEntry } from "../../audit/sandbox-audit.js";
import {
  createEgressAskCallback,
  egressAllowlistMatches,
  EGRESS_DENY_REASONS,
  type EgressApprovalRequest,
  type EgressApprovalAnswer,
} from "../egress-ask.js";
import { EgressGrantStore } from "../egress-grants.js";
import type { EgressIdentityStrength } from "../../shared/sandbox-capability-info.js";
import type { EgressInvocationOwner, ShellEgressOwner } from "../egress-invocations.js";

const SHELL_TOKEN = "5".repeat(32);
const WORKER_TOKEN = "6".repeat(32);
const TERMINAL_TOKEN = "7".repeat(32);
const OTHER_SHELL_TOKEN = "8".repeat(32);

const interactiveShell: ShellEgressOwner = {
  kind: "shell",
  toolName: "bash",
  toolUseId: "toolu_1",
  context: { sessionId: "session-1", workspaceRoot: "/work/project", approvalSurface: "interactive" },
};

/** A connection as ASRT decides it: who, and what the destination resolved to. */
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

/**
 * Both phases of one connection, the way the patched ASRT calls them: the
 * name phase first, and the resolved phase only after its `true`.
 */
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

function rawCallback() {
  return createEgressAskCallback({
    identityStrength: () => strength,
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
    [TERMINAL_TOKEN, { kind: "terminal", tabId: "tab-1" }],
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
  it("denies without asking when the connection names no invocation, an unknown one, or only a username on a kernel-channel host", async () => {
    const ask = callback();
    expect(await ask({ host: "example.com", port: 443 }, { attributionKey: undefined, identity: "username", addresses: [], resolution: "pinned" }))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await ask({ host: "example.com", port: 443 }, undefined))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await ask({ host: "example.com", port: 443 }, listener("f".repeat(32))))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    // A live shell's key presented on the shared front end: it may have been
    // read off that shell, so it vouches for nobody.
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
    await grants.grant("always", ["once", "conversation", "workspace", "always"], {
      token: SHELL_TOKEN, sessionId: undefined, workspaceRoot: undefined,
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

describe("egress ask callback — workspace terminal", () => {
  it("denies with the fixed reason and never asks", async () => {
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(TERMINAL_TOKEN)))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.terminal });
    expect(asked).toEqual([]);
  });
});

describe("egress ask callback — shell calls", () => {
  it("asks for an ungranted host with every scope, and denies on the person's deny", async () => {
    const ask = callback();
    expect(await ask({ host: "GitHub.com", port: 443 }, listener(SHELL_TOKEN)))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toEqual([{
      sessionId: "session-1",
      toolName: "bash",
      toolUseId: "toolu_1",
      destination: { host: "github.com", port: 443 },
      scopes: ["once", "conversation", "workspace", "always"],
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

  it("caps the scopes at This conversation where the identity is shared", async () => {
    strength = "shared";
    const ask = callback();
    await ask({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "username", addresses: [], resolution: "pinned" });
    expect(asked[0]?.scopes).toEqual(["once", "conversation"]);
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

  it("This conversation covers every call in that conversation, not another conversation", async () => {
    answer = async () => ({ allow: true, scope: "conversation" });
    const ask = callback();
    expect(await ask({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
    expect(asked).toHaveLength(1);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2" } });
    answer = async () => ({ allow: false, reason: "denied by the user" });
    expect(await ask({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
  });

  it("This workspace covers calls in that workspace from any conversation, and persists", async () => {
    answer = async () => ({ allow: true, scope: "workspace" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN))).toBe(true);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, sessionId: "session-2" } });
    // A fresh store (an app restart) reads the grant back from disk.
    grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
    answer = async () => ({ allow: false, reason: "denied by the user" });
    const restarted = callback();
    expect(await restarted({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).toBe(true);
    owners.set(OTHER_SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, workspaceRoot: "/work/other" } });
    expect(await restarted({ host: "github.com", port: 443 }, listener(OTHER_SHELL_TOKEN))).not.toBe(true);
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
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, workspaceRoot: undefined },
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
    answer = async () => ({ allow: true, scope: "workspace" });
    const unoffered = await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN));
    expect(unoffered).toEqual({ allow: false, reason: `${EGRESS_DENY_REASONS.failed}: egress grant: scope workspace was not offered` });
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
    expect(asked[0]).toMatchObject({ destination: { host: shown, port: 8080 }, scopes: ["once", "conversation"], network: "local" });
  });

  it("asks by name, then shows the card again when the name resolves to a private address, and refuses a reserved one", async () => {
    answer = async () => ({ allow: true, scope: "conversation" });
    expect(await callback()({ host: "nas.example", port: 445 }, listener(SHELL_TOKEN, ["10.20.30.40"]))).toBe(true);
    // The name card (public) came first; its answer was held, not granted,
    // because the name turned out to be private: the local card decided.
    expect(asked.map((request) => [request.network, request.scopes])).toEqual([
      ["public", ["once", "conversation", "workspace", "always"]],
      ["local", ["once", "conversation"]],
    ]);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "prompt", "conversation"]]);
    expect(await callback()({ host: "meta.example", port: 80 }, listener(SHELL_TOKEN, ["169.254.169.254"])))
      .toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    expect(asked.map((request) => request.destination.host)).toEqual(["nas.example", "nas.example", "meta.example"]);
    expect(await grants.matchingScope({ token: SHELL_TOKEN, sessionId: "session-1", workspaceRoot: "/work/project" }, { host: "meta.example", port: 80 }))
      .toBeUndefined();
  });

  it("turns an answer given by name into the grant it chose when the name resolves to what the card said", async () => {
    answer = async () => ({ allow: true, scope: "workspace" });
    expect(await callback()({ host: "github.com", port: 443 }, listener(SHELL_TOKEN, ["140.82.112.3"]))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([["allow", "prompt", "workspace"]]);
    expect(await grants.matchingScope({ token: OTHER_SHELL_TOKEN, sessionId: "session-2", workspaceRoot: "/work/project" }, { host: "github.com", port: 443 }))
      .toBe("workspace");
  });

  it("writes no grant and no audit row for a name-phase allow the resolved phase never confirms", async () => {
    answer = async () => ({ allow: true, scope: "always" });
    const raw = rawCallback();
    expect(await raw({ host: "github.com", port: 443 }, { attributionKey: SHELL_TOKEN, identity: "listener", phase: "name" })).toBe(true);
    expect(audit).toEqual([]);
    expect(await grants.matchingScope({ token: SHELL_TOKEN, sessionId: "session-1", workspaceRoot: "/work/project" }, { host: "github.com", port: 443 }))
      .toBeUndefined();
  });

  it("ends every refusal it can make from the name in the name phase", async () => {
    const raw = rawCallback();
    const byName = (token: string | undefined, host: string, port = 443) =>
      raw({ host, port }, { attributionKey: token, identity: "listener", phase: "name" });
    expect(await byName(undefined, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await byName("f".repeat(32), "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.unattributed });
    expect(await byName(WORKER_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.workerOffList });
    expect(await byName(TERMINAL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.terminal });
    expect(await byName(SHELL_TOKEN, "169.254.169.254", 80)).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.reserved });
    askEnabled = false;
    expect(await byName(SHELL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.askOff });
    askEnabled = true;
    owners.set(SHELL_TOKEN, { ...interactiveShell, context: { ...interactiveShell.context, approvalSurface: "unavailable" } });
    expect(await byName(SHELL_TOKEN, "x.attacker.example")).toEqual({ allow: false, reason: EGRESS_DENY_REASONS.headless });
    expect(asked).toEqual([]);
  });

  it("does not let an Always grant for a name cover it once it resolves to a private address", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, workspaceRoot: undefined },
      { host: "rebind.example", port: 443 });
    expect(await callback()({ host: "rebind.example", port: 443 }, listener(SHELL_TOKEN, ["93.184.215.14"]))).toBe(true);
    expect(asked).toHaveLength(0);
    expect(await callback()({ host: "rebind.example", port: 443 }, listener(SHELL_TOKEN, ["192.168.0.10"])))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ network: "local", scopes: ["once", "conversation"] });
  });

  it("treats a name the upstream proxy resolves as unverified: at most this conversation, and an Always grant does not cover it", async () => {
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, workspaceRoot: undefined },
      { host: "intranet.corp.test", port: 443 });
    expect(await callback()({ host: "intranet.corp.test", port: 443 }, listener(SHELL_TOKEN, [], "upstream")))
      .toEqual({ allow: false, reason: "denied by the user" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ destination: { host: "intranet.corp.test", port: 443 }, scopes: ["once", "conversation"], network: "unverified" });
    // The same name, resolved and pinned here, is public: the grant covers it.
    expect(await callback()({ host: "intranet.corp.test", port: 443 }, listener(SHELL_TOKEN, ["93.184.215.14"]))).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("keeps a local-network name local even when the upstream resolves it", async () => {
    await callback()({ host: "nas.local", port: 445 }, listener(SHELL_TOKEN, [], "upstream"));
    expect(asked[0]).toMatchObject({ network: "local", scopes: ["once", "conversation"] });
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
    await grants.grant("always", ["always"], { token: SHELL_TOKEN, sessionId: undefined, workspaceRoot: undefined },
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
