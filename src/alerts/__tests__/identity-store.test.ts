/**
 * The alert id is an HMAC under this install's secret, and the identity
 * tables persist ids and enums only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { alertIdFor, loadInstallSecret } from "../identity.js";
import {
  AlertStore,
  MAX_CLOSED_PER_PLUGIN,
  MAX_REFRESHES_PER_WINDOW,
  REFRESH_WINDOW_MS,
  type OpenAlert,
} from "../store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ave-alerts-identity-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("install secret and alert id", () => {
  it("creates the secret once and reads the same one back", async () => {
    const first = await loadInstallSecret(dir);
    const second = await loadInstallSecret(dir);
    expect(first.length).toBe(32);
    expect(second.equals(first)).toBe(true);
  });

  it("replaces a damaged secret file with a fresh secret", async () => {
    await writeFile(join(dir, "install-secret.json"), JSON.stringify({ version: 1, secret: "short" }));
    const secret = await loadInstallSecret(dir);
    expect(secret.length).toBe(32);
  });

  it("keys the id by the secret, so the same key under another install is a different id", async () => {
    const secret = await loadInstallSecret(dir);
    const id = alertIdFor(secret, "fixturemail", "reply", "mail-1");
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(alertIdFor(secret, "fixturemail", "reply", "mail-1")).toBe(id);
    expect(alertIdFor(Buffer.alloc(32, 1), "fixturemail", "reply", "mail-1")).not.toBe(id);
    // Not a plain hash of the guessable key.
    const plain = createHmac("sha256", Buffer.alloc(0)).update("fixturemail\0reply\0mail-1").digest("base64url");
    expect(plain.slice(0, 32)).not.toBe(id);
  });

  it("separates the parts, so shifting text between kind and key changes the id", async () => {
    const secret = await loadInstallSecret(dir);
    expect(alertIdFor(secret, "fixturemail", "re", "ply-1")).not.toBe(alertIdFor(secret, "fixturemail", "rep", "ly-1"));
  });
});

function open(alertId: string, overrides: Partial<OpenAlert> = {}): OpenAlert {
  return {
    alertId,
    pluginId: "fixturemail",
    kindId: "reply",
    priority: "normal",
    visibility: "user-visible",
    raisedAt: 1_000,
    expiresAt: 100_000,
    refreshes: [],
    ...overrides,
  };
}

describe("AlertStore", () => {
  it("persists open and closed identities across a reload, and drops what expired meanwhile", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("a"));
    store.add(open("b", { expiresAt: 5_000 }));
    store.add(open("c"));
    store.close("c");
    await store.flush();

    const reloaded = new AlertStore(() => dir);
    await reloaded.load(10_000);
    expect(reloaded.getOpen("a")?.alertId).toBe("a");
    expect(reloaded.getOpen("b")).toBeUndefined();
    expect(reloaded.isClosed("c", 10_000)).toBe(true);
    expect(reloaded.isClosed("c", 100_000)).toBe(false);
  });

  it("writes only ids, kind ids and enums", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("a"));
    await store.flush();
    const file = JSON.parse(await readFile(join(dir, "open.json"), "utf-8")) as { open: Array<Record<string, unknown>> };
    expect(Object.keys(file.open[0]!).sort()).toEqual(
      ["alertId", "expiresAt", "kindId", "pluginId", "priority", "raisedAt", "refreshes", "visibility"],
    );
  });

  it("evicts the lowest priority first, then the oldest, past three per kind", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("high", { priority: "high", raisedAt: 1 }));
    store.add(open("old", { raisedAt: 2 }));
    store.add(open("new", { raisedAt: 3 }));
    expect(store.add(open("fourth", { raisedAt: 4 })).map((gone) => gone.alertId)).toEqual(["old"]);
    store.add(open("low", { priority: "low", raisedAt: 5 }));
    expect(store.add(open("sixth", { raisedAt: 6 })).map((gone) => gone.alertId)).toEqual(["low"]);
    // Another kind has its own three.
    expect(store.add(open("other", { kindId: "digest", raisedAt: 7 }))).toEqual([]);
  });

  it("allows a bounded number of refreshes per window and changes nothing past it", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("a"));
    for (let i = 0; i < MAX_REFRESHES_PER_WINDOW; i += 1) {
      expect(store.refresh("a", 10 + i, { expiresAt: 200_000, priority: "high" })).toBe(true);
    }
    expect(store.refresh("a", 20, { expiresAt: 300_000, priority: "low" })).toBe(false);
    expect(store.getOpen("a")).toMatchObject({ expiresAt: 200_000, priority: "high" });
    expect(store.refresh("a", 10 + REFRESH_WINDOW_MS, { expiresAt: 300_000, priority: "low" })).toBe(true);
  });

  it("keeps at most the newest closed identities per plugin", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    for (let i = 0; i <= MAX_CLOSED_PER_PLUGIN; i += 1) {
      store.add(open(`id${i}`, { kindId: `k${i}` }));
      store.close(`id${i}`);
    }
    expect(store.isClosed("id0", 0)).toBe(false);
    expect(store.isClosed("id1", 0)).toBe(true);
    expect(store.isClosed(`id${MAX_CLOSED_PER_PLUGIN}`, 0)).toBe(true);
  });

  it("expires open identities at their lifetime and forgets closed ones past theirs", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("a", { expiresAt: 50 }));
    store.add(open("b", { expiresAt: 500, kindId: "digest" }));
    store.close("b");
    expect(store.expire(50).map((gone) => gone.alertId)).toEqual(["a"]);
    expect(store.isClosed("b", 60)).toBe(true);
    store.expire(500);
    expect(store.isClosed("b", 400)).toBe(false);
  });

  it("removes an uninstalled plugin's open identities but keeps its closed ones", async () => {
    const store = new AlertStore(() => dir);
    await store.load(0);
    store.add(open("a"));
    store.add(open("b", { kindId: "digest" }));
    store.close("b");
    store.add(open("c", { pluginId: "otherfixture" }));
    expect(store.removePlugin("fixturemail").map((gone) => gone.alertId)).toEqual(["a"]);
    expect(store.isClosed("b", 0)).toBe(true);
    expect(store.getOpen("c")).toBeDefined();
  });
});
