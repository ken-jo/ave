import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAveHomePrivacyForTest, ensureAveHomePrivate } from "../../shared/ave-home.js";
import { migrateAveHomeConfiguration } from "../../shared/ave-home-configuration.js";
import { setAveHomeConfigurationOwner } from "../../shared/ave-home-configuration-access.js";
import { _resetAveHomeTrustForTest, approveAveHomeTrustItems, evaluateAveHomeTrustAtBoot, getAveHomeTrustReview, readAveHomeInputSync } from "../../shared/ave-home-trust.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { projectRulesLocation } from "../rules/project-rule-files.js";
import { PermissionManager } from "../permission-manager.js";
import * as permissionsStore from "../permissions-store.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionTestResources } from "./test-resources.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";

const resources = new PermissionTestResources();
const DESTINATION = { host: "api.example.com", port: 443, source: "builtin", network: "public", ruleScopes: ["user"] } as const;
let directory: string;
let manager: PermissionManager;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "network-permission-"));
  manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("default");
});
afterEach(async () => { await resources.cleanup(); await cleanupTmpDir(directory); });

describe("actual network connection pipeline", () => {
  it("applies an exact network deny before floors and remembered registry consent", async () => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "deny" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, { floor: { code: "other-principal", reason: "External influence" } });
    expect(result.permission).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant").decision).toBe("deny");
  });

  it.each(["strict", "default", "auto", "allow"] as const)("retains earlier network grants before an exfiltration guardrail in %s", async mode => {
    manager.setMode(mode);
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const context = { exfiltration: { reason: "Credential upload" } };
    const result = await manager.checkNetworkPermission(DESTINATION, context);
    expect(result.permission).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(result.permission.forceModal).toBeUndefined();
    expect(result.permission.reviewer).toBeUndefined();
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect((await manager.checkNetworkPermission(DESTINATION, { ...context, headless: true })).permission)
      .toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    manager.setRules([]);
    const pending = await manager.checkNetworkPermission(DESTINATION, context);
    expect(pending.permission.decision).toBe(mode === "allow" ? "allow" : "ask");
    expect(pending.permission.forceModal).toBeUndefined();
    expect(pending.permission.reviewer?.route).toBe(mode === "auto" ? "foreground-auto" : undefined);
    expect((await manager.checkNetworkPermission(DESTINATION, { ...context, headless: true })).permission)
      .toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
  });

  it("keeps an explicit network ask before remembered registry consent", async () => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "ask" }]);
    const result = await manager.checkNetworkPermission(DESTINATION);
    expect(result.rule?.decision).toBe("ask");
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
  });

  it.each([
    { network: "public", ruleScopes: ["user"], decision: "allow" },
    { network: "public", ruleScopes: [], decision: "ask" },
    { network: "local", ruleScopes: ["user"], decision: "ask" },
    { network: "unverified", ruleScopes: ["user"], decision: "ask" },
  ] as const)("uses eligible rule scope for $network destinations", async ({ network, ruleScopes, decision }) => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const result = await manager.checkNetworkPermission({ ...DESTINATION, network, ruleScopes });
    expect(result.permission.decision).toBe(decision);
    expect(result.rule?.decision).toBe(decision === "allow" ? "allow" : undefined);
  });

  it("keeps conversation network rules within their actual consent scope", async () => {
    manager.addSessionRule("network-session", "Network(api.example.com:443)");
    const rejectedScope = await manager.checkNetworkPermission(DESTINATION, { sessionId: "network-session" });
    expect(rejectedScope.permission.decision).toBe("ask");
    const allowed = await manager.checkNetworkPermission({ ...DESTINATION, ruleScopes: ["session"] }, { sessionId: "network-session" });
    expect(allowed).toMatchObject({ permission: { decision: "allow" }, rule: { scope: "session" } });
    expect((await manager.checkNetworkPermission({ ...DESTINATION, ruleScopes: ["session"] }, { sessionId: "other-session" })).permission.decision).toBe("ask");
  });

  it("does not inherit enclosing shell or fetch rules and identities", async () => {
    manager.setRules([{ pattern: "Bash(curl *)", action: "allow" }, { pattern: "bash", action: "allow" }, { pattern: "WebFetch(domain:api.example.com)", action: "allow" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, {
      ruleSubject: { kind: "shell", dialect: "bash", command: "curl https://api.example.com", cwd: directory },
      approvalCacheKey: "outer-shell-grant",
    });
    expect(result.permission).toMatchObject({ decision: "ask", pipelineRequest: { tool: { name: "sandbox_network", kind: "network" } } });
    expect(result.reasonKey).toBe(result.permission.reasonCode);
    expect(JSON.parse(result.identity)).toEqual({ kind: "network", host: "api.example.com", port: 443, source: "builtin" });
    const canonical = await manager.checkNetworkPermission({ ...DESTINATION, host: "API.EXAMPLE.COM." });
    expect(canonical.identity).toBe(result.identity);
    expect((await manager.checkNetworkPermission({ ...DESTINATION, port: 8443 })).identity).not.toBe(result.identity);
  });

  it("requires fresh manual approval before remembered network consent", async () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, { manualRerun: true });
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "manual-rerun" });
  });

  it("denies policy corruption and invalid endpoints before grants", async () => {
    manager.setMode("allow");
    const corrupt = await manager.checkNetworkPermission(DESTINATION, { permissionStoreError: "Policy cannot be read" });
    expect(corrupt.permission).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    const invalid = await manager.checkNetworkPermission({ ...DESTINATION, port: 0 });
    expect(invalid.permission).toMatchObject({ decision: "deny", reasonCode: "invalid-network-destination" });
  });

  it.each(["low", "high"] as const)("reviews a headless network effect before its %s fallback", async (level) => {
    manager.setMode("auto");
    setReviewerForTest(manager, { classifier: { classify: () => ({ level, reason: "Actual destination reviewed" }) }, cache: resources.makeVerdictCache(join(directory, "network-review.jsonl")) });
    const result = await manager.checkNetworkPermission(DESTINATION, { headless: true });
    expect(result.permission.reviewer?.route).toBe("headless");
    const review = await manager.dispatchReviewer("sandbox_network", {
      invocationId: "network-effect", sessionId: "network-session", source: "builtin", category: "network",
      pathFields: [], finalInput: result.destination, executionCwd: directory, allowedDirectories: [directory],
      sensitivePathsAdjacent: [], trustOrigin: "user-keyboard", permissionDecision: result.permission,
    }, undefined, { lane: "headless" });
    const decision = manager.resolveReviewedPermission(result.permission, review);
    expect(decision.decision).toBe(level === "low" ? "allow" : "deny");
    if (level === "high") expect(decision.reason).toBe(NO_APPROVER_MESSAGE);
  });
});

describe("user rules at the resolved connection", () => {
  const OTHER = { ...DESTINATION, host: "other.example.com" } as const;
  const headless = { headless: true } as const;
  const userFile = () => join(directory, "permissions.json");
  // Local decides on the asynchronous phase alone. Remote also takes the final synchronous check after its owner probe.
  const decide = async (subject: PermissionManager, destination: typeof DESTINATION | typeof OTHER) => {
    const local = (await subject.checkNetworkPermission(destination, headless)).permission;
    const remote = subject.checkLoadedNetworkPermission(destination, headless).permission;
    return { local: [local.decision, local.reason], remote: [remote.decision, remote.reason] };
  };
  const booted = async () => {
    const fresh = new PermissionManager(userFile());
    fresh.setMode("default");
    await fresh.loadRulesFromFile();
    return fresh;
  };

  it("picks up a hand edit that removes an allow before the next connection, for local and remote alike", async () => {
    await manager.addRulePersist({ pattern: "Network(api.example.com:443)", action: "allow" }, { kind: "user" });
    await manager.addRulePersist({ pattern: "Network(other.example.com:443)", action: "allow" }, { kind: "user" });
    const running = await booted();
    expect(await decide(running, DESTINATION)).toEqual({ local: ["allow", expect.anything()], remote: ["allow", expect.anything()] });
    const edited = JSON.parse(readFileSync(userFile(), "utf8")) as { rules: { pattern: string }[] };
    edited.rules = edited.rules.filter(rule => rule.pattern !== "Network(api.example.com:443)");
    writeFileSync(userFile(), `${JSON.stringify(edited, null, 2)}\n`);
    // A process booted on the edited file is the reference: the running one must decide exactly as it does.
    const reference = await booted();
    for (const destination of [DESTINATION, OTHER]) {
      const expected = await decide(reference, destination);
      expect(await decide(running, destination)).toEqual(expected);
    }
    expect((await decide(running, DESTINATION)).remote).toEqual(["deny", NO_APPROVER_MESSAGE]);
    expect((await decide(running, OTHER)).remote[0]).toBe("allow");
  });

  it.each(["user", "project"] as const)("decides on the withheld %s overlay while review is pending, then on the full file once the review completes", async kind => {
    const home = join(realpathSync(directory), ".ave");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
    setFixtureOwner(directory);
    vi.stubEnv("AVE_HOME", home);
    try {
      const privacy = ensureAveHomePrivate(home);
      expect(privacy.enforcement).not.toBe("none");
      migrateAveHomeConfiguration(home, privacy);
      evaluateAveHomeTrustAtBoot(home);
      const userRules = join(home, "permissions.json");
      const projectCwd = join(realpathSync(directory), "project");
      mkdirSync(projectCwd);
      const scope = kind === "user" ? { kind } as const : { kind, projectCwd } as const;
      const file = kind === "user" ? userRules : projectRulesLocation(home, projectCwd).filePath;
      const writer = new PermissionManager(userRules);
      await writer.addRulePersist({ pattern: "Network(api.example.com:443)", action: "allow" }, scope);
      await writer.addRulePersist({ pattern: "Network(other.example.com:443)", action: "deny" }, scope);
      // Changed outside Ave: at the next boot the file is pending review and loads as its deny-only overlay.
      writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
      _resetAveHomeTrustForTest();
      evaluateAveHomeTrustAtBoot(home);
      expect(readAveHomeInputSync(file)).toMatchObject({ status: "untrusted", reason: "changed" });
      const running = new PermissionManager(userRules);
      running.setMode("default");
      await running.loadRulesFromFile();
      const at = (destination: typeof DESTINATION | typeof OTHER) => kind === "user" ? destination
        : { ...destination, ruleScopes: ["user", "project"] } as unknown as typeof DESTINATION;
      const context = kind === "user" ? headless : { ...headless, projectRulesCwd: projectCwd };
      const decideIn = async (destination: typeof DESTINATION | typeof OTHER) => {
        const local = (await running.checkNetworkPermission(at(destination), context)).permission;
        const remote = running.checkLoadedNetworkPermission(at(destination), context).permission;
        return { local: [local.decision, local.reason], remote: [remote.decision, remote.reason] };
      };
      // Remote decides as local does, on the overlay: its deny applies and the withheld allow does not.
      expect(await decideIn(DESTINATION)).toEqual({ local: ["deny", NO_APPROVER_MESSAGE], remote: ["deny", NO_APPROVER_MESSAGE] });
      expect((await decideIn(OTHER)).remote[0]).toBe("deny");
      const review = getAveHomeTrustReview();
      if (review === undefined) throw new Error("no home-content review is pending");
      expect(approveAveHomeTrustItems(review.snapshotId, review.rows.map(row => row.key))).toBe(1);
      expect(readAveHomeInputSync(file).status).toBe("trusted");
      // The allow exists only in the full file, so this proves the rules were reloaded, not merely the version re-captured.
      expect(await decideIn(DESTINATION)).toEqual({ local: ["allow", expect.anything()], remote: ["allow", expect.anything()] });
    } finally {
      setAveHomeConfigurationOwner(undefined);
      _resetAveHomeTrustForTest();
      _resetAveHomePrivacyForTest();
      vi.unstubAllEnvs();
    }
  });

  it("still denies the remote connection when the file changes after the asynchronous phase", async () => {
    await manager.addRulePersist({ pattern: "Network(api.example.com:443)", action: "allow" }, { kind: "user" });
    const running = await booted();
    expect((await running.checkNetworkPermission(DESTINATION, headless)).permission.decision).toBe("allow");
    // The owner probe is where this edit lands: no reload can run before the synchronous check.
    writeFileSync(userFile(), readFileSync(userFile(), "utf8").replace("\n}", ",\n  \"note\": 1\n}"));
    expect(running.checkLoadedNetworkPermission(DESTINATION, headless).permission)
      .toMatchObject({ decision: "deny", reason: "Permission policy changed before execution." });
  });
});

describe("a user-rules reload keeps restrictions that live only in memory", () => {
  const userFile = () => join(directory, "permissions.json");
  const booted = async () => {
    await manager.addRulePersist({ pattern: "Network(api.example.com:443)", action: "allow" }, { kind: "user" });
    const running = new PermissionManager(userFile());
    running.setMode("default");
    await running.loadRulesFromFile();
    return running;
  };
  // A hand edit the next connection must reload: an unrelated allow added outside Ave.
  const handEdit = () => {
    const edited = JSON.parse(readFileSync(userFile(), "utf8")) as { rules: unknown[] };
    edited.rules.push({ pattern: "Network(other.example.com:443)", action: "allow" });
    writeFileSync(userFile(), `${JSON.stringify(edited, null, 2)}\n`);
  };
  const tool = (subject: PermissionManager, name: string) => subject.checkDetailed(name, "builtin", "read").decision;

  it("keeps a deny whose durable write failed through a later reload", async () => {
    const running = await booted();
    const writer = vi.spyOn(permissionsStore, "updatePermissionsFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(running.addAlwaysDeniedPersist("deny_probe")).rejects.toThrow("disk full");
    } finally {
      writer.mockRestore();
    }
    expect(tool(running, "deny_probe")).toBe("deny");
    handEdit();
    await running.checkNetworkPermission(DESTINATION, { headless: true });
    expect(running.checkLoadedNetworkPermission({ ...DESTINATION, host: "other.example.com" }, { headless: true }).permission.decision).toBe("allow");
    expect(tool(running, "deny_probe")).toBe("deny");
  });

  it.each([
    ["deny", "deny_probe", (subject: PermissionManager) => subject.addAlwaysDeniedPersist("deny_probe")],
    ["ask", "ask_probe", (subject: PermissionManager) => subject.addAlwaysAskedPersist("ask_probe")],
  ] as const)("keeps a %s rule added while a reload is reading the file", async (decision, name, add) => {
    const running = await booted();
    handEdit();
    const reading = deferred<void>();
    const release = deferred<void>();
    const read = permissionsStore.readPermissionsFile;
    const held = vi.spyOn(permissionsStore, "readPermissionsFile").mockImplementationOnce(async (...args) => {
      const file = await read(...args);
      reading.resolve();
      await release.promise;
      return file;
    });
    try {
      const connection = running.checkNetworkPermission(DESTINATION, { headless: true });
      await reading.promise;
      const adding = add(running);
      // Give a writer that does not wait for the reload time to finish its write and its in-memory insert first.
      await Promise.race([adding, new Promise(resolve => setTimeout(resolve, 200))]);
      release.resolve();
      await connection;
      // A deny is active from the moment it is added; an ask becomes active once its write lands.
      if (decision === "deny") expect(tool(running, name)).toBe(decision);
      await adding;
      expect(tool(running, name)).toBe(decision);
    } finally {
      release.resolve();
      held.mockRestore();
    }
  });
});
