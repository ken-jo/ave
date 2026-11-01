// Lazy-loaded page actions use allow-listed CDP methods; uploads require picker approval and downloads still require native Save. Refuse password, card,
// and OTP fields as defense in depth; page-supplied labels are not a security boundary.
import { stageBrowserUpload, type BrowserUploadPickerRequest, type BrowserUploadResult, type BrowserUploadSelection } from "./browser-upload.js";
import type { WebContents } from "electron";
import type { BrowserActionTab, BrowserPageActions } from "../../tools/browser-tools.js";
import { OBSERVATION_LIMITS, type BrowserObservationElement } from "../../shared/agent-observation.js";
import { validateExternalUrl } from "../../shared/external-url.js";
import { browserOrigin } from "../../shared/browser-tools.js";
import { BrowserDocumentChangedError, type TouchDeliveryReport } from "./browser-tab-registry.js";
import { captureAgentPreview, type AgentPreviewRecorder } from "./browser-agent-preview.js";
import { BrowserActionError, frameTree, throwIfAborted, withGuardedAction, type ActionTarget, type CdpSession } from "./browser-action-guard.js";
import { browserDragData, type BrowserDragData } from "./browser-drag-data.js";
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

// The guest's CDP session, attached on first use and kept for the guest's life.
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

export async function snapshot(
  target: ActionTarget,
  options: { interactive?: boolean; delta?: boolean },
  refs: BrowserRefTable = browserRefs,
): Promise<{ url: string; title: string; text: string; truncated: boolean; refCount: number; delta: boolean }> {
  throwIfAborted(target.signal);
  const nodes = await fullTree(target.cdp);
  throwIfAborted(target.signal);
  const nativeSelectOptions = new Map<number, { value: string; label: string; disabled: boolean }[]>();
  for (const node of nodes.filter((entry) => entry.role?.value === "combobox" && entry.backendDOMNodeId !== undefined).slice(0, 12)) {
    const described = await target.cdp.send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId, depth: -1 }) as { node?: SelectNode };
    throwIfAborted(target.signal);
    if (described.node?.nodeName === "SELECT") {
      try { nativeSelectOptions.set(node.backendDOMNodeId!, nativeOptions(described.node).map(({ value, label, disabled }) => ({ value: value.slice(0, 1000), label: label.slice(0, 200), disabled }))); }
      catch (err) { if (!(err instanceof BrowserActionError) || !["not-native-select", "ambiguous-select"].includes(err.code)) throw err; }
    }
  }
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
    ...options, nativeSelectOptions, iframeOrigins: target.iframeOrigins?.() ?? iframeOrigins, loaderId: frames.frame.loaderId, documentId: target.documentId?.(),
  }) };
}

// A tab that is not shown paints no frames, and Page.captureScreenshot then never answers (seen in the real app: a hidden side-panel tab hung until the
// host's 120s ceiling). Bound it and say what to do instead.
const SCREENSHOT_MAX_MS = 10_000;

export async function screenshot(
  target: ActionTarget,
  maxMs = SCREENSHOT_MAX_MS,
  options: { fullPage?: boolean } = {},
): Promise<{ data: string; mimeType: "image/png"; bytes: number }> {
  throwIfAborted(target.signal);
  if (options.fullPage) throw new BrowserActionError("screenshot-unavailable", "full page capture is unavailable for this browser surface; use a viewport screenshot");
  const params: Record<string, unknown> = { format: "png" };
  const timedOut = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    target.cdp.send("Page.captureScreenshot", params) as Promise<{ data?: string }>,
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
  const bytes = Buffer.byteLength(result.data, "base64");
  if (bytes > 10 * 1024 * 1024) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture byte limit; use a smaller viewport");
  const header = Buffer.from(result.data.slice(0, 32), "base64");
  if (header.length < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new BrowserActionError("screenshot-failed", "the tab returned an invalid image");
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > 32_000_000) throw new BrowserActionError("screenshot-limit", "the image exceeds the capture pixel limit");
  return { data: result.data, mimeType: "image/png", bytes };
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

// Wait for `text` to appear on the page, or for `timeMs`.
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

// The live DOM node a ref names. Fails clearly when the ref is from another tab or page, or its element is gone; follows a re-render that replaced the
// element with an identical one (same role and accessible name, unique).
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

async function centerOf(cdp: CdpSession, backendNodeId: number): Promise<{ x: number; y: number }> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  return visibleCenter(cdp, backendNodeId);
}

// Page-supplied semantics catch recognizable final actions; they cannot prove an arbitrary page's effects.
const MANUAL_ACTIVATION = /\b(?:pay(?:\s+now)?|buy\s+now|purchase|place\s+(?:an?\s+)?order|confirm\s+(?:payment|purchase|order|transfer)|(?:send|transfer)\s+(?:money|funds)|delete\s+permanently|permanently\s+delete|(?:delete|close|deactivate)\s+(?:(?:my|the|your)\s+)?account)\b|결제|구매|주문\s*확정|송금|영구\s*삭제|계정\s*삭제|회원\s*탈퇴/iu;
const MANUAL_FORM = /\b(?:checkout|payment|purchase|money\s+transfer)\b|결제|구매|송금|영구\s*삭제|계정\s*삭제|회원\s*탈퇴/iu;
const ACTIVATION_ROLES: ReadonlySet<string> = new Set(["button", "link", "menuitem"]);

async function assertOrdinaryActivation(cdp: CdpSession, backendNodeId?: number, submitsForm = false): Promise<void> {
  const nodes = await fullTree(cdp);
  const node = backendNodeId === undefined
    ? nodes.find((entry) => entry.role?.value !== "RootWebArea" && (entry.properties ?? []).some((property) => property.name === "focused" && property.value?.value === true))
    : nodes.find((entry) => entry.backendDOMNodeId === backendNodeId);
  if (!node || node.backendDOMNodeId === undefined) {
    throw new BrowserActionError("activation-unavailable", "cannot verify the current activation target; select an ordinary control explicitly");
  }
  const attributes = await attributesOf(cdp, node.backendDOMNodeId);
  const identity = [node.name?.value, attributes["aria-label"], attributes.title, attributes.value, attributes.name, attributes.id].filter(Boolean).join(" ");
  let manual = ACTIVATION_ROLES.has(String(node.role?.value)) && MANUAL_ACTIVATION.test(identity);
  const byId = new Map(nodes.map((entry) => [entry.nodeId, entry]));
  const ancestors = new Set<string>();
  let ancestor: AXNode | undefined = node;
  let form: AXNode | undefined;
  while (ancestor && !ancestors.has(ancestor.nodeId)) {
    ancestors.add(ancestor.nodeId);
    if (ancestor.role?.value === "form" || ancestor.role?.value === "dialog") { form = ancestor; break; }
    ancestor = ancestor.parentId === undefined ? undefined : byId.get(ancestor.parentId);
  }
  if (form && (submitsForm || ACTIVATION_ROLES.has(String(node.role?.value)))) {
    const children = new Map<string, AXNode[]>();
    for (const entry of nodes) {
      if (entry.parentId === undefined) continue;
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry);
      children.set(entry.parentId, siblings);
    }
    const pending = [form];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (visited.has(entry.nodeId)) continue;
      visited.add(entry.nodeId);
      if (entry === form ? MANUAL_FORM.test(String(entry.name?.value ?? "")) : ACTIVATION_ROLES.has(String(entry.role?.value)) && MANUAL_ACTIVATION.test(String(entry.name?.value ?? ""))) manual = true;
      pending.push(...(children.get(entry.nodeId) ?? []));
    }
  }
  if (manual) {
    throw new BrowserActionError("manual-submit-required", "refused: payment or irreversible submission is a user action; the user completes it themselves");
  }
}

export async function click(target: ActionTarget, ref: string, refs: BrowserRefTable = browserRefs,
  onObservationTarget?: (element: BrowserObservationElement, downloadUrl?: string) => void): Promise<void> {
  return withGuardedAction(target, async (target) => {
    throwIfAborted(target.signal);
    const backendNodeId = await resolveRef(target, ref, refs);
    target.expectNode(backendNodeId);
    if (onObservationTarget) {
      const attributes = await attributesOf(target.cdp, backendNodeId);
      const href = attributes.href;
      const candidate = href && URL.canParse(href, target.url()) ? new URL(href, target.url()).href : undefined;
      const download = candidate === undefined ? undefined : validateExternalUrl(candidate);
      onObservationTarget(observationElement(ref, refs, attributes, false), download?.ok ? download.url : undefined);
    }
    const { x, y } = await centerOf(target.cdp, backendNodeId);
    throwIfAborted(target.signal);
    await target.injectInput(() => withPageFocus(target, async () => {
      await assertOrdinaryActivation(target.cdp, backendNodeId);
      return pressAt(target, x, y, target.finishWithInput);
    }));
  });
}

const FOCUS_POLL_MS = 50;
// How long one press waits for focus before pressing again.
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

// Synthesized keyboard input silently drops without page focus; press, await accessibility focus, retry, then fail if focus never arrives.
async function pressForFocus(target: ActionTarget, x: number, y: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < FOCUS_MAX_MS) {
    await pressAt(target, x, y);
    if (await pollUntil(target.signal, FOCUS_PRESS_WAIT_MS, async () => (await pageHasFocus(target.cdp)) || undefined)) return;
  }
  throw new BrowserActionError("no-focus", "the page did not take keyboard focus, so nothing was typed; try again");
}

const RELEASE_MAX_MS = 1_000;

// Restore focus after success or failure when the page did not initially own it; bounded restoration must still honor genuine user intervention.
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

// Why a field is refused for agent typing, or null when it is not sensitive.
export function sensitiveFieldReason(attributes: Readonly<Record<string, string>>): string | null {
  if ((attributes.type ?? "").trim().toLowerCase() === "password") return "a password field";
  const tokens = (attributes.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => token.startsWith("cc-"))) return "a payment card field";
  if (tokens.includes("one-time-code")) return "a one-time code field";
  if (tokens.includes("current-password") || tokens.includes("new-password")) return "a password field";
  return null;
}

async function attributesOf(cdp: CdpSession, backendNodeId: number): Promise<Record<string, string>> {
  const result = await cdp.send("DOM.describeNode", { backendNodeId }) as { node?: SelectNode };
  if (!result.node) throw new BrowserActionError("stale-ref", "the field is no longer available; take a new snapshot");
  return nodeAttributes(result.node);
}

function observationElement(ref: string, refs: BrowserRefTable, attributes: Readonly<Record<string, string>>,
  typing: boolean): BrowserObservationElement {
  const entry = refs.get(ref);
  if (!entry) throw new Error("Missing browser observation target");
  const credential = /pass(?:word|code)?|pwd|secret|token|api[-_ ]?key|credential|one[-_ ]?time|otp|security[-_ ]?code|비밀번호|암호|토큰|인증.?코드/i;
  const fieldIdentity = [attributes.type, attributes.autocomplete, attributes.name, attributes.id,
    attributes["aria-label"], attributes.placeholder, entry.role, entry.name].filter(Boolean).join(" ");
  const redacted = typing || ["textbox", "searchbox", "combobox", "spinbutton"].includes(entry.role)
    || sensitiveFieldReason(attributes) !== null || credential.test(fieldIdentity);
  return { ref, role: entry.role.slice(0, OBSERVATION_LIMITS.browserTextChars),
    name: redacted ? "" : entry.name.slice(0, OBSERVATION_LIMITS.browserTextChars), redacted };
}

export async function type(
  target: ActionTarget,
  ref: string,
  value: string,
  options: { submit?: boolean },
  refs: BrowserRefTable = browserRefs,
  onObservationTarget?: (element: BrowserObservationElement, downloadUrl?: string) => void,
): Promise<void> {
  return withGuardedAction(target, async (target) => {
    throwIfAborted(target.signal);
    const backendNodeId = await resolveRef(target, ref, refs);
    target.expectNode(backendNodeId);
    const attributes = await attributesOf(target.cdp, backendNodeId);
    const sensitive = sensitiveFieldReason(attributes);
    if (sensitive) {
      throw new BrowserActionError("sensitive-field", `refused: ${ref} is ${sensitive}; the user types those themselves`);
    }
    if (options.submit) await assertOrdinaryActivation(target.cdp, backendNodeId, true);
    onObservationTarget?.(observationElement(ref, refs, attributes, true));
    const { x, y } = await centerOf(target.cdp, backendNodeId);
    throwIfAborted(target.signal);
    await target.injectInput(() => withPageFocus(target, async () => {
      // Press to acquire real guest focus, then verify the field value and retry typing if focus moved; focus emulation cannot replace the press.
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
      if (options.submit) {
        await assertOrdinaryActivation(target.cdp, backendNodeId, true);
        await target.finishWithInput(() => dispatchKey(target.cdp, "Enter"));
      }
    }));
  });
}

const TYPE_ATTEMPTS = 3;
const TYPE_CHECK_MS = 500;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// The field's current value as the accessibility tree reports it, whitespace collapsed like the snapshot's; null when the node reports no value at all
// (some editors), where typing cannot be checked.
async function fieldValue(cdp: CdpSession, backendNodeId: number): Promise<string | null> {
  const result = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }) as { nodes?: AXNode[] };
  const node = result.nodes?.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? result.nodes?.[0];
  const raw = node?.value?.value;
  if (raw === undefined || raw === null) return null;
  return collapse(String(raw));
}

// The keys `browser_press_key` may press.
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

// Roles a click activates: pressing Enter or Space into them after the click would activate them again.
const ACTIVATED_BY_CLICK: ReadonlySet<string> = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);

// Whether the page holds keyboard focus: the accessibility tree marks its root focused.
async function pageHasFocus(cdp: CdpSession): Promise<boolean> {
  const nodes = await fullTree(cdp);
  return nodes.some((node) => node.role?.value === "RootWebArea"
    && (node.properties ?? []).some((property) => property.name === "focused" && property.value?.value === true));
}

// Press `key`. With `ref`, click into that element first (as `type` does); without one, the key goes to what the page has focused, and fails clearly
// when the page holds no focus (a synthesized key would be dropped silently).
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
    if (key === "Enter" || key === "Space") await assertOrdinaryActivation(target.cdp, point?.backendNodeId, key === "Enter");
    await target.injectInput(() => withPageFocus(target, async () => {
      if (point) {
        await pressForFocus(target, point.x, point.y);
        await target.cdp.send("DOM.focus", { backendNodeId: point.backendNodeId });
      }
      if (key === "Enter" || key === "Space") await assertOrdinaryActivation(target.cdp, point?.backendNodeId, key === "Enter");
      await target.finishWithInput(() => dispatchKey(target.cdp, key));
    }));
  });
}

// Move over one live, main-document ref.
export async function hover(target: ActionTarget, ref: string, refs: BrowserRefTable = browserRefs): Promise<void> {
  return withGuardedAction(target, async (target) => {
    const id = await resolveRef(target, ref, refs);
    target.expectNode(id);
    const point = await centerOf(target.cdp, id);
    await target.injectInput(() => target.pointerInput(() => target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })));
  });
}

// Drag between visible endpoints, serialized with all other window gestures.
export async function drag(target: ActionTarget, sourceRef: string, targetRef: string, refs: BrowserRefTable = browserRefs): Promise<void> {
  return withGuardedAction(target, async (target) => {
    if (!target.mouseDrag) throw new BrowserActionError("drag-unavailable", "native pointer delivery cannot be verified for this tab");
    const source = await resolveRef(target, sourceRef, refs);
    const destination = await resolveRef(target, targetRef, refs);
    target.expectNode(source);
    const start = await centerOf(target.cdp, source);
    const end = await visibleCenter(target.cdp, destination);
    const sourceAttributes = await attributesOf(target.cdp, source);
    const expectsHtmlDrag = sourceAttributes.draggable === "true" || ["link", "img", "image"].includes(refs.get(sourceRef)?.role ?? "");
    await target.injectInput(() => target.mouseDrag!(async (receipt) => {
      const data = await withPageFocus(target, async () => {
        await target.cdp.send("Input.setInterceptDrags", { enabled: true });
        await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
        await target.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
        target.expectNode(destination);
        await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...end, button: "left", buttons: 1 });
        const captured = expectsHtmlDrag
          ? await pollUntil(target.signal, 1_000, () => Promise.resolve(receipt.intercepted())) : receipt.intercepted();
        if (expectsHtmlDrag && !captured) throw new BrowserActionError("drag-not-intercepted", "the page did not provide a native drag payload; no drop was sent");
        // Interception and its source drag end BEFORE the destination can receive a drop. A failed teardown is therefore safe to retry.
        if (captured) await target.cdp.send("Input.cancelDragging");
        else {
          // Keep interception armed through ordinary release: a late native HTML5 drag must be captured, never delivered as an unchecked drop.
          await target.finishWithInput(() => target.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", buttons: 0, clickCount: 1 }));
          if (receipt.intercepted()) throw new BrowserActionError("drag-not-intercepted", "the native drag payload arrived too late; no destination drop was sent");
        }
        await target.cdp.send("Input.setInterceptDrags", { enabled: false });
        return captured;
      });
      if (data) {
        if (await resolveRef(target, sourceRef, refs) !== source || await resolveRef(target, targetRef, refs) !== destination) {
          throw new BrowserActionError("stale-ref", "the drag endpoints changed; no drop was sent");
        }
        target.expectNode(destination);
        const point = await visibleCenter(target.cdp, destination);
        await target.cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
        await target.cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
        await target.finishWithInput(() => target.cdp.send("Input.dispatchDragEvent", { type: "drop", ...point, data }));
      }
    }));
  });
}

async function visibleCenter(cdp: CdpSession, backendNodeId: number): Promise<{ x: number; y: number }> {
  const result = await cdp.send("DOM.getContentQuads", { backendNodeId }) as { quads?: number[][] };
  const quad = result.quads?.find((candidate) => candidate.length === 8 && candidate.every(Number.isFinite));
  if (!quad) throw new BrowserActionError("not-visible", "the element has no visible box");
  return { x: Math.round((quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4), y: Math.round((quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4) };
}

export async function scroll(target: ActionTarget, ref: string, direction: "up" | "down" | "left" | "right", pixels: number, refs: BrowserRefTable = browserRefs): Promise<void> {
  if (!Number.isInteger(pixels) || pixels < 1 || pixels > 2000 || !["up", "down", "left", "right"].includes(direction)) {
    throw new BrowserActionError("bad-scroll", "scroll needs a direction and 1 to 2000 pixels");
  }
  return withGuardedAction(target, async (target) => {
    const id = await resolveRef(target, ref, refs);
    target.expectNode(id);
    const point = await centerOf(target.cdp, id);
    const deltaX = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
    const deltaY = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
    await target.injectInput(() => target.wheelInput(async () => {
      await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await target.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY });
    }));
  });
}

interface SelectNode {
  backendNodeId?: number;
  nodeName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: SelectNode[];
}

function nodeAttributes(node: SelectNode): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index + 1 < (node.attributes?.length ?? 0); index += 2) values[node.attributes![index]!.toLowerCase()] = node.attributes![index + 1]!;
  return values;
}

function nativeOptions(node: SelectNode | undefined): { id: number; value: string; label: string; disabled: boolean }[] {
  if (!node || node.nodeName !== "SELECT" || "multiple" in nodeAttributes(node) || "disabled" in nodeAttributes(node)) {
    throw new BrowserActionError("not-native-select", "only an enabled native single select is supported");
  }
  const options: ReturnType<typeof nativeOptions> = [];
  const textOf = (entry: SelectNode): string => entry.nodeName === "#text" ? entry.nodeValue ?? "" : (entry.children ?? []).map(textOf).join("");
  const visit = (entry: SelectNode, disabled: boolean): void => {
    const attributes = nodeAttributes(entry);
    disabled ||= "disabled" in attributes;
    if (entry.nodeName === "OPTION") {
      if (!entry.backendNodeId) throw new BrowserActionError("bad-select", "the select has an unreadable option");
      const label = collapse(attributes.label ?? textOf(entry));
      options.push({ id: entry.backendNodeId, value: attributes.value ?? collapse(textOf(entry)), label, disabled });
    } else for (const child of entry.children ?? []) visit(child, disabled);
  };
  for (const child of node.children ?? []) visit(child, false);
  if (options.length === 0 || options.length > 200 || new Set(options.map((option) => option.value)).size !== options.length
    || new Set(options.map((option) => option.label)).size !== options.length) {
    throw new BrowserActionError("ambiguous-select", "the native select options are empty, ambiguous or exceed the limit");
  }
  return options;
}

// Keyboard-only selection with a final live option/value and AX check.
export async function select(target: ActionTarget, ref: string, value: string, refs: BrowserRefTable = browserRefs): Promise<void> {
  return withGuardedAction(target, async (target) => {
    const id = await resolveRef(target, ref, refs);
    target.expectNode(id);
    const readOptions = async () => nativeOptions((await target.cdp.send("DOM.describeNode", { backendNodeId: id, depth: -1 }) as { node?: SelectNode }).node);
    const options = await readOptions();
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    if (index < 0) throw new BrowserActionError("bad-select", "the requested enabled option is not present");
    const desired = enabled[index]!;
    await centerOf(target.cdp, id);
    await target.injectInput(() => withPageFocus(target, async () => {
      await target.focusPage();
      await target.cdp.send("DOM.focus", { backendNodeId: id });
      if (!(await pollUntil(target.signal, FOCUS_MAX_MS, async () => (await pageHasFocus(target.cdp)) || undefined))) {
        throw new BrowserActionError("no-focus", "the page did not take keyboard focus; nothing was selected");
      }
      // No activating input is marked complete: a navigation during any key must remain a failure rather than being accepted as final selection.
      await dispatchKey(target.cdp, "Home");
      for (let step = 0; step < index; step++) await dispatchKey(target.cdp, "ArrowDown");
      await dispatchKey(target.cdp, "Enter");
      const current = await readOptions();
      if (JSON.stringify(current) !== JSON.stringify(options)) throw new BrowserActionError("select-changed", "the options changed while selecting; take a new snapshot");
      const tree = await fullTree(target.cdp);
      const option = tree.find((node) => node.backendDOMNodeId === desired.id);
      const selected = option?.properties?.some((property) => property.name === "selected" && property.value.value === true);
      const currentValue = await fieldValue(target.cdp, id);
      if (!selected || currentValue !== desired.label) throw new BrowserActionError("select-unverified", "the requested option did not become the final selected value");
    }));
  });
}

const retainedUploads = new Map<string, BrowserUploadSelection>();

export async function upload(
  target: ActionTarget,
  ref: string,
  options: BrowserUploadPickerRequest & { pickFiles: (request: BrowserUploadPickerRequest) => Promise<readonly string[] | null> },
  refs: BrowserRefTable = browserRefs,
): Promise<BrowserUploadResult> {
  let result: BrowserUploadResult = { status: "cancelled", files: [], count: 0, bytes: 0 };
  await withGuardedAction(target, async (target) => {
    const id = await resolveRef(target, ref, refs);
    target.expectNode(id);
    const described = await target.cdp.send("DOM.describeNode", { backendNodeId: id }) as { node?: SelectNode };
    const attributes = described.node ? nodeAttributes(described.node) : {};
    if (described.node?.nodeName !== "INPUT" || attributes.type?.toLowerCase() !== "file" || "disabled" in attributes) {
      throw new BrowserActionError("not-file-input", "upload requires an enabled native file input");
    }
    const selection = await stageBrowserUpload(options, options.pickFiles, () => target.assertCurrent?.(false));
    if (!selection) return;
    const key = `${target.tabId}:${ref}`;
    let retained = false;
    try {
      if (!("multiple" in attributes) && selection.result.count !== 1) throw new BrowserActionError("single-file-input", "this input accepts only one file; choose again");
      if (await resolveRef(target, ref, refs) !== id) throw new BrowserActionError("stale-ref", "the upload input changed after file selection");
      await selection.dispatch(options, async (paths) => { await target.cdp.send("DOM.setFileInputFiles", { backendNodeId: id, files: [...paths] }); });
      selection.retainUntil((revoke) => {
        const stopDocument = target.cdp.onEvent((method) => {
          if (method === "Page.frameNavigated" || method === "Page.frameDetached" || method === "DOM.documentUpdated") revoke();
        });
        const stopDestroyed = target.onDestroyed?.(revoke);
        return () => { stopDocument(); stopDestroyed?.(); if (retainedUploads.get(key) === selection) retainedUploads.delete(key); };
      });
      const previous = retainedUploads.get(key);
      retainedUploads.set(key, selection);
      retained = true;
      await previous?.release();
      result = selection.result;
    } catch (error) {
      if (!retained) {
        try { await selection.release(); }
        catch (cleanupError) {
          // Preserve the refusal when cleanup also refuses an unowned replacement.
          if (!(error instanceof BrowserActionError) || error.code !== "upload-refused") throw cleanupError;
          error.cause = cleanupError;
        }
      }
      throw error;
    }
  });
  return result;
}

// What navigation needs of a guest. Production passes Electron `WebContents`.
export interface NavigableGuest {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  on(event: "will-redirect" | "will-navigate" | "will-frame-navigate", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
  removeListener(event: "will-redirect" | "will-navigate" | "will-frame-navigate", listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void): unknown;
  stop(): void;
}

// Load `url` in the tab, refusing a main-frame redirect to any origin other than `approvedOrigin`: the user approved that origin, not wherever the
// server sends the tab next.
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

// What settling needs of a guest. Production passes Electron `WebContents`.
export interface LoadingGuest {
  getURL(): string;
  isLoading(): boolean;
}

const SETTLE_POLL_MS = 100;
const SETTLE_MAX_MS = 15_000;

// Wait for a just-opened tab's first page: a URL committed and nothing loading. Bounded; a page still loading at the bound is returned as is.
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

// What waiting for an action's navigation needs of a guest. Production passes Electron `WebContents`.
export interface NavigationGuest extends LoadingGuest {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

// A navigation an input action may have started in a tab's main frame, watched from before the input goes out until it commits or fails.
export interface ActionNavigation {
  // Whether the main frame was asked to navigate in this tab after the watch began.
  readonly requested: boolean;
  // Resolve once a requested navigation commits or ends without a new document; refuse a failed one, a closed tab, or one still pending at `maxMs`.
  // Resolves at once when nothing was requested.
  outcome(signal: AbortSignal, maxMs: number): Promise<void>;
  stop(): void;
}

type NavigationEnd = { kind: "committed" | "stopped" } | { kind: "failed"; error: BrowserActionError };

// Watch the main frame for a navigation the action is about to start. A link activation reaches the page after its input is acknowledged, so the
// browser learns of the navigation only after the action returns: the request (CDP Page.frameRequestedNavigation, renderer side) is the signal, and
// commit (did-navigate / did-navigate-in-page) or its end (did-fail-load / did-stop-loading / tab gone) settles it. Electron 45 emits no
// did-fail-load for a cancelled (ERR_ABORTED) navigation (electron_api_web_contents.cc DidFinishNavigation); did-stop-loading ends that one.
export async function watchActionNavigation(guest: NavigationGuest, cdp: CdpSession): Promise<ActionNavigation> {
  const mainFrameId = (await frameTree(cdp)).frame.id;
  let requested = false;
  let ended: NavigationEnd | undefined;
  let notify: (() => void) | undefined;
  const end = (outcome: NavigationEnd) => {
    if (!requested || ended) return;
    ended = outcome;
    notify?.();
  };
  const stopCdp = cdp.onEvent((method, params) => {
    if (method === "Page.frameRequestedNavigation" && params.frameId === mainFrameId && params.disposition === "currentTab") requested = true;
    if (method === "Page.frameStartedNavigating" && params.frameId === mainFrameId) requested = true;
  });
  const listeners: Array<[string, (...args: unknown[]) => void]> = [
    ["did-start-navigation", ((details: { isMainFrame?: boolean }) => { if (details.isMainFrame) requested = true; }) as never],
    ["did-navigate", (() => { requested = true; end({ kind: "committed" }); }) as never],
    ["did-navigate-in-page", ((_event: unknown, _url: string, isMainFrame: boolean) => {
      if (isMainFrame) { requested = true; end({ kind: "committed" }); }
    }) as never],
    ["did-fail-load", ((_event: unknown, _errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      end({
        kind: "failed",
        error: new BrowserActionError("load-failed", `the action started loading ${validatedURL.slice(0, 200)}, which failed: ${String(errorDescription).slice(0, 200)}`, true),
      });
    }) as never],
    ["did-stop-loading", (() => end({ kind: "stopped" })) as never],
    ["destroyed", (() => end({ kind: "failed", error: new BrowserActionError("tab-gone", "the tab was closed while its page was loading", true) })) as never],
    ["render-process-gone", (() => end({ kind: "failed", error: new BrowserActionError("tab-gone", "the tab's page crashed while loading", true) })) as never],
  ];
  for (const [event, listener] of listeners) guest.on(event, listener);
  const stop = () => {
    stopCdp();
    for (const [event, listener] of listeners) guest.removeListener(event, listener);
  };
  return {
    get requested() { return requested; },
    stop,
    outcome: async (signal, maxMs) => {
      throwIfAborted(signal);
      if (!requested) return;
      if (!ended) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, maxMs);
          function done() {
            clearTimeout(timer);
            notify = undefined;
            signal.removeEventListener("abort", done);
            resolve();
          }
          notify = done;
          signal.addEventListener("abort", done, { once: true });
        });
      }
      throwIfAborted(signal);
      if (!ended) {
        throw new BrowserActionError("navigation-incomplete",
          `the action started a navigation from ${guest.getURL().slice(0, 200)} that did not finish within ${Math.round(maxMs / 1000)}s; take a new browser_snapshot to see the page`, true);
      }
      if (ended.kind === "failed") throw ended.error;
    },
  };
}

// The navigation each tab's last input action started, kept from the action until its settle.
const actionNavigations = new WeakMap<object, ActionNavigation>();

// What the adapter needs of the tab registry.
interface InputAttribution {
  withAgentInput<T>(guestId: number, inject: () => Promise<T>): Promise<T>;
  releaseFocus(guestId: number): void;
  focusGuest(guestId: number): Promise<void>;
  documentChanged(guestId: number): void;
  // Record the touch input every guest of `guestId`'s window reports until `stop`.
  watchTouches(guestId: number): TouchWatch;
  armMouse(guestId: number, input: { type: "mouseDown" | "mouseUp"; x: number; y: number; button: "left"; clickCount: 1 }): void;
  watchWheel(guestId: number): { delivery(): { started: boolean; ended: boolean; elsewhere: number }; stop(): void };
  watchMouse(guestId: number): { delivery(): { pressed: boolean; released: boolean; elsewhere: number }; stop(): void };
}

interface TouchWatch {
  delivery(): TouchDeliveryReport;
  stop(): void;
}

// The screen position of the content area of the window that hosts `guest`, or null when the guest has no live host window. Production reads the owning
// BrowserWindow's content bounds.
export type HostContentOrigin = (guest: WebContents) => { x: number; y: number; windowId: number } | null;

// How long a pointer move may take to be reported back before a tap is refused.
const POINTER_ECHO_MAX_MS = 1_000;
// How long one pointer or touch dispatch may take; healthy ones return in milliseconds.
const INPUT_DISPATCH_MAX_MS = 3_000;
// How long one press may hold its window: every protocol call it makes, the guard's reads included, and its delivery check share this budget. Its
// closing touch cancel, if needed, has its own dispatch budget after it.
const PRESS_MAX_MS = 5_000;
// How long the tap derived from a press may take to be reported back.
const TAP_ECHO_MAX_MS = 1_000;
const TAP_POLL_MS = 20;

// Serialize the entire touch sequence per window and always end a started press; overlapping page sessions join the same native sequence.
const windowPresses = new Map<number, Promise<void>>();

// Refuse every press in a window while a prior touch cancel is unacknowledged; a queued touch could otherwise land in the wrong page.
const wedgedWindows = new Map<number, symbol>();

// Name `windowId` wedged until `cancelled` settles or `guest` navigates or goes away.
function markWedged(windowId: number, guest: WebContents, cancelled: Promise<unknown>): void {
  const mark = Symbol("wedged");
  wedgedWindows.set(windowId, mark);
  const events = ["did-navigate", "destroyed", "render-process-gone"] as const;
  const clear = () => {
    if (wedgedWindows.get(windowId) === mark) wedgedWindows.delete(windowId);
    for (const event of events) guest.removeListener(event as never, clear);
  };
  for (const event of events) guest.once(event as never, clear);
  cancelled.then(clear, clear);
}

function refuseIfWedged(windowId: number): void {
  if (wedgedWindows.has(windowId)) {
    throw new BrowserActionError(
      "window-input-busy",
      "a page in this window has not answered an earlier press, so nothing was pressed here; try again once it responds, or close that page",
    );
  }
}

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

// `call`, or a clear failure once `ms` pass or `signal` aborts. Inside a press every protocol call is bounded this way: a page that stops answering must
// not hold its window's press lock (and every other page's press) with it.
function within<T>(call: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  // A call that loses the race still settles later; nobody awaits it then.
  call.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserActionError(
      "input-not-delivered",
      "the page did not answer in time, so the action did not complete; close and reopen the page if this keeps happening",
    )), Math.max(0, ms));
    if (signal) {
      onAbort = () => {
        try { throwIfAborted(signal); } catch (err) { reject(err); }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([call, cut]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

// Touch echoes carry no point; derive coordinates from the pointer-move echo and confirm only this page received the marked start, end, and tap.
async function confirmDelivery(watch: TouchWatch, signal: AbortSignal, requireTap: boolean, deadline: number): Promise<void> {
  const until = Math.min(Date.now() + TAP_ECHO_MAX_MS, deadline);
  // Judge once this page's sequence is complete (or never will be): its derived tap arrives after the touch end.
  let delivery = watch.delivery();
  while (!(delivery.started && delivery.ended && (delivery.tapped || !requireTap)) && Date.now() < until) {
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

// Pointer echoes prove the native page recipient before contact; both pointer and touch dispatch use viewport coordinates.
function createTouchPositionGuard(guest: WebContents, hostContentOrigin: HostContentOrigin) {
  let positionKnown = false;
  type PointerEcho = { type?: string; x?: number; y?: number; globalX?: number; globalY?: number };
  return {
    // The exact page point and its native screen echo must be observed before a contact starts.
    watch(method: string, params: Record<string, unknown> | undefined): { settle(): Promise<void>; stop(): void } | null {
      if (method !== "Input.dispatchMouseEvent" || params?.type !== "mouseMoved") return null;
      // An echo that never comes must leave no earlier receipt behind for the press that follows.
      positionKnown = false;
      const point = { x: params.x, y: params.y };
      let onInput: ((event: unknown, input: PointerEcho) => void) | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const echo = new Promise<PointerEcho | null>((resolve) => {
        timer = setTimeout(() => resolve(null), POINTER_ECHO_MAX_MS);
        onInput = (_event, input) => {
          if (input.type !== "mouseMove" || input.x !== point.x || input.y !== point.y) return;
          if (typeof input.globalX !== "number" || typeof input.globalY !== "number") return;
          clearTimeout(timer);
          resolve(input);
        };
        guest.on("input-event", onInput as never);
      });
      const stop = () => {
        clearTimeout(timer);
        guest.removeListener("input-event", onInput as never);
      };
      return {
        stop,
        settle: async () => {
          try {
            const seen = await echo;
            const host = hostContentOrigin(guest);
            if (!seen || !host) throw new BrowserActionError("no-pointer-position", "the page did not report the pointer move in its window");
            positionKnown = true;
          } finally { stop(); }
        },
      };
    },
    // A host offset must not be added to a point that already belongs to the guest viewport.
    checked(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
      if (method !== "Input.dispatchTouchEvent") return params;
      const points = (params?.touchPoints as Array<{ x: number; y: number }> | undefined) ?? [];
      if (points.length === 0) return params;
      if (!positionKnown) {
        throw new BrowserActionError("no-pointer-position", "could not tell where the page sits in its window, so nothing was pressed; try again");
      }
      return params;
    },
  };
}

// One live registry tab and the signal that cancels its action.
type LiveTab = BrowserActionTab<WebContents>;

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
    if (input && (!live.leaseId || live.tab.lease?.id !== live.leaseId)) throw new BrowserActionError("control-revoked", "the browser control lease changed; nothing more was done");
    if (input && live.tab.controlMode === "human-paused") throw new BrowserActionError("control-paused", "browser control is paused; ask the user to resume this tab");
    if ((input || approval) && (!approval || approval.tabId !== live.tab.handle || approval.origin !== browserOrigin(guest.getURL())
      || approval.documentId !== live.tab.documentId || approval.controlGeneration !== live.tab.controlGeneration)) {
      throw new BrowserActionError("document-changed", "this tab or document is no longer the approved target; nothing more was done");
    }
    if (keyboard && guest.focusedFrame !== guest.mainFrame) {
      throw new BrowserActionError("wrong-input-target", "keyboard focus belongs to another frame; nothing more was done");
    }
  };
  assertCurrent(false);
  const session = await cdpFor(guest, live.signal, () => attribution.documentChanged(guest.id));
  assertCurrent(false);
  const touch = createTouchPositionGuard(guest, hostContentOrigin);
  // A touch start went out and its sequence is not ended yet.
  let touchOpen = false;
  let touchEnded = false;
  let touchMoved = false;
  let mouseOpen = false;
  let nativeDrag: {
    enabled: boolean; disabled: boolean; cancelled: boolean; dropped: boolean; dropSent: boolean; awaitingPayload: boolean;
    data?: BrowserDragData; error?: unknown;
    destination?: { x: number; y: number; data: BrowserDragData };
    delivery(): { pressed: boolean; released: boolean; elsewhere: number };
    stop(): void;
  } | undefined;
  // While a press holds the window: when its budget runs out.
  let pressDeadline: number | null = null;
  const cdp: CdpSession = {
    onEvent: (listener) => session.onEvent(listener),
    send: async (method, params) => {
      assertCurrent(method === "Input.dispatchKeyEvent" || method === "Input.insertText");
      if (method === "Input.setInterceptDrags") {
        if (!nativeDrag || typeof params?.enabled !== "boolean") throw new BrowserActionError("drag-unavailable", "no native drag sequence owns interception");
        if (params.enabled) { nativeDrag.enabled = true; nativeDrag.disabled = false; }
      }
      if (method === "Input.cancelDragging" && !nativeDrag) throw new BrowserActionError("drag-unavailable", "no native drag sequence owns cancellation");
      if (method === "Input.dispatchDragEvent" && (!nativeDrag?.data || params?.data !== nativeDrag.data
        || nativeDrag.enabled || !nativeDrag.disabled || !nativeDrag.cancelled || nativeDrag.error || nativeDrag.delivery().elsewhere !== 0)) {
        throw new BrowserActionError("drag-unavailable", "the native source drag has not been safely released; no drop was sent");
      }
      params = touch.checked(method, params);
      const echo = touch.watch(method, params);
      const pointer = method === "Input.dispatchTouchEvent" || method === "Input.dispatchMouseEvent";
      const phase = method === "Input.dispatchTouchEvent" ? params?.type : undefined;
      if (phase === "touchStart") touchOpen = true;
      if (phase === "touchMove") touchMoved = true;
      if (method === "Input.dispatchMouseEvent" && (params?.type === "mousePressed" || params?.type === "mouseReleased")) {
        attribution.armMouse(guest.id, { type: params.type === "mousePressed" ? "mouseDown" : "mouseUp", x: params.x as number, y: params.y as number, button: "left", clickCount: 1 });
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") mouseOpen = true;
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved" && params.buttons === 1 && nativeDrag) nativeDrag.awaitingPayload = true;
      try {
        if (method === "Input.dispatchDragEvent" && params?.type === "dragEnter" && nativeDrag?.data) {
          nativeDrag.destination = { x: params.x as number, y: params.y as number, data: nativeDrag.data };
        }
        if (method === "Input.dispatchDragEvent" && params?.type === "drop" && nativeDrag) nativeDrag.dropSent = true;
        const sent = session.send(method, params);
        const result = pressDeadline !== null
          ? await within(sent, Math.min(INPUT_DISPATCH_MAX_MS, pressDeadline - Date.now()), live.callerSignal)
          : pointer ? await within(sent, INPUT_DISPATCH_MAX_MS) : await sent;
        if (method === "Input.cancelDragging" && nativeDrag) { nativeDrag.cancelled = true; mouseOpen = false; }
        if (method === "Input.setInterceptDrags" && params?.enabled === false && nativeDrag) {
          nativeDrag.enabled = false; nativeDrag.disabled = true; nativeDrag.stop();
        }
        if (method === "Input.dispatchDragEvent" && params?.type === "drop" && nativeDrag) nativeDrag.dropped = true;
        if (phase === "touchEnd" || phase === "touchCancel") {
          touchOpen = false;
          touchEnded = phase === "touchEnd";
        }
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") mouseOpen = false;
        await echo?.settle();
        // The action guard owns input completion: its last input may navigate.
        if (method.startsWith("Input.")) assertGuest();
        else assertCurrent(false);
        return result;
      } finally { echo?.stop(); }
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
      refuseIfWedged(host.windowId);
      return aloneInWindow(host.windowId, live.signal, async () => {
        refuseIfWedged(host.windowId);
        touchEnded = false;
        touchMoved = false;
        const deadline = Date.now() + PRESS_MAX_MS;
        pressDeadline = deadline;
        const watch = attribution.watchTouches(guest.id);
        try {
          let result: Awaited<ReturnType<typeof run>>;
          try {
            result = await run();
          } catch (err) {
            // A press whose end went out and then changed the document is a completed effect (the action guard decides); it still must have reached this page and no other.
            if (touchEnded && err instanceof BrowserActionError && err.code === "document-changed") {
              await confirmDelivery(watch, new AbortController().signal, false, deadline);
            }
            throw err;
          }
          await confirmDelivery(watch, live.signal, !touchMoved, deadline);
          return result;
        } finally {
          pressDeadline = null;
          if (touchOpen) {
            // The one dispatch made after a failure, past the document checks: it presses nothing, it only ends the window's open sequence.
            touchOpen = false;
            const cancelled = session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
            const closed = await within(cancelled, INPUT_DISPATCH_MAX_MS).then(() => true, (err: unknown) =>
              // A refused cancel (the page holds no sequence) leaves nothing open.
              !(err instanceof BrowserActionError && err.code === "input-not-delivered"));
            if (!closed) markWedged(host.windowId, guest, cancelled);
          }
          watch.stop();
        }
      });
    },
    pointerInput: async (run) => {
      const host = hostContentOrigin(guest);
      if (!host) throw new BrowserActionError("no-pointer-position", "the page has no live input window");
      refuseIfWedged(host.windowId);
      return aloneInWindow(host.windowId, live.signal, async () => {
        refuseIfWedged(host.windowId);
        pressDeadline = Date.now() + PRESS_MAX_MS;
        try { return await run(); } finally { pressDeadline = null; }
      });
    },
    wheelInput: async (run) => {
      const host = hostContentOrigin(guest);
      if (!host) throw new BrowserActionError("no-pointer-position", "the page has no live input window");
      refuseIfWedged(host.windowId);
      return aloneInWindow(host.windowId, live.signal, async () => {
        refuseIfWedged(host.windowId);
        const watch = attribution.watchWheel(guest.id);
        pressDeadline = Date.now() + PRESS_MAX_MS;
        try {
          const value = await run();
          const until = Math.min(Date.now() + TAP_ECHO_MAX_MS, pressDeadline);
          let delivery = watch.delivery();
          while (!(delivery.started && delivery.ended) && Date.now() < until) {
            await sleep(TAP_POLL_MS, live.signal);
            throwIfAborted(live.signal);
            delivery = watch.delivery();
          }
          if (!delivery.started || !delivery.ended || delivery.elsewhere > 0) throw new BrowserActionError("input-not-delivered", "the scroll did not reach only the intended page");
          return value;
        } finally { pressDeadline = null; watch.stop(); }
      });
    },
    mouseDrag: async (run) => {
      const host = hostContentOrigin(guest);
      if (!host) throw new BrowserActionError("no-pointer-position", "the page has no live input window");
      refuseIfWedged(host.windowId);
      return aloneInWindow(host.windowId, live.signal, async () => {
        refuseIfWedged(host.windowId);
        const watch = attribution.watchMouse(guest.id);
        const state: NonNullable<typeof nativeDrag> = { enabled: false, disabled: false, cancelled: false, dropped: false, dropSent: false, awaitingPayload: false,
          delivery: () => watch.delivery(), stop: () => {} };
        nativeDrag = state;
        state.stop = session.onEvent((method, params) => {
          if (method !== "Input.dragIntercepted") return;
          try {
            assertCurrent(false);
            const delivery = watch.delivery();
            if (!state.enabled || !state.awaitingPayload || state.data || !mouseOpen || !delivery.pressed || delivery.elsewhere !== 0) {
              throw new BrowserActionError("invalid-drag-source", "the intercepted payload did not follow the observed source press; no drop was sent");
            }
            state.data = browserDragData(params.data, approval!.origin);
          } catch (error) { state.error = error; }
        });
        pressDeadline = Date.now() + PRESS_MAX_MS;
        try {
          const value = await run({ intercepted: () => {
            assertCurrent(false);
            if (state.error) throw state.error;
            return state.data;
          } });
          const until = Math.min(Date.now() + TAP_ECHO_MAX_MS, pressDeadline);
          let delivery = watch.delivery();
          while (!(delivery.pressed && (state.dropped || delivery.released)) && Date.now() < until) {
            await sleep(TAP_POLL_MS, live.signal);
            throwIfAborted(live.signal);
            delivery = watch.delivery();
          }
          if (state.error) throw state.error;
          if (!delivery.pressed || !(state.data ? state.dropped && state.cancelled && state.disabled : delivery.released)
            || delivery.elsewhere > 0) throw new BrowserActionError("input-not-delivered", "the drag did not reach only the intended page");
          return value;
        } catch (error) {
          if (state.dropSent) throw new BrowserActionError(state.dropped && error instanceof BrowserActionError ? error.code : "drag-outcome-unknown",
            state.dropped ? "the destination acknowledged the drop before this action stopped; do not repeat it automatically"
              : "the destination drop was sent but its outcome is unknown; do not repeat it automatically", true);
          throw error;
        } finally {
          pressDeadline = null;
          state.stop();
          try {
            let clean = true;
            // Only the private, same-action entered target may be cancelled. After drop dispatch, acknowledgement loss is never retry-safe.
            if (state.destination && !state.dropSent) {
              const destination = state.destination;
              await within(session.send("Input.dispatchDragEvent", { type: "dragCancel", ...destination }), INPUT_DISPATCH_MAX_MS)
                .catch(() => { clean = false; });
            }
            // Cleanup uses the original session even after document/user cancellation. Neither command can create a destination effect.
            if (mouseOpen || state.enabled) {
              if (!state.dropped) await within(session.send("Input.cancelDragging"), INPUT_DISPATCH_MAX_MS).then(() => { mouseOpen = false; }, () => { clean = false; });
              if (state.enabled) await within(session.send("Input.setInterceptDrags", { enabled: false }), INPUT_DISPATCH_MAX_MS).then(() => { state.enabled = false; }, () => { clean = false; });
            }
            if (!clean || (state.dropSent && !state.dropped)) {
              // An unproved cleanup or drop outcome cannot own later input.
              attached.delete(guest);
              try { guest.debugger.detach(); } catch { /* guest destruction also ends its session */ }
              markWedged(host.windowId, guest, new Promise(() => {}));
            }
          } finally {
            state.data = undefined;
            state.destination = undefined;
            state.error = undefined;
            nativeDrag = undefined;
            watch.stop();
            if (mouseOpen) markWedged(host.windowId, guest, new Promise(() => {}));
          }
        }
      });
    },
    releaseFocus: () => attribution.releaseFocus(guest.id),
    focusPage: async () => {
      assertCurrent(false);
      try { await attribution.focusGuest(guest.id); }
      catch { assertCurrent(false); throw new BrowserActionError("no-focus", "the approved page did not take native keyboard focus"); }
      assertCurrent(false);
      const focused = await pollUntil(live.signal, FOCUS_MAX_MS, async () => {
        assertCurrent(false); return guest.focusedFrame === guest.mainFrame ? true : undefined;
      });
      if (!focused) throw new BrowserActionError("no-focus", "the approved main frame did not take native keyboard focus");
    },
    onDestroyed: (listener) => { guest.once("destroyed", listener); return () => { guest.removeListener("destroyed", listener); }; },
    signal: live.signal,
    documentId: () => live.tab.documentId,
    navigationOutcome: () => !live.callerSignal?.aborted && live.tab.controlMode !== "human-paused" && live.tab.guest === guest && !guest.isDestroyed() && live.tab.lease?.id === live.leaseId,
    iframeOrigins: () => guest.mainFrame.framesInSubtree
      .filter((frame) => frame !== guest.mainFrame)
      .map((frame) => browserOrigin(frame.url) ?? "opaque origin"),
    assertCurrent,
  };
}

// The approved load may change documents; caller and control cancellation still stop it.
function navigationLifecycle(live: LiveTab, guest: WebContents): { signal: AbortSignal; stop(): void } {
  throwIfAborted(live.signal);
  const controller = new AbortController();
  let stopped = false;
  let unwatch = () => {};
  const valid = () => !guest.isDestroyed() && live.tab.guest === guest && live.tab.controlMode !== "human-paused"
    && live.leaseId !== undefined && live.tab.lease?.id === live.leaseId;
  if (!valid() || (live.approval && (live.approval.tabId !== live.tab.handle || live.approval.documentId !== live.tab.documentId
    || live.approval.controlGeneration !== live.tab.controlGeneration))) {
    throw new BrowserActionError("document-changed", "the navigation target or control lease changed before loading");
  }
  const cancelCaller = () => controller.abort(live.callerSignal?.reason ?? new Error("navigation cancelled"));
  const destroyed = () => controller.abort(new Error("the browser tab was closed"));
  const watch = (signal: AbortSignal) => {
    if (stopped || controller.signal.aborted) return;
    unwatch();
    const changed = () => {
      if (signal.reason instanceof BrowserDocumentChangedError && !live.callerSignal?.aborted && valid()) {
        // The registry installs the new document controller after aborting the previous one. Observe that controller at the next microtask boundary.
        queueMicrotask(() => { if (!stopped) { if (valid()) watch(live.tab.actions.signal); else destroyed(); } });
      } else controller.abort(signal.reason);
    };
    signal.addEventListener("abort", changed, { once: true });
    unwatch = () => { signal.removeEventListener("abort", changed); };
    if (signal.aborted) changed();
  };
  live.callerSignal?.addEventListener("abort", cancelCaller, { once: true });
  if (live.callerSignal?.aborted) cancelCaller();
  guest.once("destroyed", destroyed);
  watch(live.signal);
  return { signal: controller.signal, stop: () => {
    stopped = true; unwatch(); live.callerSignal?.removeEventListener("abort", cancelCaller); guest.removeListener("destroyed", destroyed);
  } };
}

// The page actions over real guests, as browser-tools.ts calls them. `origin` is the tools' own origin rule, passed in so both sides use one definition.
export function createBrowserPageActions(
  attribution: InputAttribution,
  originOf: (url: string) => string | null,
  hostContentOrigin: HostContentOrigin,
  recordPreview?: AgentPreviewRecorder,
): BrowserPageActions<WebContents> {
  // Run one input action with its tab's main frame watched, so the settle after it waits for a navigation the input started. The closing Page.enable
  // is a renderer round trip: navigation requests the page made while handling the input arrive before its reply (the same epilogue Playwright uses).
  const tracked = async (live: LiveTab, act: () => Promise<void>): Promise<void> => {
    const guest = live.tab.guest;
    if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
    const session = await cdpFor(guest, live.signal, () => attribution.documentChanged(guest.id));
    actionNavigations.get(guest)?.stop();
    actionNavigations.delete(guest);
    const navigation = await watchActionNavigation(guest as unknown as NavigationGuest, session);
    try {
      await act();
      try { await session.send("Page.enable"); } catch (err) {
        throw new BrowserActionError("tab-gone", `the action was sent, but the tab stopped answering: ${(err as Error).message.slice(0, 200)}`, true);
      }
    } catch (err) {
      navigation.stop();
      throw err;
    }
    actionNavigations.set(guest, navigation);
  };
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
    screenshot: async (live: LiveTab, options) => screenshot(await targetFor(live, attribution, hostContentOrigin), SCREENSHOT_MAX_MS, options),
    capturePreview: (live: LiveTab, png) => captureAgentPreview(live.tab, png, recordPreview),
    hover: async (live, ref) => tracked(live, async () => hover(await targetFor(live, attribution, hostContentOrigin, true), ref)),
    drag: async (live, sourceRef, targetRef) => tracked(live, async () => drag(await targetFor(live, attribution, hostContentOrigin, true), sourceRef, targetRef)),
    select: async (live, ref, value) => tracked(live, async () => select(await targetFor(live, attribution, hostContentOrigin, true), ref, value)),
    scroll: async (live, ref, direction, pixels) => tracked(live, async () => scroll(await targetFor(live, attribution, hostContentOrigin, true), ref, direction, pixels)),
    upload: async (live, ref, options) => {
      if (!live.approval) throw new BrowserActionError("upload-unapproved", "upload requires approval for the current document");
      return upload(await targetFor(live, attribution, hostContentOrigin, true), ref, { ...options, ...live.approval, ref, signal: live.signal });
    },
    waitFor: async (live: LiveTab, options: { text?: string; timeMs?: number }) =>
      waitFor(await targetFor(live, attribution, hostContentOrigin), options),
    click: async (live: LiveTab, ref: string) =>
      tracked(live, async () => click(await targetFor(live, attribution, hostContentOrigin, true), ref, browserRefs, live.onObservationTarget)),
    type: async (live: LiveTab, ref: string, text: string, options: { submit?: boolean }) =>
      tracked(live, async () => type(await targetFor(live, attribution, hostContentOrigin, true), ref, text, options, browserRefs, live.onObservationTarget)),
    pressKey: async (live: LiveTab, key: string, ref?: string) =>
      tracked(live, async () => pressKey(await targetFor(live, attribution, hostContentOrigin, true), key, ref)),
    navigate: async (live: LiveTab, url: string, approvedOrigin: string) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      const lifecycle = navigationLifecycle(live, guest);
      try { return await navigate(guest as unknown as NavigableGuest, url, approvedOrigin, lifecycle.signal, originOf); }
      finally { lifecycle.stop(); }
    },
    settle: async (live: LiveTab) => {
      const guest = live.tab.guest;
      if (!guest || guest.isDestroyed()) throw new BrowserActionError("tab-gone", "the tab was closed");
      const navigation = actionNavigations.get(guest);
      actionNavigations.delete(guest);
      const started = Date.now();
      try { await navigation?.outcome(live.signal, SETTLE_MAX_MS); } finally { navigation?.stop(); }
      return settle(guest, live.signal, Math.max(0, SETTLE_MAX_MS - (Date.now() - started)));
    },
  };
}
