// A scheduled wake turn runs with `withholdSessionAuthority`: it reads no conversation-scope allow, no "This session" rule allow,
// no session egress grant and no shared browser/terminal surface choice. Denies still apply, and the next ordinary turn in the
// same conversation keeps every allow (permission tree, "Delegated work"; the decision order is unchanged).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_HOME = join(tmpdir(), `ave-test-withheld-${randomBytes(4).toString("hex")}`);
process.env.AVE_HOME = TEST_HOME;

import { inScheduledWake as wake } from "../../__tests__/support/scheduled-wake.js";
import { withholdSessionAuthorityFor } from "../../shared/turn-extension-policy.js";
import { recordApproval, lookupUserDecision, __resetSessionStoreForTest, setApprovalConversationRootResolver } from "../user-approval-store.js";
import { PermissionManager } from "../permission-manager.js";
import { EgressGrantStore } from "../egress-grants.js";
import { issueUserOwnedBrowserScope } from "../user-owned-browser-scope.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

let directory: string;
beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  __resetSessionStoreForTest();
  directory = mkdtempSync(join(tmpdir(), "ave-withheld-"));
});
afterEach(async () => {
  __resetSessionStoreForTest();
  await cleanupTmpDir(directory);
  await cleanupTmpDir(TEST_HOME);
});

describe("remembered conversation decisions", () => {
  it("ignores a conversation allow inside the wake turn and keeps it for the next ordinary turn", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", { scope: "session", sessionId: SESSION, verdictAtApproval: "medium", nlJustification: null });
    const lookup = () => lookupUserDecision("bash_run", '{"command":"ls"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    expect(await wake(lookup)).toBeNull();
    expect((await lookup())?.decision).toBe("allow");
  });

  it("still applies a conversation deny inside the wake turn", async () => {
    await recordApproval("bash_run", '{"command":"rm x"}', "user-keyboard", { scope: "session", sessionId: SESSION, decision: "deny", verdictAtApproval: "medium", nlJustification: null });
    const hit = await wake(() => lookupUserDecision("bash_run", '{"command":"rm x"}', "user-keyboard", undefined, undefined, undefined, SESSION));
    expect(hit?.decision).toBe("deny");
  });

  it("still applies an allow the user saved for every conversation", async () => {
    await recordApproval("bash_run", '{"command":"pwd"}', "user-keyboard", { scope: "global", verdictAtApproval: "medium", nlJustification: null });
    const hit = await wake(() => lookupUserDecision("bash_run", '{"command":"pwd"}', "user-keyboard", undefined, undefined, undefined, SESSION));
    expect(hit?.decision).toBe("allow");
  });
});

describe("\"This session\" rules", () => {
  const DESTINATION = { host: "api.example.com", port: 443, source: "builtin", network: "public", ruleScopes: ["session"] } as const;

  it("ignores a session network allow inside the wake turn and keeps it for the next ordinary turn", async () => {
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("default");
    manager.addSessionRule(SESSION, "Network(api.example.com:443)");
    const woken = await wake(() => manager.checkNetworkPermission(DESTINATION, { sessionId: SESSION }));
    expect(woken.permission.decision).not.toBe("allow");
    const ordinary = await manager.checkNetworkPermission(DESTINATION, { sessionId: SESSION });
    expect(ordinary).toMatchObject({ permission: { decision: "allow" }, rule: { scope: "session" } });
  });
});

describe("shared browser and host terminal choice", () => {
  it("falls back to ask after Allow all, and the next ordinary turn keeps the choice", () => {
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("allow");
    manager.setUserOwnedSurfaceChoice(SESSION, "browser", "allow");
    const check = () => manager.checkDetailed("browser_action", "builtin", "read", undefined, {
      sessionId: SESSION,
      trustOrigin: "llm-tool-arg",
      userOwnedBrowser: issueUserOwnedBrowserScope({ kind: "browser-origin", origin: "https://example.test", tabOpener: "user", tabId: "tab", documentId: 1, controlGeneration: 1 }, () => true),
    });
    expect(wake(check)).toMatchObject({ decision: "ask", reasonCode: "user-owned-surface-ask" });
    expect(check().decision).toBe("allow");
  });
});

describe("session egress grants", () => {
  it("ignores a session grant inside the wake turn and keeps it for the next ordinary turn", async () => {
    const projectRoot = join(directory, "project");
    mkdirSync(projectRoot);
    const store = new EgressGrantStore(join(directory, "shell-egress-hosts.json"));
    const subject = { token: "1".repeat(32), sessionId: SESSION, tabId: undefined, projectRoot, origin: "shell" as const };
    const github = { host: "github.com", port: 443 };
    const scopes = ["once", "session", "project", "always"] as const;
    await store.grant("session", scopes, subject, github);
    expect(await wake(() => store.matchingScope(subject, github, scopes))).toBeUndefined();
    expect(await store.matchingScope(subject, github, scopes)).toBe("session");
  });
});

describe("a session withheld by id, for lookups outside the wake's async context", () => {
  it("withholds a conversation allow and a session rule while held, and counts overlapping wakes", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", { scope: "session", sessionId: SESSION, verdictAtApproval: "medium", nlJustification: null });
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("default");
    manager.addSessionRule(SESSION, "Network(api.example.com:443)");
    const destination = { host: "api.example.com", port: 443, source: "builtin", network: "public", ruleScopes: ["session"] } as const;
    const lookup = () => lookupUserDecision("bash_run", '{"command":"ls"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    const first = withholdSessionAuthorityFor(SESSION);
    const second = withholdSessionAuthorityFor(SESSION);
    expect(await lookup()).toBeNull();
    expect((await manager.checkNetworkPermission(destination, { sessionId: SESSION })).permission.decision).not.toBe("allow");
    first();
    first();
    expect(await lookup()).toBeNull();
    second();
    expect((await lookup())?.decision).toBe("allow");
    expect((await manager.checkNetworkPermission(destination, { sessionId: SESSION })).permission.decision).toBe("allow");
  });
});

describe("a child of the woken chat, by conversation root", () => {
  it("does not use its own session egress grant while the chat is woken", async () => {
    const CHILD = "22222222-2222-4222-8222-222222222222";
    setApprovalConversationRootResolver((id) => (id === CHILD ? SESSION : id));
    try {
      const projectRoot = join(directory, "project");
      mkdirSync(projectRoot);
      const store = new EgressGrantStore(join(directory, "shell-egress-hosts.json"));
      const subject = { token: "4".repeat(32), sessionId: CHILD, tabId: undefined, projectRoot, origin: "shell" as const };
      const github = { host: "github.com", port: 443 };
      const scopes = ["once", "session", "project", "always"] as const;
      await store.grant("session", scopes, subject, github);
      const release = withholdSessionAuthorityFor(SESSION);
      expect(await store.matchingScope(subject, github, scopes)).toBeUndefined();
      release();
      expect(await store.matchingScope(subject, github, scopes)).toBe("session");
    } finally {
      setApprovalConversationRootResolver((id) => id);
    }
  });
});
