import { refuseNamespaceFileCreation } from "../../../__tests__/support/feature-namespace.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSitePermissionPolicy, type BrowserPermissionContext } from "../browser-site-permissions.js";
import { BrowserWorkspaceStore } from "../browser-workspace-store.js";
import type { BrowserPermissionChoice } from "../../../shared/browser-workspace.js";
import type { FeatureNamespaceHandle } from "../../storage/feature-namespace.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ave-browser-policy-")); directories.push(dir);
  const namespace: FeatureNamespaceHandle = { dir, createFile: refuseNamespaceFileCreation, readJson: async (_name, fallback) => fallback, writeJson: async () => undefined, childDir: async () => dir };
  const store = new BrowserWorkspaceStore(namespace);
  let context: BrowserPermissionContext | null = { guestId: 7, windowId: 1, documentGeneration: 1, url: "https://site.example/" };
  const prompt = vi.fn(async (): Promise<BrowserPermissionChoice | null> => "allow-once");
  const policy = new BrowserSitePermissionPolicy({ store, currentContext: (id) => id === 7 ? context : null, prompt, fullscreenAvailable: () => false });
  return { store, policy, prompt, setContext: (next: BrowserPermissionContext | null) => { context = next; } };
}
const DETAILS = { requestingUrl: "https://site.example/", isMainFrame: true };

describe("browser site permission decisions", () => {
  it("prompts for the actual site and keeps an allow-once grant within its current document", async () => {
    const { policy, prompt, setContext } = await setup();
    expect(policy.check(7, "geolocation", DETAILS)).toBe(false);
    expect(await policy.request(7, "geolocation", DETAILS)).toBe(true);
    expect(prompt).toHaveBeenCalledWith({ windowId: 1, guestId: 7, origin: "https://site.example", permissions: ["geolocation"] });
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
    expect(prompt).toHaveBeenCalledWith({ windowId: 1, guestId: 7, origin: "https://site.example", permissions: ["microphone"] });
    await store.setSitePermission({ origin: "https://site.example", permission: "microphone", decision: "block" });
    expect(policy.check(7, "media", { ...DETAILS, mediaType: "audio" })).toBe(false);
    expect(await policy.request(7, "media", { ...DETAILS, mediaTypes: ["audio", "video"] })).toBe(false);
  });
  it("rejects a prompt response after navigation or destruction", async () => {
    const { policy, prompt, setContext } = await setup();
    let finish!: (value: BrowserPermissionChoice | null) => void;
    prompt.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = policy.request(7, "notifications", DETAILS);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    setContext(null);
    finish("allow-once");
    expect(await pending).toBe(false);
  });
  it("keeps fullscreen denied without a trusted exit affordance", async () => {
    const { policy, store, prompt } = await setup();
    await store.setSitePermission({ origin: "https://site.example", permission: "fullscreen", decision: "allow" });
    expect(policy.check(7, "fullscreen", DETAILS)).toBe(false);
    expect(await policy.request(7, "fullscreen", DETAILS)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("remembers Block for the document that asked, so a page asking in a loop is asked once", async () => {
    const { policy, prompt, setContext } = await setup();
    prompt.mockResolvedValue("block");
    for (let attempt = 0; attempt < 8; attempt++) expect(await policy.request(7, "geolocation", DETAILS)).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
    expect(policy.check(7, "geolocation", DETAILS)).toBe(false);
    // A different capability, and a new document of the same site, are separate questions.
    expect(await policy.request(7, "notifications", DETAILS)).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    setContext({ guestId: 7, windowId: 1, documentGeneration: 2, url: "https://site.example/" });
    prompt.mockResolvedValue("allow-once");
    expect(await policy.request(7, "geolocation", DETAILS)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(3);
  });
  it("holds Block for the document against a second question that was already waiting and is then allowed", async () => {
    const { policy, prompt } = await setup();
    const answers: ((choice: BrowserPermissionChoice | null) => void)[] = [];
    prompt.mockImplementation(() => new Promise<BrowserPermissionChoice | null>((resolve) => { answers.push(resolve); }));
    const first = policy.request(7, "geolocation", DETAILS);
    const second = policy.request(7, "geolocation", DETAILS);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0]?.("block");
    answers[1]?.("allow-once");
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(policy.check(7, "geolocation", DETAILS)).toBe(false);
    // The other order: a grant given first is withdrawn by a Block that was already waiting.
    const { policy: other, prompt: otherPrompt } = await setup();
    const waiting: ((choice: BrowserPermissionChoice | null) => void)[] = [];
    otherPrompt.mockImplementation(() => new Promise<BrowserPermissionChoice | null>((resolve) => { waiting.push(resolve); }));
    const granted = other.request(7, "geolocation", DETAILS);
    const blocked = other.request(7, "geolocation", DETAILS);
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[0]?.("allow-once");
    expect(await granted).toBe(true);
    waiting[1]?.("block");
    expect(await blocked).toBe(false);
    expect(other.check(7, "geolocation", DETAILS)).toBe(false);
  });
  it("writes the site's block rule for Always block and stops asking in later documents", async () => {
    const { policy, store, prompt, setContext } = await setup();
    prompt.mockResolvedValue("always-block");
    expect(await policy.request(7, "media", { ...DETAILS, mediaTypes: ["audio", "video"] })).toBe(false);
    expect((await store.snapshot()).sitePermissions).toEqual(expect.arrayContaining([
      { origin: "https://site.example", permission: "camera", decision: "block" },
      { origin: "https://site.example", permission: "microphone", decision: "block" },
    ]));
    setContext({ guestId: 7, windowId: 1, documentGeneration: 2, url: "https://site.example/" });
    expect(await policy.request(7, "media", { ...DETAILS, mediaType: "video" })).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
  });
  it("remembers nothing when the question ends without an answer", async () => {
    const { policy, store, prompt } = await setup();
    prompt.mockResolvedValue(null);
    expect(await policy.request(7, "geolocation", DETAILS)).toBe(false);
    expect(await policy.request(7, "geolocation", DETAILS)).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect((await store.snapshot()).sitePermissions).toEqual([]);
  });
});
