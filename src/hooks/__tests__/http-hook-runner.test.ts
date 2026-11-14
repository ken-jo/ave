import { promises as dns } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";
import { MAX_HOOK_STDOUT_BYTES } from "../script-hook-types.js";
import { MAX_HTTP_HOOK_BODY_BYTES, parseHttpHookDefinition, runHttpHook, type HttpHookRuntime } from "../http-hook-runner.js";
import { parseHookConfig } from "../hook-config.js";
import { buildHookRegistry } from "../hook-registry.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { resolveTurnExtensionPolicy, turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

const TARGET = "https://hooks.example.com/check";
const definition = { url: TARGET, method: "POST" as const };

function harness(response: () => Promise<Response> = async () => new Response('{"action":"allow"}')) {
  const send = vi.fn<typeof fetch>(async () => response());
  const auditTarget = vi.fn();
  const runtime: HttpHookRuntime = {
    transport: directHostFetchTransport(send as typeof fetch), allowedUrls: [TARGET], allowedEnvVars: [], auditTarget,
  };
  const run = (payload: unknown = { input: { path: "ordinary.txt" } }, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    runHttpHook(definition, payload, { hookId: "config:PreToolUse#0.0", runtime, ...options });
  return { send, auditTarget, runtime, run };
}

function controller() {
  const sessionId = "http-hook-session";
  let current = true;
  let ownerAvailable = true;
  const refreshCurrent = vi.fn(async () => { current = ownerAvailable; return current; });
  const authority = bindRemoteControllerToSession({
    kind: "tailnet-controller", actorId: "tailnet:http-hook-controller",
    pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
    pairedShareGuard: { isCurrent: () => current, refreshCurrent },
  }, sessionId);
  return { sessionId, authority, refreshCurrent,
    revokeIdentity: () => { ownerAvailable = false; }, revoke: () => { current = false; } };
}

beforeEach(() => {
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("HTTP hook admission", () => {
  it("refreshes controller identity after target audit and records revocation without sending", async () => {
    const fixture = harness();
    const remote = controller();
    let probesAtAudit = 0;
    fixture.auditTarget.mockImplementation(async (entry) => {
      if (entry.outcome === "allowed") {
        probesAtAudit = remote.refreshCurrent.mock.calls.length;
        remote.revokeIdentity();
      }
    });
    await expect(turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(remote.authority),
      () => fixture.run({ sessionId: remote.sessionId }))).rejects.toThrow("controller authority");
    expect(remote.refreshCurrent.mock.calls.length).toBeGreaterThan(probesAtAudit);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.auditTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "denied", failureReason: "controller-authority-revoked",
    }));
  });

  it("refreshes controller identity after asynchronous destination checks", async () => {
    const fixture = harness();
    const remote = controller();
    vi.mocked(dns.lookup).mockImplementation(async () => {
      remote.revokeIdentity();
      return [{ address: "93.184.216.34", family: 4 }] as never;
    });
    await expect(turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(remote.authority),
      () => fixture.run({ sessionId: remote.sessionId }))).rejects.toThrow("controller authority");
    expect(remote.refreshCurrent).toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.auditTarget).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects controller revocation during deferred transport handoff without sending", async () => {
    const fixture = harness();
    const remote = controller();
    fixture.runtime.transport.sendWithHandoff = async (input, init, beforeSend) => {
      await Promise.resolve();
      remote.revoke();
      beforeSend();
      return fixture.send(input, init);
    };
    await expect(turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(remote.authority),
      () => fixture.run({ sessionId: remote.sessionId }))).rejects.toThrow("controller authority");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.auditTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "denied", failureReason: "controller-authority-revoked",
    }));
  });

  it("refuses a controller bound to another session", async () => {
    const fixture = harness();
    const remote = controller();
    await expect(turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(remote.authority),
      () => fixture.run({ sessionId: "another-session" }))).rejects.toThrow("controller authority");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("retains a current bound controller through fresh egress checks", async () => {
    const fixture = harness();
    const remote = controller();
    let probesAtAudit = 0;
    fixture.auditTarget.mockImplementation(async (entry) => {
      if (entry.outcome === "allowed") probesAtAudit = remote.refreshCurrent.mock.calls.length;
    });
    fixture.send.mockImplementation(async () => {
      expect(remote.refreshCurrent.mock.calls.length).toBeGreaterThan(probesAtAudit);
      return new Response('{"action":"allow"}');
    });
    await expect(turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(remote.authority),
      () => fixture.run({ sessionId: remote.sessionId }))).resolves.toHaveProperty("stdout");
    expect(fixture.send).toHaveBeenCalledOnce();
  });

  it("requires an explicitly configured host transport and allowlist", async () => {
    await expect(runHttpHook(definition, {}, { hookId: "hook" })).rejects.toThrow("network policy is not configured");
    const fixture = harness();
    fixture.runtime.allowedUrls = [];
    await expect(fixture.run()).rejects.toThrow("not allowlisted");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.auditTarget).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", target: new URL(TARGET).origin, routeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
  });

  it.each(["*", "*.example.com", "https://*.example.com/check", "https://hooks.example.com/*"])("rejects wildcard declaration %s", async (entry) => {
    const fixture = harness();
    fixture.runtime.allowedUrls = [entry];
    await expect(fixture.run()).rejects.toThrow("allowlist is invalid");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("matches a host exactly without granting its subdomains", async () => {
    const fixture = harness();
    fixture.runtime.allowedUrls = ["hooks.example.com"];
    await expect(fixture.run()).resolves.toHaveProperty("stdout");
    fixture.runtime.allowedUrls = ["example.com"];
    await expect(fixture.run()).rejects.toThrow("not allowlisted");
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it("honors an explicitly declared default port", async () => {
    const fixture = harness();
    fixture.runtime.allowedUrls = ["hooks.example.com:443"];
    await expect(fixture.run()).resolves.toHaveProperty("stdout");
    fixture.runtime.allowedUrls = ["hooks.example.com:8443"];
    await expect(fixture.run()).rejects.toThrow("not allowlisted");
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it("requires the complete configured URL and refuses credentials", async () => {
    const fixture = harness();
    fixture.runtime.allowedUrls = ["https://hooks.example.com/other"];
    await expect(fixture.run()).rejects.toThrow("not allowlisted");
    expect(() => parseHttpHookDefinition({ url: "https://user:password@hooks.example.com/check" })).toThrow("URL is invalid");
  });

  it.each(["GET", "DELETE", "post"])("refuses method %s", (method) => {
    expect(() => parseHttpHookDefinition({ url: TARGET, method })).toThrow("require POST");
  });

  it("retains the existing DNS-aware host network boundary", async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    const fixture = harness();
    await expect(fixture.run()).rejects.toThrow("failed network policy");
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

describe("HTTP hook request and response bounds", () => {
  it("sends JSON through the host handoff and audits the target before sending", async () => {
    const fixture = harness(async () => {
      expect(fixture.auditTarget).toHaveBeenCalledWith(expect.objectContaining({ outcome: "allowed", target: new URL(TARGET).origin }));
      return new Response('{"action":"allow"}');
    });
    await fixture.run({ input: "hello" });
    expect(fixture.send).toHaveBeenCalledWith(TARGET, expect.objectContaining({
      method: "POST", redirect: "manual", body: '{"input":"hello"}', signal: expect.any(AbortSignal),
    }));
  });

  it.each([301, 302, 303, 307, 308])("refuses redirect status %s without another request", async (status) => {
    const fixture = harness(async () => new Response(null, { status, headers: { location: "https://evil.example/collect" } }));
    await expect(fixture.run()).rejects.toThrow("redirects are refused");
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it("caps UTF-8 request bytes before egress", async () => {
    const fixture = harness();
    await expect(fixture.run({ text: "가".repeat(MAX_HTTP_HOOK_BODY_BYTES / 2) })).rejects.toThrow("request exceeds size limit");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("caps a response with no declared size while consuming its stream", async () => {
    const fixture = harness(async () => new Response("x".repeat(MAX_HOOK_STDOUT_BYTES + 1)));
    await expect(fixture.run()).rejects.toThrow("response exceeds size limit");
  });

  it("rejects an oversized response declaration before reading", async () => {
    const fixture = harness(async () => new Response("small", { headers: { "content-length": String(MAX_HOOK_STDOUT_BYTES + 1) } }));
    await expect(fixture.run()).rejects.toThrow("response exceeds size limit");
  });

  it("cancels transport on the bounded hook deadline", async () => {
    vi.useFakeTimers();
    const fixture = harness(async () => new Promise(() => {}));
    const result = fixture.run({}, { timeoutMs: 10 }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(11);
    await expect(result).resolves.toHaveProperty("message", "HTTP hook timed out");
    expect((fixture.send.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  });

  it("cancels a response reader when its parent aborts", async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const fixture = harness(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const pending = fixture.run({}, { signal: controller.signal }).catch((error: Error) => error);
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toHaveProperty("message", "HTTP hook cancelled");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});

describe("HTTP hook secret boundaries", () => {
  it("interpolates only explicitly allowlisted header variables", async () => {
    const fixture = harness();
    fixture.runtime.allowedEnvVars = ["HOOK_TOKEN"];
    fixture.runtime.environment = { HOOK_TOKEN: "fixture-secret-value" };
    await runHttpHook({ ...definition, headers: { authorization: `Bearer $${"{HOOK_TOKEN}"}`, "x-token": "$HOOK_TOKEN" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    const init = (fixture.send.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-secret-value");
    expect(JSON.stringify(fixture.auditTarget.mock.calls)).not.toContain("fixture-secret-value");
  });

  it("refuses unallowlisted or missing header variables and control characters", async () => {
    const fixture = harness();
    const run = () => runHttpHook({ ...definition, headers: { authorization: "$HOOK_TOKEN" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    await expect(run()).rejects.toThrow("variable is unavailable");
    fixture.runtime.allowedEnvVars = ["HOOK_TOKEN"];
    await expect(run()).rejects.toThrow("variable is unavailable");
    fixture.runtime.environment = { HOOK_TOKEN: "fixture\r\nsecret" };
    await expect(run()).rejects.toThrow("header value is invalid");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("never exposes transport exception or URL query secrets", async () => {
    const fixture = harness(async () => { throw new Error("HTTP hook transport fixture-secret-value"); });
    const url = `${TARGET}?token=query-secret-value`;
    fixture.runtime.allowedUrls = [url];
    await expect(runHttpHook({ ...definition, url }, {}, { hookId: "hook", runtime: fixture.runtime })).rejects.toThrow(/^HTTP hook request failed$/u);
    expect(JSON.stringify(fixture.auditTarget.mock.calls)).not.toMatch(/fixture-secret-value|query-secret-value/u);
  });

  it("records a route digest without exposing a credential embedded in its path", async () => {
    const fixture = harness();
    const url = "https://hooks.example.com/route-secret-value?token=query-secret-value";
    fixture.runtime.allowedUrls = [url];
    await runHttpHook({ ...definition, url }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(fixture.auditTarget).toHaveBeenCalledWith(expect.objectContaining({ target: "https://hooks.example.com", routeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(JSON.stringify(fixture.auditTarget.mock.calls)).not.toMatch(/route-secret-value|query-secret-value/u);
  });

  it("revalidates trusted definition after asynchronous target audit and before sending", async () => {
    const fixture = harness();
    let trusted = true;
    fixture.runtime.auditTarget = async (entry) => { if (entry.outcome === "allowed") trusted = false; };
    await expect(runHttpHook(definition, {}, { hookId: "hook", runtime: fixture.runtime, validateTrust: () => trusted })).rejects.toThrow("definition changed");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("redacts reflected header and environment secrets before output parsing", async () => {
    const token = 'fixture-"secret"-value';
    const fixture = harness(async () => new Response(JSON.stringify({ action: "allow", reason: `Bearer ${token}`,
      hookSpecificOutput: { additionalContext: token, updatedInput: { message: token } } })));
    fixture.runtime.allowedEnvVars = ["HOOK_TOKEN"];
    fixture.runtime.environment = { HOOK_TOKEN: token };
    const result = await runHttpHook({ ...definition, headers: { authorization: "Bearer $HOOK_TOKEN" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(result.stdout).not.toContain("fixture-");
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "allow", reason: "[REDACTED]", hookSpecificOutput: { additionalContext: "[REDACTED]", updatedInput: { message: "[REDACTED]" } } });
    expect(JSON.stringify(fixture.auditTarget.mock.calls)).not.toContain("fixture-");
  });

  it("preserves decision literals that coincide with ordinary static headers", async () => {
    const fixture = harness();
    const result = await runHttpHook({ ...definition, headers: { "x-mode": "allow" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(JSON.parse(result.stdout)).toEqual({ action: "allow" });
  });

  it("redacts arbitrary static header values from reason, context, input and payload keys", async () => {
    const token = "fixture-static-password";
    const fixture = harness(async () => new Response(JSON.stringify({ action: "modify", reason: token, additionalContext: token,
      updatedInput: { action: "allow", [token]: token } })));
    const result = await runHttpHook({ ...definition, headers: { "X-Hook-Password": token, "x-mode": "allow" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(JSON.parse(result.stdout)).toEqual({ action: "modify", reason: "[REDACTED]", additionalContext: "[REDACTED]",
      updatedInput: { action: "[REDACTED]", "[REDACTED]": "[REDACTED]" } });
    expect(result.stdout).not.toContain(token);
  });

  it("preserves only validated protocol literals at exact schema paths", async () => {
    const fixture = harness(async () => new Response(JSON.stringify({ decision: "allow", hookSpecificOutput: {
      hookEventName: "PermissionRequest", permissionDecision: "deny", decision: { behavior: "allow", message: "allow", updatedInput: { action: "allow", hookEventName: "PermissionRequest", permissionDecision: "deny", decision: { behavior: "allow" } } },
    } })));
    const result = await runHttpHook({ ...definition, headers: { "x-mode": "allow", "x-event": "PermissionRequest", "x-decision": "deny" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(JSON.parse(result.stdout)).toEqual({ decision: "allow", hookSpecificOutput: {
      hookEventName: "PermissionRequest", permissionDecision: "deny", decision: { behavior: "allow", message: "[REDACTED]", updatedInput: { action: "[REDACTED]", hookEventName: "[REDACTED]", permissionDecision: "[REDACTED]", decision: { behavior: "[REDACTED]" } } },
    } });
  });

  it("redacts static credential headers and rejects malformed feedback without echoing it", async () => {
    const fixture = harness(async () => new Response('{"action":"allow","reason":"fixture-static-token"}'));
    const result = await runHttpHook({ ...definition, headers: { authorization: "Bearer fixture-static-token" } }, {}, { hookId: "hook", runtime: fixture.runtime });
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "allow", reason: "[REDACTED]" });
    fixture.send.mockImplementation(async () => new Response("malformed fixture-static-token"));
    await expect(runHttpHook({ ...definition, headers: { authorization: "Bearer fixture-static-token" } }, {}, { hookId: "hook", runtime: fixture.runtime })).rejects.toThrow(/^HTTP hook response is invalid$/u);
  });
});

describe("HTTP hook config and registry", () => {
  it("normalizes HTTP handlers with the same event and matcher contract", () => {
    const parsed = parseHookConfig({ hooks: { PreToolUse: [{ matcher: "read_file", hooks: [{ type: "http", url: TARGET }] }] } });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries[0]).toMatchObject({ handlerType: "http", command: [], http: definition, event: "pre" });
    const registry = buildHookRegistry([], parsed.entries);
    expect(registry[0]).toMatchObject({ handlerType: "http", http: definition });
    expect(registry[0].matchesSubject("read_file")).toBe(true);
    expect(registry[0].matchesSubject("write_file")).toBe(false);
  });

  it("rejects unsafe HTTP definitions without embedding header values in diagnostics", () => {
    const parsed = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "http", url: TARGET, headers: { authorization: "fixture-secret\nvalue" } }] }] } });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).not.toContain("fixture-secret");
  });
});
