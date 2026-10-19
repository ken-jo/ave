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
import { browserOrigin } from "../../shared/browser-tools.js";
import type { TouchDeliveryReport } from "./browser-tab-registry.js";
import { BrowserActionError, frameTree, throwIfAborted, withGuardedAction, type ActionTarget, type CdpSession } from "./browser-action-guard.js";
export { BrowserActionError, type ActionTarget, type CdpSession } from "./browser-action-guard.js";
import {
  browserRefs,
  findByFingerprint,
  pageKey,
  roleAndName,
  type AXNode,
  type BrowserRefTable,
} from "./browser-snapshot.js";

const attached = new WeakMap<WebContents, Promise<CdpSession>>();

/** The guest's CDP session, attached on first use and kept for the guest's life. */
async function cdpFor(guest: WebContents, signal: AbortSignal, onTrackingStarted: () => void): Promise<CdpSession> {
  throwIfAborted(signal);
  const existing = attached.get(guest);
  if (existing) return existing;
  const pending = attachCdp(guest, signal, onTrackingStarted);
  attached.set(guest, pending);
  try {
    return await pending;
  } catch (err) {
    attached.delete(guest);
    throw err;
  }
}

async function attachCdp(guest: WebContents, signal: AbortSignal, onTrackingStarted: () => void): Promise<CdpSession> {
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
    onEvent: (listener) => {
      const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => listener(method, params);
      guest.debugger.on("message", onMessage);
      return () => { guest.debugger.removeListener("message", onMessage); };
    },
  };
  await session.send("DOM.enable");
  throwIfAborted(signal);
  await session.send("Accessibility.enable");
  throwIfAborted(signal);
  await session.send("Page.enable");
  throwIfAborted(signal);
  // Establish this epoch before approval seals its document identity.
  onTrackingStarted();
  return session;
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
  const frames = await frameTree(target.cdp);
  throwIfAborted(target.signal);
  const iframeOrigins: string[] = [];
  const visitFrames = (tree: typeof frames): void => {
    for (const child of tree.childFrames ?? []) {
      iframeOrigins.push(browserOrigin(child.frame.url) ?? "opaque origin");
      visitFrames(child);
    }
  };
  visitFrames(frames);
  const url = target.url();
  return { url, title: target.title(), ...refs.render(target.tabId, url, nodes, {
    ...options, iframeOrigins: target.iframeOrigins?.() ?? iframeOrigins, loaderId: frames.frame.loaderId, documentId: target.documentId?.(),
  }) };
}

/**
 * A tab that is not shown paints no frames, and Page.captureScreenshot then
 * never answers (seen in the real app: a hidden side-panel tab hung until the
 * host's 120s ceiling). Bound it and say what to do instead.
 */
const SCREENSHOT_MAX_MS = 10_000;

export async function screenshot(
  target: ActionTarget,
  maxMs = SCREENSHOT_MAX_MS,
): Promise<{ data: string; mimeType: "image/png"; bytes: number }> {
  throwIfAborted(target.signal);
  const timedOut = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    target.cdp.send("Page.captureScreenshot", { format: "png" }) as Promise<{ data?: string }>,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), maxMs);
    }),
  ]).finally(() => clearTimeout(timer));
  throwIfAborted(target.signal);
  if (result === timedOut) {
    throw new BrowserActionError(
      "screenshot-timeout",
      `the tab drew no image within ${maxMs / 1000}s; a tab that is not shown cannot be captured. Show it with browser_tabs {"select": "${target.tabId}"} or use browser_snapshot, which works on hidden tabs`,
    );
  }
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
  if (entry.loaderId !== undefined && entry.loaderId !== (await frameTree(target.cdp)).frame.loaderId) {
    throw new BrowserActionError("stale-ref", `ref ${ref} belongs to a previous document; take a new browser_snapshot`);
  }
  if (entry.documentId !== undefined && entry.documentId !== target.documentId?.()) {
    throw new BrowserActionError("stale-ref", `ref ${ref} belongs to a previous document; take a new browser_snapshot`);
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
    `ref ${ref} is stale: the ${entry.role.slice(0, 200)}${entry.name ? ` "${entry.name.slice(0, 200)}"` : ""} it named is no longer on the page; take a new browser_snapshot`,
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
  return { x: Math.round(xs.reduce((a, b) => a + b, 0) / 4), y: Math.round(ys.reduce((a, b) => a + b, 0) / 4) };
}

export async function click(target: ActionTarget, ref: string, refs: BrowserRefTable = browserRefs): Promise<void> {
  return withGuardedAction(target, async (target) => {
    throwIfAborted(target.signal);
    const backendNodeId = await resolveRef(target, ref, refs);
    target.expectNode(backendNodeId);
    const { x, y } = await centerOf(target.cdp, backendNodeId);
    throwIfAborted(target.signal);
    await target.injectInput(() => withPageFocus(target, () => pressAt(target, x, y, target.finishWithInput)));
  });
}

const FOCUS_POLL_MS = 50;
/** How long one press waits for focus before pressing again. */
const FOCUS_PRESS_WAIT_MS = 500;
const FOCUS_MAX_MS = 3_000;

async function pollUntil<T>(signal: AbortSignal, maxMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  const started = Date.now();
  for (;;) {
    throwIfAborted(signal);
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() - started >= maxMs) return undefined;
    await sleep(FOCUS_POLL_MS, signal);
  }
}

/**
 * Press into the page until it holds keyboard focus. The press moves focus to
 * the guest asynchronously, and the app can take it back (an approval card
 * closing returns focus to the composer); key or text input sent to a page
 * without focus is dropped without an error. So: press, wait for the
 * accessibility tree to report the page focused, press again if it does not,
 * and fail clearly when it never does.
 */
async function pressForFocus(target: ActionTarget, x: number, y: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < FOCUS_MAX_MS) {
    await pressAt(target, x, y);
    if (await pollUntil(target.signal, FOCUS_PRESS_WAIT_MS, async () => (await pageHasFocus(target.cdp)) || undefined)) return;
  }
  throw new BrowserActionError("no-focus", "the page did not take keyboard focus, so nothing was typed; try again");
}

const RELEASE_MAX_MS = 1_000;

/**
 * Run an action that may take the page's keyboard focus, and give focus back
 * afterwards, whether the action succeeds or fails, when the page did not
 * hold it before. Waits (bounded) until the page has let go. Individual native
 * events carry their attribution; genuine intervention still cancels while
 * focus is being restored.
 */
async function withPageFocus<T>(target: ActionTarget, act: () => Promise<T>): Promise<T> {
  const hadFocus = await pageHasFocus(target.cdp);
  try {
    return await act();
  } finally {
    if (!hadFocus) {
      target.releaseFocus();
      // Not the action's signal: a cancelled action still hands focus back.
      await pollUntil(new AbortController().signal, RELEASE_MAX_MS, async () =>
        (await pageHasFocus(target.cdp)) ? undefined : true).catch(() => undefined);
    }
  }
}

async function pressAt(target: ActionTarget, x: number, y: number, finish = (dispatch: () => Promise<unknown>) => dispatch()): Promise<void> {
  await target.press(async () => {
    await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await target.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await finish(() => target.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
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
  return withGuardedAction(target, async (target) => {
    throwIfAborted(target.signal);
    const backendNodeId = await resolveRef(target, ref, refs);
    target.expectNode(backendNodeId);
    const sensitive = sensitiveFieldReason(await attributesOf(target.cdp, backendNodeId));
    if (sensitive) {
      throw new BrowserActionError("sensitive-field", `refused: ${ref} is ${sensitive}; the user types those themselves`);
    }
    const { x, y } = await centerOf(target.cdp, backendNodeId);
    throwIfAborted(target.signal);
    await target.injectInput(() => withPageFocus(target, async () => {
      // Click into the field first: the page drops synthesized
      // key and text input for a page that does not hold focus (focus emulation,
      // Page.bringToFront and webContents.focus() do not give it while the app
      // window is in the background); a press on the page does. Focus can still
      // move away between the press and the text, so the field's value is read
      // back from the accessibility tree and the typing repeated if it missed.
      for (let attempt = 1; ; attempt++) {
        await pressForFocus(target, x, y);
        await target.cdp.send("DOM.focus", { backendNodeId });
        // Replace what the field holds: select all of it, then insert.
        await target.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] });
        await target.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await target.finishWithInput(() => target.cdp.send("Input.insertText", { text: value }));
        const landed = await pollUntil(target.signal, TYPE_CHECK_MS, async () => {
          const now = await fieldValue(target.cdp, backendNodeId);
          return now === null || now === collapse(value) ? true : undefined;
        });
        if (landed) break;
        if (attempt >= TYPE_ATTEMPTS) {
          throw new BrowserActionError("not-typed", `the text did not reach ${ref} (the page kept losing focus); check the field and try again`);
        }
      }
      if (options.submit) await target.finishWithInput(() => dispatchKey(target.cdp, "Enter"));
    }));
  });
}

const TYPE_ATTEMPTS = 3;
const TYPE_CHECK_MS = 500;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The field's current value as the accessibility tree reports it, whitespace
 * collapsed like the snapshot's; null when the node reports no value at all
 * (some editors), where typing cannot be checked.
 */
async function fieldValue(cdp: CdpSession, backendNodeId: number): Promise<string | null> {
  const result = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }) as { nodes?: AXNode[] };
  const node = result.nodes?.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? result.nodes?.[0];
  const raw = node?.value?.value;
  if (raw === undefined || raw === null) return null;
  return collapse(String(raw));
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

/** Roles a click activates: pressing Enter or Space into them after the click would activate them again. */
const ACTIVATED_BY_CLICK: ReadonlySet<string> = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);

/** Whether the page holds keyboard focus: the accessibility tree marks its root focused. */
async function pageHasFocus(cdp: CdpSession): Promise<boolean> {
  const nodes = await fullTree(cdp);
  return nodes.some((node) => node.role?.value === "RootWebArea"
    && (node.properties ?? []).some((property) => property.name === "focused" && property.value?.value === true));
}

/**
 * Press `key`. With `ref`, click into that element first (as `type` does);
 * without one, the key goes to what the page has focused, and fails clearly
 * when the page holds no focus (a synthesized key would be dropped silently).
 */
export async function pressKey(target: ActionTarget, key: string, ref: string | undefined, refs: BrowserRefTable = browserRefs): Promise<void> {
  return withGuardedAction(target, async (target) => {
    throwIfAborted(target.signal);
    let point: { x: number; y: number; backendNodeId: number } | undefined;
    if (ref !== undefined) {
      const role = refs.get(ref)?.role;
      if ((key === "Enter" || key === "Space") && role !== undefined && ACTIVATED_BY_CLICK.has(role)) {
        // Clicking into it already activates it; the key would activate it twice.
        throw new BrowserActionError(
          "use-click",
          `${ref} is a ${role}: pressing ${key} in it would click it twice; use browser_click`,
        );
      }
      const backendNodeId = await resolveRef(target, ref, refs);
      target.expectNode(backendNodeId);
      point = { ...(await centerOf(target.cdp, backendNodeId)), backendNodeId };
    } else if (!(await pageHasFocus(target.cdp))) {
      throw new BrowserActionError(
        "no-focus",
        "the page does not have keyboard focus, so the key would go nowhere; pass ref to press it in an element",
      );
    }
    throwIfAborted(target.signal);
    await target.injectInput(() => withPageFocus(target, async () => {
      if (point) {
        await pressForFocus(target, point.x, point.y);
        await target.cdp.send("DOM.focus", { backendNodeId: point.backendNodeId });
      }
      await target.finishWithInput(() => dispatchKey(target.cdp, key));
    }));
  });
}

// ── navigate ──────────────────────────────────────────────────────────────

/** What navigation needs of a guest. Production passes Electron `WebContents`. */
export interface NavigableGuest {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  on(event: "will-redirect" | "will-navigate" | "will-frame-navigate", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
  removeListener(event: "will-redirect" | "will-navigate" | "will-frame-navigate", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
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
  if (originOf(url) !== approvedOrigin) throw new BrowserActionError("unapproved-origin", "the requested URL does not match the approved origin");
  let refusedRedirect: string | null = null;
  const onRedirect = (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => {
    if (!details.isMainFrame) return;
    if (originOf(details.url) !== approvedOrigin) {
      refusedRedirect = details.url;
      details.preventDefault();
      guest.stop();
    }
  };
  const onAbort = () => guest.stop();
  guest.on("will-redirect", onRedirect);
  guest.on("will-navigate", onRedirect);
  guest.on("will-frame-navigate", onRedirect);
  signal.addEventListener("abort", onAbort, { once: true });
  let loadError: Error | null = null;
  try {
    await guest.loadURL(url);
  } catch (err) {
    loadError = err as Error;
  } finally {
    guest.removeListener("will-redirect", onRedirect);
    guest.removeListener("will-navigate", onRedirect);
    guest.removeListener("will-frame-navigate", onRedirect);
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

/** What settling needs of a guest. Production passes Electron `WebContents`. */
export interface LoadingGuest {
  getURL(): string;
  isLoading(): boolean;
}

const SETTLE_POLL_MS = 100;
const SETTLE_MAX_MS = 15_000;

/**
 * Wait for a just-opened tab's first page: a URL committed and nothing
 * loading. Bounded; a page still loading at the bound is returned as is.
 */
export async function settle(guest: LoadingGuest, signal: AbortSignal, maxMs = SETTLE_MAX_MS): Promise<{ url: string }> {
  const started = Date.now();
  for (;;) {
    throwIfAborted(signal);
    const url = guest.getURL();
    if (url !== "" && url !== "about:blank" && !guest.isLoading()) return { url };
    if (Date.now() - started >= maxMs) return { url };
    await sleep(SETTLE_POLL_MS, signal);
  }
}

// ── production adapter ────────────────────────────────────────────────────

/** What the adapter needs of the tab registry. */
interface InputAttribution {
  withAgentInput<T>(guestId: number, inject: () => Promise<T>): Promise<T>;
  releaseFocus(guestId: number): void;
  documentChanged(guestId: number): void;
  /** Record the touch input every guest of `guestId`'s window reports until `stop`. */
  watchTouches(guestId: number): TouchWatch;
}

interface TouchWatch {
  delivery(): TouchDeliveryReport;
  stop(): void;
}

/**
 * The screen position of the content area of the window that hosts `guest`,
 * or null when the guest has no live host window. Production reads the
 * owning BrowserWindow's content bounds.
 */
export type HostContentOrigin = (guest: WebContents) => { x: number; y: number; windowId: number } | null;

/** How long a pointer move may take to be reported back before a tap is refused. */
const POINTER_ECHO_MAX_MS = 1_000;
/** How long one pointer or touch dispatch may take; healthy ones return in milliseconds. */
const INPUT_DISPATCH_MAX_MS = 3_000;
/** How long the tap derived from a press may take to be reported back. */
const TAP_ECHO_MAX_MS = 1_000;
const TAP_POLL_MS = 20;

/**
 * ONE TOUCH SEQUENCE PER WINDOW. A touch sent through a page's own protocol
 * session is still routed by its window's one touch sequence (measured with
 * two pages in one window): a lone sequence reaches the page that sent it, but
 * a touch start sent while another page's sequence is open joins that
 * sequence and lands in the other page, and a sequence left open (a start
 * without its end) leaves later touches of another page undelivered, its
 * dispatch unanswered, and that page taking no touch again. So each press
 * runs alone in its window, from its pointer move to its derived tap, and a
 * press that started always ends.
 */
const windowPresses = new Map<number, Promise<void>>();

async function aloneInWindow<T>(windowId: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const before = windowPresses.get(windowId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const turn = before.then(() => mine);
  windowPresses.set(windowId, turn);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        try { throwIfAborted(signal); } catch (err) { reject(err); }
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      void before.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
    });
    return await run();
  } finally {
    release();
    if (windowPresses.get(windowId) === turn) windowPresses.delete(windowId);
  }
}

function withinDispatchTime<T>(dispatch: Promise<T>): Promise<T> {
  // A dispatch that loses the race still settles later; nobody awaits it then.
  dispatch.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserActionError(
      "input-not-delivered",
      "the page did not take the input, so the action did not complete; close and reopen the page if this keeps happening",
    )), INPUT_DISPATCH_MAX_MS);
  });
  return Promise.race([dispatch, late]).finally(() => clearTimeout(timer));
}

/**
 * The press reached this page and only this page. Touch echoes carry no
 * point (measured), so the point itself rests on the offset measured from
 * the pointer move's echo inside the same press; what is confirmed here is
 * the recipient: this page reported the marked touch start and end and the
 * tap derived from them, and no other page of the window took a touch.
 */
async function confirmDelivery(watch: TouchWatch, signal: AbortSignal, requireTap: boolean): Promise<void> {
  const started = Date.now();
  // Judge once this page's sequence is complete (or never will be): its
  // derived tap arrives after the touch end.
  let delivery = watch.delivery();
  while (!(delivery.started && delivery.ended && (delivery.tapped || !requireTap)) && Date.now() - started < TAP_ECHO_MAX_MS) {
    await sleep(TAP_POLL_MS, signal);
    throwIfAborted(signal);
    delivery = watch.delivery();
  }
  if (delivery.elsewhere > 0) {
    throw new BrowserActionError("input-not-delivered", "the press reached another page in this window, so this action did not complete; take a new snapshot and try again");
  }
  if (!(delivery.started && delivery.ended)) {
    throw new BrowserActionError("input-not-delivered", "this page did not report the press, so the action did not complete; try again");
  }
  if (requireTap && !delivery.tapped) {
    throw new BrowserActionError("input-not-delivered", "the page took the touch but made no tap of it, so nothing is known to have been pressed; try again");
  }
}

/**
 * TOUCH COORDINATES. For a page shown in a `<webview>`, the protocol takes a
 * mouse event's point in the page's own viewport but a touch event's point in
 * the hosting window's content area (measured: a tap at the page point of a
 * button landed on the page root; the same point offset by the page's place in
 * the window pressed the button). The guard checks every input against the
 * page point, so the point is only moved here, at the native boundary.
 *
 * Where the page sits is measured, not reported by the renderer: the pointer
 * move sent before every press comes back as a native input event carrying
 * both the page point and its screen point, and the host window's content
 * origin turns the screen point into the window point.
 */
function createTouchPlacement(guest: WebContents, hostContentOrigin: HostContentOrigin) {
  let offset: { x: number; y: number } | null = null;
  type PointerEcho = { type?: string; x?: number; y?: number; globalX?: number; globalY?: number };
  return {
    /**
     * Before a pointer move is sent: listen for its native echo. `settle`,
     * after the send, learns the page's offset in its window from it.
     */
    watch(method: string, params: Record<string, unknown> | undefined): { settle(): Promise<void> } | null {
      if (method !== "Input.dispatchMouseEvent" || params?.type !== "mouseMoved") return null;
      // Each pointer move measures afresh: an echo that never comes must
      // leave no earlier offset behind for the press that follows.
      offset = null;
      const point = { x: params.x, y: params.y };
      let onInput: ((event: unknown, input: PointerEcho) => void) | undefined;
      const echo = new Promise<PointerEcho | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), POINTER_ECHO_MAX_MS);
        onInput = (_event, input) => {
          if (input.type !== "mouseMove" || input.x !== point.x || input.y !== point.y) return;
          if (typeof input.globalX !== "number" || typeof input.globalY !== "number") return;
          clearTimeout(timer);
          resolve(input);
        };
        guest.on("input-event", onInput as never);
      });
      return {
        settle: async () => {
          try {
            const seen = await echo;
            const host = hostContentOrigin(guest);
            if (seen && host) offset = { x: seen.globalX! - seen.x! - host.x, y: seen.globalY! - seen.y! - host.y };
          } finally {
            guest.removeListener("input-event", onInput as never);
          }
        },
      };
    },
    /** A touch event's page points as window points; a clear refusal when never measured. */
    placed(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
      if (method !== "Input.dispatchTouchEvent") return params;
      const points = (params?.touchPoints as Array<{ x: number; y: number }> | undefined) ?? [];
      if (points.length === 0) return params;
      if (!offset) {
        throw new BrowserActionError("no-pointer-position", "could not tell where the page sits in its window, so nothing was pressed; try again");
      }
      const by = offset;
      return { ...params, touchPoints: points.map((point) => ({ ...point, x: point.x + by.x, y: point.y + by.y })) };
    },
  };
}

/** One live registry tab and the signal that cancels its action. */
interface LiveTab {
  readonly tab: { readonly handle: string; readonly guest: WebContents | null; readonly documentId: number };
  readonly signal: AbortSignal;
  readonly approval?: { readonly tabId: string; readonly origin: string; readonly documentId: number };
}

async function targetFor(live: LiveTab, attribution: InputAttribution, hostContentOrigin: HostContentOrigin, input = false): Promise<ActionTarget> {
  const guest = live.tab.guest;
  if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
  const approval = live.approval;
  const assertGuest = () => {
    throwIfAborted(live.signal);
    if (guest.isDestroyed() || live.tab.guest !== guest) throw new BrowserActionError("tab-gone", "the tab was closed or replaced");
  };
  const assertCurrent = (keyboard: boolean) => {
    assertGuest();
    if ((input || approval) && (!approval || approval.tabId !== live.tab.handle || approval.origin !== browserOrigin(guest.getURL())
      || approval.documentId !== live.tab.documentId)) {
      throw new BrowserActionError("document-changed", "this tab or document is no longer the approved target; nothing more was done");
    }
    if (keyboard && guest.focusedFrame !== guest.mainFrame) {
      throw new BrowserActionError("wrong-input-target", "keyboard focus belongs to another frame; nothing more was done");
    }
  };
  assertCurrent(false);
  const session = await cdpFor(guest, live.signal, () => attribution.documentChanged(guest.id));
  assertCurrent(false);
  const touch = createTouchPlacement(guest, hostContentOrigin);
  // A touch start went out and its sequence is not ended yet.
  let touchOpen = false;
  let touchEnded = false;
  const cdp: CdpSession = {
    onEvent: (listener) => session.onEvent(listener),
    send: async (method, params) => {
      assertCurrent(method === "Input.dispatchKeyEvent" || method === "Input.insertText");
      params = touch.placed(method, params);
      const echo = touch.watch(method, params);
      const pointer = method === "Input.dispatchTouchEvent" || method === "Input.dispatchMouseEvent";
      const phase = method === "Input.dispatchTouchEvent" ? params?.type : undefined;
      if (phase === "touchStart") touchOpen = true;
      const sent = session.send(method, params);
      const result = pointer ? await withinDispatchTime(sent) : await sent;
      if (phase === "touchEnd" || phase === "touchCancel") {
        touchOpen = false;
        touchEnded = phase === "touchEnd";
      }
      await echo?.settle();
      // The action guard owns input completion: its last input may navigate.
      if (method.startsWith("Input.")) assertGuest();
      else assertCurrent(false);
      return result;
    },
  };
  return {
    tabId: live.tab.handle,
    url: () => guest.getURL(),
    title: () => guest.getTitle(),
    cdp,
    injectInput: (inject) => attribution.withAgentInput(guest.id, inject),
    press: async (run) => {
      const host = hostContentOrigin(guest);
      if (!host) {
        throw new BrowserActionError("no-pointer-position", "could not tell where the page sits in its window, so nothing was pressed; try again");
      }
      return aloneInWindow(host.windowId, live.signal, async () => {
        touchEnded = false;
        const watch = attribution.watchTouches(guest.id);
        try {
          let result: Awaited<ReturnType<typeof run>>;
          try {
            result = await run();
          } catch (err) {
            // A press whose end went out and then changed the document is a
            // completed effect (the action guard decides); it still must have
            // reached this page and no other.
            if (touchEnded && err instanceof BrowserActionError && err.code === "document-changed") {
              await confirmDelivery(watch, new AbortController().signal, false);
            }
            throw err;
          }
          await confirmDelivery(watch, live.signal, true);
          return result;
        } finally {
          if (touchOpen) {
            // The one dispatch made after a failure, past the document checks:
            // it presses nothing, it only ends the window's open sequence.
            touchOpen = false;
            await withinDispatchTime(session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })).catch(() => undefined);
          }
          watch.stop();
        }
      });
    },
    releaseFocus: () => attribution.releaseFocus(guest.id),
    signal: live.signal,
    documentId: () => live.tab.documentId,
    iframeOrigins: () => guest.mainFrame.framesInSubtree
      .filter((frame) => frame !== guest.mainFrame)
      .map((frame) => browserOrigin(frame.url) ?? "opaque origin"),
    assertCurrent,
  };
}

/**
 * The page actions over real guests, as browser-tools.ts calls them. `origin`
 * is the tools' own origin rule, passed in so both sides use one definition.
 */
export function createBrowserPageActions(
  attribution: InputAttribution,
  originOf: (url: string) => string | null,
  hostContentOrigin: HostContentOrigin,
): BrowserPageActions<WebContents> {
  return {
    prepare: async (live) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      await cdpFor(guest, live.signal, () => attribution.documentChanged(guest.id));
      throwIfAborted(live.signal);
      if (live.tab.guest !== guest) throw new BrowserActionError("tab-gone", "the tab was replaced");
    },
    snapshot: async (live: LiveTab, options: { interactive?: boolean; delta?: boolean }) =>
      snapshot(await targetFor(live, attribution, hostContentOrigin), options),
    screenshot: async (live: LiveTab) => screenshot(await targetFor(live, attribution, hostContentOrigin)),
    waitFor: async (live: LiveTab, options: { text?: string; timeMs?: number }) =>
      waitFor(await targetFor(live, attribution, hostContentOrigin), options),
    click: async (live: LiveTab, ref: string) => click(await targetFor(live, attribution, hostContentOrigin, true), ref),
    type: async (live: LiveTab, ref: string, text: string, options: { submit?: boolean }) =>
      type(await targetFor(live, attribution, hostContentOrigin, true), ref, text, options),
    pressKey: async (live: LiveTab, key: string, ref?: string) =>
      pressKey(await targetFor(live, attribution, hostContentOrigin, true), key, ref),
    navigate: async (live: LiveTab, url: string, approvedOrigin: string) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      return navigate(guest as unknown as NavigableGuest, url, approvedOrigin, live.signal, originOf);
    },
    settle: async (live: LiveTab) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      return settle(guest, live.signal);
    },
  };
}
