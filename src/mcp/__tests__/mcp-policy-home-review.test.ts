// windows-permission
// An organization policy file that exists in the Ave folder but still waits for home content review has no authority yet. Its
// unread rules may forbid user trust, so user servers stay blocked until it is approved, and only an absent file keeps the default.
import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";

configureTestOwner();

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs as tempDirs, useTempPaths as tempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { _resetAveHomePrivacyForTest, ensureAveHomePrivate } from "../../shared/ave-home.js";
import { migrateAveHomeConfiguration } from "../../shared/ave-home-configuration.js";
import { _resetAveHomeTrustForTest, approveAveHomeTrustItems, evaluateAveHomeTrustAtBoot, getAveHomeTrustReview } from "../../shared/ave-home-trust.js";
import { setAveHomeConfigurationOwner } from "../../shared/ave-home-configuration-access.js";
import { ToolRegistry } from "../../tools/registry.js";
import { McpGovernance } from "../mcp-governance.js";
import { McpManager } from "../mcp-manager.js";
import { userServerFingerprint, userServerTrustSecretId } from "../user-server-trust.js";
import type { McpServerConfig } from "../types.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn(async () => undefined) }));
vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = connect;
    disconnect = vi.fn(async () => undefined);
    getState() { return { id: "local-notes", status: "connected", registeredTools: [] }; }
  },
  scrubSecrets: (value: string) => value,
}));

const homes = tempPaths("ave-mcp-policy-review-", ".ave");
const configDirs = tempDirs("ave-mcp-policy-review-config-");
const config: McpServerConfig = { id: "local-notes", transport: "stdio", command: "notes-server", args: ["--profile", "team"] };
const stored = new Map<string, string>();
const secrets = { getSecret: vi.fn(async (key: string) => stored.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
  deleteSecret: vi.fn(async (key: string) => { stored.delete(key); }) };
let configPath: string;

beforeEach(() => {
  connect.mockClear();
  stored.clear();
  configPath = join(configDirs(), "servers.json");
  writeFileSync(configPath, JSON.stringify({ servers: [config] }));
  // The user already trusted this exact launch identity before the policy file arrived.
  stored.set(userServerTrustSecretId(config.id), userServerFingerprint(config));
});

afterEach(() => {
  _resetAveHomeTrustForTest();
  _resetAveHomePrivacyForTest();
  setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  vi.unstubAllEnvs();
});

function home(): string {
  const dir = homes();
  setFixtureOwner(dirname(dir));
  expect(ensureAveHomePrivate(dir).enforcement).not.toBe("none");
  vi.stubEnv("AVE_HOME", dir);
  return dir;
}

/** One boot of the home: commit configuration, then evaluate its trust manifest. */
function boot(dir: string): void {
  _resetAveHomeTrustForTest();
  _resetAveHomePrivacyForTest();
  migrateAveHomeConfiguration(dir, ensureAveHomePrivate(dir));
  evaluateAveHomeTrustAtBoot(dir);
}

function writePolicy(dir: string): string {
  const path = join(dir, "governance", "mcp-policy.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: "1.0", defaultPolicy: "deny", servers: [],
    globalRules: { maxServersTotal: 10, blockedUrlPatterns: [], allowedUrlPatterns: [], policyRefreshIntervalMs: 1800000, allowUserApprovedServers: false } }));
  return path;
}

function manager(policyPath: string): McpManager {
  return new McpManager(new McpGovernance(policyPath), new ToolRegistry(), unusedNetworkFetch, configPath,
    { append: vi.fn(async () => undefined), log: vi.fn() } as never, undefined, undefined, secrets);
}

describe("organization policy awaiting home content review", () => {
  it("blocks user trust, including a stored grant, before and after the restrictive policy is approved", async () => {
    const dir = home();
    const policyPath = writePolicy(dir);
    boot(dir);

    const pending = manager(policyPath);
    const pendingState = await pending.getManagementState();
    expect(pendingState).toMatchObject({ policyStatus: "pending-review", userServersAllowed: false });
    expect(pendingState.servers[config.id]?.trusted).toBe(false);
    expect(new McpGovernance(policyPath).validateUserConfig(config)).toMatchObject({ valid: false });
    await expect(pending.startServer(config.id)).rejects.toThrow("runtime approval not admitted by policy");
    await expect(pending.startServer(config.id, userServerFingerprint(config))).rejects.toThrow("mcp-policy-refused");

    const review = getAveHomeTrustReview();
    assert.exists(review, "Expected the pending policy to be offered for review");
    approveAveHomeTrustItems(review.snapshotId);
    boot(dir);
    const approved = manager(policyPath);
    expect(await approved.getManagementState()).toMatchObject({ policyStatus: "active", userServersAllowed: false });
    await expect(approved.startServer(config.id)).rejects.toThrow("runtime approval not admitted by policy");
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the stored grant usable when no policy file exists", async () => {
    const dir = home();
    boot(dir);
    const policyPath = join(dir, "governance", "mcp-policy.json");
    const owner = manager(policyPath);
    expect(await owner.getManagementState()).toMatchObject({ policyStatus: "absent", userServersAllowed: true });
    await expect(owner.startServer(config.id)).resolves.toEqual({ connected: true });
    expect(connect).toHaveBeenCalledOnce();
  });
});
