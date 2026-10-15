/**
 * Page actions of the agent browser tools, carried out in main over the
 * guest's own DevTools protocol session (`webContents.debugger`).
 *
 * Loaded on first use (browser-tools.ts imports it dynamically), so none of
 * this sits in the main process's initial bundle.
 *
 * WHAT IS NOT HERE, ON PURPOSE. No script evaluation, no cookies or storage,
 * no network bodies, no downloads, no file uploads: every CDP method used is
 * an Accessibility, DOM, Input or Page call. `browser-tools-source.test.ts`
 * holds these modules to that list. An agent click is not a user gesture
 * either: a download it triggers still goes through the side browser's native
 * Save dialog and rate limit.
 *
 * SENSITIVE FIELDS. Typing into a password, payment-card (`autocomplete=cc-*`)
 * or one-time-code field is refused; the user types those. The page decides
 * how its fields are labelled, so this is defense in depth, not a boundary.
 */
import type { WebContents } from "electron";
import type { BrowserPageActions } from "../../tools/browser-tools.js";
import {
  browserRefs,
  findByFingerprint,
  pageKey,
  roleAndName,
  type AXNode,
  type BrowserRefTable,
} from "./browser-snapshot.js";

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** A failure the tool reports to the model as is. */
export class BrowserActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserActionError";
  }
}

/** One tab, as the page actions see it. */
export interface ActionTarget {
  readonly tabId: string;
  url(): string;
  title(): string;
  readonly cdp: CdpSession;
  /** Run input the agent injects, so it is not mistaken for the user taking over. */
  injectInput<T>(inject: () => Promise<T>): Promise<T>;
  readonly signal: AbortSignal;
}

const attached = new WeakMap<WebContents, CdpSession>();

/** The guest's CDP session, attached on first use and kept for the guest's life. */
async function cdpFor(guest: WebContents): Promise<CdpSession> {
  const existing = attached.get(guest);
  if (existing) return existing;
  try {
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  } catch (err) {
    throw new BrowserActionError(
      "debugger-unavailable",
      `cannot control this tab (${(err as Error).message}); close its developer tools and try again`,
    );
  }
  const session: CdpSession = {
    send: (method, params) => guest.debugger.sendCommand(method, params ?? {}) as Promise<unknown>,
  };
  await session.send("DOM.enable");
  await session.send("Accessibility.enable");
  await session.send("Page.enable");
  attached.set(guest, session);
  return session;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : "cancelled";
    throw new BrowserActionError("cancelled", `nothing more was done: ${reason}`);
  }
}

async function fullTree(cdp: CdpSession): Promise<AXNode[]> {
  const result = await cdp.send("Accessibility.getFullAXTree") as { nodes?: AXNode[] };
  return result.nodes ?? [];
}

// ── snapshot / screenshot / wait ─────────────────────────────────────────

export async function snapshot(
  target: ActionTarget,
  options: { interactive?: boolean; delta?: boolean },
  refs: BrowserRefTable = browserRefs,
): Promise<{ url: string; title: string; text: string; truncated: boolean; refCount: number; delta: boolean }> {
  throwIfAborted(target.signal);
  const nodes = await fullTree(target.cdp);
  throwIfAborted(target.signal);
  const url = target.url();
  return { url, title: target.title(), ...refs.render(target.tabId, url, nodes, options) };
}

async function screenshot(target: ActionTarget): Promise<{ data: string; mimeType: "image/png"; bytes: number }> {
  throwIfAborted(target.signal);
  const result = await target.cdp.send("Page.captureScreenshot", { format: "png" }) as { data?: string };
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new BrowserActionError("screenshot-failed", "the tab returned no image; it may be hidden or still loading");
  }
  return { data: result.data, mimeType: "image/png", bytes: Math.floor(result.data.length * 3 / 4) };
}

const WAIT_POLL_MS = 250;
const WAIT_MAX_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Wait for `text` to appear on the page, or for `timeMs`. */
async function waitFor(
  target: ActionTarget,
  options: { text?: string; timeMs?: number },
): Promise<{ found: boolean; waitedMs: number }> {
  const started = Date.now();
  const limit = Math.min(options.timeMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
  if (options.text === undefined) {
    await sleep(limit, target.signal);
    throwIfAborted(target.signal);
    return { found: false, waitedMs: Date.now() - started };
  }
  for (;;) {
    throwIfAborted(target.signal);
    await target.cdp.send("DOM.getDocument", { depth: 0 });
    const search = await target.cdp.send("DOM.performSearch", { query: options.text }) as { searchId: string; resultCount: number };
    await target.cdp.send("DOM.discardSearchResults", { searchId: search.searchId });
    if (search.resultCount > 0) return { found: true, waitedMs: Date.now() - started };
    if (Date.now() - started >= limit) return { found: false, waitedMs: Date.now() - started };
    await sleep(WAIT_POLL_MS, target.signal);
  }
}

// ── refs ──────────────────────────────────────────────────────────────────

/**
 * The live DOM node a ref names. Fails clearly when the ref is from another
 * tab or page, or its element is gone; follows a re-render that replaced the
 * element with an identical one (same role and accessible name, unique).
 */
export async function resolveRef(target: ActionTarget, ref: string, refs: BrowserRefTable = browserRefs): Promise<number> {
  const entry = refs.get(ref);
  if (!entry || entry.tabId !== target.tabId) {
    throw new BrowserActionError("unknown-ref", `ref ${ref} is not from this tab; take a browser_snapshot of it first`);
  }
  if (entry.pageUrl !== pageKey(target.url())) {
    throw new BrowserActionError("stale-ref", `ref ${ref} is stale: the tab has navigated since the snapshot; take a new browser_snapshot`);
  }
  const current = await nodeRoleAndName(target.cdp, entry.backendNodeId);
  if (current && current.role === entry.role && current.name === entry.name) return entry.backendNodeId;
  const moved = findByFingerprint(await fullTree(target.cdp), entry.role, entry.name);
  if (moved !== undefined) {
    refs.rebind(ref, moved);
    return moved;
  }
  throw new BrowserActionError(
    "stale-ref",
    `ref ${ref} is stale: the ${entry.role}${entry.name ? ` "${entry.name}"` : ""} it named is no longer on the page; take a new browser_snapshot`,
  );
}

async function nodeRoleAndName(cdp: CdpSession, backendNodeId: number): Promise<{ role: string; name: string } | undefined> {
  try {
    const result = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }) as { nodes?: AXNode[] };
    return roleAndName(result.nodes?.find((node) => node.backendDOMNodeId === backendNodeId) ?? result.nodes?.[0]);
  } catch {
    // The node is gone: CDP rejects an unknown backend node id.
    return undefined;
  }
}

// ── click / type / keys ───────────────────────────────────────────────────

async function centerOf(cdp: CdpSession, backendNodeId: number): Promise<{ x: number; y: number }> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  const result = await cdp.send("DOM.getContentQuads", { backendNodeId }) as { quads?: number[][] };
  const quad = result.quads?.find((candidate) => candidate.length === 8);
  if (!quad) throw new BrowserActionError("not-visible", "the element has no visible box to click");
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 };
}

export async function click(target: ActionTarget, ref: string, refs: BrowserRefTable = browserRefs): Promise<void> {
  throwIfAborted(target.signal);
  const backendNodeId = await resolveRef(target, ref, refs);
  const { x, y } = await centerOf(target.cdp, backendNodeId);
  throwIfAborted(target.signal);
  await target.injectInput(async () => {
    await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await target.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  });
}

/** Why a field is refused for agent typing, or null when it is not sensitive. */
export function sensitiveFieldReason(attributes: Readonly<Record<string, string>>): string | null {
  if ((attributes.type ?? "").trim().toLowerCase() === "password") return "a password field";
  const tokens = (attributes.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => token.startsWith("cc-"))) return "a payment card field";
  if (tokens.includes("one-time-code")) return "a one-time code field";
  if (tokens.includes("current-password") || tokens.includes("new-password")) return "a password field";
  return null;
}

async function attributesOf(cdp: CdpSession, backendNodeId: number): Promise<Record<string, string>> {
  const result = await cdp.send("DOM.describeNode", { backendNodeId }) as { node?: { attributes?: string[] } };
  const list = result.node?.attributes ?? [];
  const out: Record<string, string> = {};
  for (let index = 0; index + 1 < list.length; index += 2) out[list[index]!.toLowerCase()] = list[index + 1]!;
  return out;
}

export async function type(
  target: ActionTarget,
  ref: string,
  value: string,
  options: { submit?: boolean },
  refs: BrowserRefTable = browserRefs,
): Promise<void> {
  throwIfAborted(target.signal);
  const backendNodeId = await resolveRef(target, ref, refs);
  const sensitive = sensitiveFieldReason(await attributesOf(target.cdp, backendNodeId));
  if (sensitive) {
    throw new BrowserActionError("sensitive-field", `refused: ${ref} is ${sensitive}; the user types those themselves`);
  }
  throwIfAborted(target.signal);
  await target.injectInput(async () => {
    await target.cdp.send("DOM.focus", { backendNodeId });
    // Replace what the field holds: select all of it, then insert.
    await target.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] });
    await target.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await target.cdp.send("Input.insertText", { text: value });
    if (options.submit) await dispatchKey(target.cdp, "Enter");
  });
}

/** The keys `browser_press_key` may press. */
const PRESSABLE_KEYS: Readonly<Record<string, { code: string; keyCode: number; text?: string }>> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

async function dispatchKey(cdp: CdpSession, key: string): Promise<void> {
  const spec = PRESSABLE_KEYS[key];
  if (!spec) throw new BrowserActionError("bad-key", `cannot press ${JSON.stringify(key)}`);
  const domKey = key === "Space" ? " " : key;
  await cdp.send("Input.dispatchKeyEvent", {
    type: spec.text ? "keyDown" : "rawKeyDown",
    key: domKey,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    ...(spec.text ? { text: spec.text } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: domKey, code: spec.code, windowsVirtualKeyCode: spec.keyCode });
}

async function pressKey(target: ActionTarget, key: string): Promise<void> {
  throwIfAborted(target.signal);
  await target.injectInput(() => dispatchKey(target.cdp, key));
}

// ── navigate ──────────────────────────────────────────────────────────────

/** What navigation needs of a guest. Production passes Electron `WebContents`. */
export interface NavigableGuest {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  on(event: "will-redirect", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
  removeListener(event: "will-redirect", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
  stop(): void;
}

/**
 * Load `url` in the tab, refusing a main-frame redirect to any origin other
 * than `approvedOrigin`: the user approved that origin, not wherever the
 * server sends the tab next.
 */
export async function navigate(
  guest: NavigableGuest,
  url: string,
  approvedOrigin: string,
  signal: AbortSignal,
  originOf: (url: string) => string | null,
): Promise<{ url: string }> {
  throwIfAborted(signal);
  let refusedRedirect: string | null = null;
  const onRedirect = (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => {
    if (!details.isMainFrame) return;
    if (originOf(details.url) !== approvedOrigin) {
      refusedRedirect = details.url;
      details.preventDefault();
    }
  };
  const onAbort = () => guest.stop();
  guest.on("will-redirect", onRedirect);
  signal.addEventListener("abort", onAbort, { once: true });
  let loadError: Error | null = null;
  try {
    await guest.loadURL(url);
  } catch (err) {
    loadError = err as Error;
  } finally {
    guest.removeListener("will-redirect", onRedirect);
    signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
  if (refusedRedirect !== null) {
    const redirectOrigin = originOf(refusedRedirect) ?? "a non-web address";
    throw new BrowserActionError(
      "cross-origin-redirect",
      `${approvedOrigin} redirected to ${redirectOrigin}; the redirect was not followed. Call browser_navigate with that URL to ask for it.`,
    );
  }
  if (loadError) throw new BrowserActionError("load-failed", `the page did not load: ${loadError.message}`);
  return { url: guest.getURL() };
}

// ── production adapter ────────────────────────────────────────────────────

/** What the adapter needs of the tab registry. */
interface InputAttribution {
  withAgentInput<T>(guestId: number, inject: () => Promise<T>): Promise<T>;
}

/** One live registry tab and the signal that cancels its action. */
interface LiveTab {
  readonly tab: { readonly handle: string; readonly guest: WebContents | null };
  readonly signal: AbortSignal;
}

async function targetFor(live: LiveTab, attribution: InputAttribution): Promise<ActionTarget> {
  const guest = live.tab.guest;
  if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
  const cdp = await cdpFor(guest);
  return {
    tabId: live.tab.handle,
    url: () => guest.getURL(),
    title: () => guest.getTitle(),
    cdp,
    injectInput: (inject) => attribution.withAgentInput(guest.id, inject),
    signal: live.signal,
  };
}

/**
 * The page actions over real guests, as browser-tools.ts calls them. `origin`
 * is the tools' own origin rule, passed in so both sides use one definition.
 */
export function createBrowserPageActions(
  attribution: InputAttribution,
  originOf: (url: string) => string | null,
): BrowserPageActions<WebContents> {
  return {
    snapshot: async (live: LiveTab, options: { interactive?: boolean; delta?: boolean }) =>
      snapshot(await targetFor(live, attribution), options),
    screenshot: async (live: LiveTab) => screenshot(await targetFor(live, attribution)),
    waitFor: async (live: LiveTab, options: { text?: string; timeMs?: number }) =>
      waitFor(await targetFor(live, attribution), options),
    click: async (live: LiveTab, ref: string) => click(await targetFor(live, attribution), ref),
    type: async (live: LiveTab, ref: string, text: string, options: { submit?: boolean }) =>
      type(await targetFor(live, attribution), ref, text, options),
    pressKey: async (live: LiveTab, key: string) => pressKey(await targetFor(live, attribution), key),
    navigate: async (live: LiveTab, url: string, approvedOrigin: string) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      return navigate(guest as unknown as NavigableGuest, url, approvedOrigin, live.signal, originOf);
    },
  };
}
