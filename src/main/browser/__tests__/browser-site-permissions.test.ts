import { refuseNamespaceFileCreation } from "../../../__tests__/support/feature-namespace.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSitePermissionPolicy, type BrowserPermissionContext } from "../browser-site-permissions.js";
import { BrowserWorkspaceStore } from "../browser-workspace-store.js";
import type { FeatureNamespaceHandle } from "../../storage/feature-namespace.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ave-browser-policy-")); directories.push(dir);
  const namespace: FeatureNamespaceHandle = { dir, createFile: refuseNamespaceFileCreation, readJson: async (_name, fallback) => fallback, writeJson: async () => undefined, childDir: async () => dir };
  const store = new BrowserWorkspaceStore(namespace);
  let context: BrowserPermissionContext | null = { guestId: 7, windowId: 1, documentGeneration: 1, url: "https://site.example/" };
  const prompt = vi.fn(async () => true);
  const policy = new BrowserSitePermissionPolicy({ store, currentContext: (id) => id === 7 ? context : null, prompt, fullscreenAvailable: () => false });
  return { store, policy, prompt, setContext: (next: BrowserPermissionContext | null) => { context = next; } };
}
const DETAILS = { requestingUrl: "https://site.example/", isMainFrame: true };

describe("browser site permission decisions", () => {
  it("prompts for the actual site and keeps an allow-once grant within its current document", async () => {
    const { policy, prompt, setContext } = await setup();
    expect(policy.check(7, "geolocation", DETAILS)).toBe(false);
    expect(await policy.request(7, "geolocation", DETAILS)).toBe(true);
    expect(prompt).toHaveBeenCalledWith({ windowId: 1, origin: "https://site.example", permissions: ["geolocation"] });
    expect(policy.check(7, "geolocation", DETAILS)).toBe(true);
    setContext({ guestId: 7, windowId: 1, documentGeneration: 2, url: "https://site.example/" });
    expect(policy.check(7, "geolocation", DETAILS)).toBe(false);
  });
  it("never inherits grants into subframes, redirects, unrelated guests or unknown capabilities", async () => {
    const { policy, store, prompt } = await setup();
    await store.setSitePermission({ origin: "https://site.example", permission: "camera", decision: "allow" });
    expect(policy.check(7, "media", { ...DETAILS, mediaType: "video" })).toBe(true);
    for (const details of [{ ...DETAILS, isMainFrame: false }, { ...DETAILS, requestingUrl: "https://other.example/" }, { requestingUrl: "https://site.example/" }]) expect(await policy.request(7, "media", { ...details, mediaTypes: ["video"] })).toBe(false);
    expect(await policy.request(8, "media", { ...DETAILS, mediaTypes: ["video"] })).toBe(false);
    for (const permission of ["midi", "display-capture", "automatic-fullscreen"]) expect(await policy.request(7, permission, DETAILS)).toBe(false);
    expect(await policy.request(7, "media", { ...DETAILS, mediaTypes: ["unknown"] })).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(policy.check(7, "clipboard-sanitized-write", DETAILS)).toBe(true);
    expect(policy.check(7, "clipboard-sanitized-write", { isMainFrame: false })).toBe(true);
    expect(policy.check(8, "clipboard-sanitized-write", DETAILS)).toBe(false);
  });
  it("requires every media capability and makes a block override a temporary grant", async () => {
    const { policy, store, prompt } = await setup();
    await store.setSitePermission({ origin: "https://site.example", permission: "camera", decision: "allow" });
    expect(await policy.request(7, "media", { ...DETAILS, mediaTypes: ["audio", "video"] })).toBe(true);
    expect(prompt).toHaveBeenCalledWith({ windowId: 1, origin: "https://site.example", permissions: ["microphone"] });
    await store.setSitePermission({ origin: "https://site.example", permission: "microphone", decision: "block" });
    expect(policy.check(7, "media", { ...DETAILS, mediaType: "audio" })).toBe(false);
    expect(await policy.request(7, "media", { ...DETAILS, mediaTypes: ["audio", "video"] })).toBe(false);
  });
  it("rejects a prompt response after navigation or destruction", async () => {
    const { policy, prompt, setContext } = await setup();
    let finish!: (value: boolean) => void;
    prompt.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = policy.request(7, "notifications", DETAILS);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    setContext(null);
    finish(true);
    expect(await pending).toBe(false);
  });
  it("keeps fullscreen denied without a trusted exit affordance", async () => {
    const { policy, store, prompt } = await setup();
    await store.setSitePermission({ origin: "https://site.example", permission: "fullscreen", decision: "allow" });
    expect(policy.check(7, "fullscreen", DETAILS)).toBe(false);
    expect(await policy.request(7, "fullscreen", DETAILS)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});
