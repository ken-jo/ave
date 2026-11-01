// Lazy-loaded browser actions re-resolve tabs within the caller's window and recheck approved page scope at execution.
// Frame every page read as untrusted web data.
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { authorizedApprovalMemoryScope } from "./approval-memory-context.js";
import { observeAgentBrowserCommand } from "./agent-browser-observation.js";
import type { BrowserObservationAction, BrowserObservationElement } from "../shared/agent-observation.js";
import { toolSessionId } from "./base.js";
import { neutralizeFenceClose, neutralizeFenceOpen } from "../shared/fence-sanitizer.js";
import { validateExternalUrl } from "../shared/external-url.js";
import { BROWSER_OUTPUT_MAX_CHARS, BROWSER_PAGE_STRING_MAX_CHARS, BROWSER_TOOL, type BrowserToolName } from "../shared/browser-tools.js";
import type { BrowserGuest } from "../main/browser/browser-tab-registry.js";
import {
  BROWSER_PRESSABLE_KEYS,
  BROWSER_TAB_ID_PATTERN,
  browserOrigin,
  type BrowserActionTab,
  type BrowserPageActions,
  type BrowserToolDeps,
  type BrowserToolInput,
  type BrowserToolPolicy,
  type ResolvedBrowserTab,
} from "./browser-tools.js";
import type { BrowserSessionActor } from "../shared/browser-surface.js";
import { t } from "../i18n/index.js";

const MAX_TYPED_CHARS = 10_000;
const MAX_WAIT_MS = 30_000;
const REF_PATTERN = /^e\d+$/;
const PAGE_OBSERVATION_ACTIONS = Object.freeze({
  [BROWSER_TOOL.click]: "click", [BROWSER_TOOL.type]: "type", [BROWSER_TOOL.pressKey]: "press-key",
  [BROWSER_TOOL.hover]: "hover", [BROWSER_TOOL.drag]: "drag", [BROWSER_TOOL.select]: "select",
  [BROWSER_TOOL.scroll]: "scroll",
} as const);

const NO_WINDOW = "the browser tools are available only to a conversation in an app window (or its sub-agents); this session has no browser";

function failure(error: string): ToolExecutionResult {
  return { output: fenceBrowserContent({ error }), isError: true };
}

const FENCE_OPEN = '<browser-content trust="untrusted-web-data">';

function neutralize(value: string): string {
  return neutralizeFenceOpen(neutralizeFenceClose(value, "browser-content"), "browser-content");
}

function pageString(value: string, state: { truncated: boolean }): string {
  const safe = neutralize(value.slice(0, BROWSER_PAGE_STRING_MAX_CHARS));
  if (value.length <= BROWSER_PAGE_STRING_MAX_CHARS && safe.length <= BROWSER_PAGE_STRING_MAX_CHARS) return safe;
  state.truncated = true;
  return `${safe.slice(0, BROWSER_PAGE_STRING_MAX_CHARS - 1)}…`;
}

// Preserve valid JSON while bounding header entries.
function boundedHeader(value: unknown, budget: number, state: { truncated: boolean }, depth = 0): string | undefined {
  if (depth > 20) {
    state.truncated = true;
    return budget >= 4 ? "null" : undefined;
  }
  if (value !== null && typeof value === "object") {
    if (budget < 2) return undefined;
    const array = Array.isArray(value);
    const parts: string[] = [];
    let used = 2;
    const entries = array ? value.map((entry) => ["", entry] as const) : Object.entries(value);
    for (const [key, entry] of entries) {
      const prefix = array ? "" : `${JSON.stringify(pageString(key, state))}:`;
      const separator = parts.length > 0 ? 1 : 0;
      const encoded = boundedHeader(entry, budget - used - separator - prefix.length, state, depth + 1);
      if (encoded === undefined) {
        state.truncated = true;
        break;
      }
      parts.push(`${prefix}${encoded}`);
      used += separator + prefix.length + encoded.length;
    }
    return `${array ? "[" : "{"}${parts.join(",")}${array ? "]" : "}"}`;
  }
  const encoded = JSON.stringify(typeof value === "string" ? pageString(value, state) : value) ?? "null";
  return encoded.length <= budget ? encoded : undefined;
}

// Neutralize all page strings before framing so content cannot close or forge a trust boundary.
export function fenceBrowserContent(header: unknown, body?: string): string {
  const prefix = `${FENCE_OPEN}\n${t("be_browserTools.untrusted")}\n`;
  const suffix = "\n</browser-content>";
  const separator = body === undefined ? "" : "\n";
  const budget = BROWSER_OUTPUT_MAX_CHARS - prefix.length - suffix.length - separator.length;
  const state = { truncated: false };
  const record = header !== null && typeof header === "object" && !Array.isArray(header) ? header : { result: header };
  // Reserve the truncation field before allocating the header and page outline.
  let json = boundedHeader(record, budget - 20, state) ?? "{}";
  const safeBody = body === undefined ? undefined : neutralize(body.slice(0, BROWSER_OUTPUT_MAX_CHARS));
  if (body !== undefined && (body.length > BROWSER_OUTPUT_MAX_CHARS || safeBody!.length > budget - json.length)) state.truncated = true;
  if (state.truncated) json = JSON.stringify({ ...JSON.parse(json) as Record<string, unknown>, truncated: true });
  const outline = safeBody === undefined ? "" : safeBody.slice(0, Math.max(0, budget - json.length));
  return `${prefix}${json}${separator}${outline}${suffix}`;
}

function fenced(header: unknown, body?: string): ToolExecutionResult {
  return { output: fenceBrowserContent(header, body), isError: false };
}

function signalOptions(ctx: ToolExecutionContext): { signal?: AbortSignal } {
  return ctx.abortSignal ? { signal: ctx.abortSignal } : {};
}

export type BrowserToolExecutors = Record<BrowserToolName, (input: BrowserToolInput, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>>;

function actorOf<G extends BrowserGuest>(ctx: ToolExecutionContext, deps: BrowserToolDeps<G>): BrowserSessionActor {
  const sessionId = toolSessionId(ctx);
  if (!sessionId) throw new Error("Missing browser session identity");
  const directParentSessionId = deps.liveOriginSessionId(sessionId);
  return { sessionId, ...(directParentSessionId ? { directParentSessionId } : {}) };
}

export function createBrowserToolExecutors<G extends BrowserGuest>(
  deps: BrowserToolDeps<G>,
  policy: BrowserToolPolicy<G>,
): BrowserToolExecutors {
  /** Why this conversation's window opens no tab for it, naming the page its tab-less calls act on; undefined when it can open tabs. */
  const noTabOpener = (scope: { windowId: number; hostSessionId: string }): string | undefined => {
    if (deps.opensAgentTabs?.(scope.hostSessionId) !== false) return undefined;
    const attached = deps.tabs.defaultBrowserTab(scope.windowId, scope.hostSessionId);
    if (!attached.ok) return `this chat cannot open browser tabs: ${attached.error}`;
    const url = deps.tabs.liveTabInWindow(attached.handle, scope.windowId)?.guest?.getURL();
    return `this chat cannot open browser tabs; it works in ${attached.handle}${url ? ` (${url})` : ""}. `
      + "Load a URL there with browser_navigate and omit tabId.";
  };

  const live = (
    input: BrowserToolInput,
    ctx: ToolExecutionContext,
    mutation = false,
  ): { ok: true; windowId: number; resolved: ResolvedBrowserTab<G>; signal: AbortSignal } | { ok: false; result: ToolExecutionResult } => {
    const sessionId = toolSessionId(ctx);
    const scope = policy.windowOf(sessionId);
    if (!scope) return { ok: false, result: failure(NO_WINDOW) };
    if (input.tabId !== undefined && (typeof input.tabId !== "string" || !BROWSER_TAB_ID_PATTERN.test(input.tabId))) {
      return { ok: false, result: failure("tabId must be a tab id from browser_tabs, like \"tab-2\"") };
    }
    const approved = authorizedApprovalMemoryScope(ctx);
    const approvedTabId = approved?.kind === "browser-origin" || approved?.kind === "browser-agent-tabs" ? approved.tabId : undefined;
    let handle = (input.tabId as string | undefined) ?? approvedTabId;
    if (handle === undefined) {
      const fallback = deps.tabs.defaultBrowserTab(scope.windowId, scope.hostSessionId);
      if (!fallback.ok) return { ok: false, result: failure(fallback.error) };
      handle = fallback.handle;
    }
    const resolved = policy.resolveTab({ ...input, tabId: handle }, sessionId);
    if (!resolved) {
      // Another window's tab answers exactly like one that does not exist.
      return { ok: false, result: failure(`no browser tab ${JSON.stringify(handle)}; call browser_tabs to list this window's tabs`) };
    }
    const signals = [...(mutation ? [resolved.tab.actions.signal] : []), ...(ctx.abortSignal ? [ctx.abortSignal] : [])];
    if (mutation) {
      deps.tabs.assertActorAccess(resolved.tab, actorOf(ctx, deps));
      if (resolved.tab.controlMode === "human-paused") return { ok: false, result: failure("browser control is paused; ask the user to resume this tab") };
    }
    return { ok: true, windowId: scope.windowId, resolved, signal: AbortSignal.any(signals) };
  };

  // Recheck the exact approved tab and document to prevent page changes during approval.
  const unchangedSinceApproval = (
    ctx: ToolExecutionContext,
    resolved: ResolvedBrowserTab<G>,
  ): ToolExecutionResult | null => {
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "browser-origin") {
      return failure("this call was not approved for the page the tab shows; nothing was done. Call it again to ask.");
    }
    if (!Number.isSafeInteger(scope.documentId) || scope.tabId !== resolved.tab.handle || scope.documentId !== resolved.tab.documentId
      || scope.origin !== resolved.origin || scope.tabOpener !== resolved.opener || scope.controlGeneration !== resolved.tab.controlGeneration) {
      const now = resolved.origin ?? "a page that is not an http(s) site";
      const who = scope.tabOpener !== resolved.opener ? " and the user has taken over the tab" : "";
      return failure(
        `the tab changed after approval (approved for ${scope.origin}; it now shows ${now}${who}); nothing was done. Call again.`,
      );
    }
    return null;
  };

  const recheck = (
    input: BrowserToolInput,
    ctx: ToolExecutionContext,
    target: Extract<ReturnType<typeof live>, { ok: true }>,
  ): ReturnType<typeof live> => {
    if (target.signal.aborted) return { ok: false, result: failure("the browser action was cancelled; nothing was done. Call again.") };
    const fresh = live({ ...input, tabId: target.resolved.tab.handle }, ctx);
    return fresh.ok ? { ...fresh, signal: AbortSignal.any([fresh.signal, target.signal]) } : fresh;
  };

  const pageTarget = (ctx: ToolExecutionContext, target: Extract<ReturnType<typeof live>, { ok: true }>): BrowserActionTab<G> => {
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "browser-origin" || scope.tabId === undefined || scope.documentId === undefined) {
      throw new Error("Missing browser approval identity");
    }
    return {
      tab: target.resolved.tab,
      signal: target.signal,
      ...(ctx.abortSignal ? { callerSignal: ctx.abortSignal } : {}),
      approval: { tabId: scope.tabId, origin: scope.origin, documentId: scope.documentId, controlGeneration: scope.controlGeneration! },
      ...(target.resolved.tab.lease ? { leaseId: target.resolved.tab.lease.id } : {}),
    };
  };

  const navigationUnchangedSinceApproval = (
    ctx: ToolExecutionContext,
    resolved: ResolvedBrowserTab<G>,
    origin: string,
  ): ToolExecutionResult | null => {
    const scope = authorizedApprovalMemoryScope(ctx);
    return scope?.kind === "browser-origin" && scope.origin === origin && scope.tabOpener === resolved.opener
      && scope.tabId === resolved.tab.handle && Number.isSafeInteger(scope.documentId) && scope.documentId === resolved.tab.documentId && scope.controlGeneration === resolved.tab.controlGeneration
      ? null
      : failure("this navigation was not approved for this tab as it is now; nothing was done. Call it again to ask.");
  };

  const safely = async (work: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    try {
      return await work();
    } catch (err) {
      const error = err as { name?: string; message?: string };
      if (error?.name === "BrowserActionError") return failure(error.message ?? "the browser action failed");
      return failure(`the browser action failed: ${error?.message ?? String(err)}`);
    }
  };

  const run = (work: (actions: BrowserPageActions<G>) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> =>
    safely(async () => work(await deps.loadActions()));

  const runMutation = (ctx: ToolExecutionContext, target: Extract<ReturnType<typeof live>, { ok: true }>,
    action: BrowserObservationAction,
    work: (actions: BrowserPageActions<G>, onTarget: ((element: BrowserObservationElement, downloadUrl?: string) => void) | undefined) => Promise<ToolExecutionResult>,
    expectedDownloadUrl?: string) => safely(async () => {
    const lease = deps.tabs.acquireControl(target.resolved.tab, actorOf(ctx, deps));
    try { return await observeAgentBrowserCommand(target.resolved.tab, action,
      async (onTarget) => work(await deps.loadActions(), onTarget), ctx.abortSignal, expectedDownloadUrl); }
    finally { deps.tabs.releaseControl(target.resolved.tab.handle, lease.id); }
  });

  // Model URLs allow only HTTP(S) without embedded credentials.
  const validUrl = (value: unknown): { ok: true; url: string; origin: string } | { ok: false; result: ToolExecutionResult } => {
    if (typeof value !== "string" || value.length === 0) return { ok: false, result: failure("url must be an http:// or https:// URL") };
    const checked = validateExternalUrl(value);
    const origin = checked.ok ? browserOrigin(checked.url) : null;
    if (!checked.ok || origin === null) {
      return { ok: false, result: failure("refused: only http:// and https:// URLs without credentials can be opened (file:, javascript:, data: and other schemes are denied)") };
    }
    return { ok: true, url: checked.url, origin };
  };

  const validRef = (input: BrowserToolInput): string | null =>
    typeof input.ref === "string" && REF_PATTERN.test(input.ref) ? null : "ref must be an element ref from browser_snapshot, like \"e12\"";

  const pageAction = (
    name: keyof typeof PAGE_OBSERVATION_ACTIONS,
    validate: (input: BrowserToolInput) => string | null,
    act: (actions: BrowserPageActions<G>, target: BrowserActionTab<G>, input: BrowserToolInput) => Promise<void>,
  ) => async (input: BrowserToolInput, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
    const invalid = validate(input);
    if (invalid) return failure(invalid);
    const target = live(input, ctx, true);
    if (!target.ok) return target.result;
    const changed = unchangedSinceApproval(ctx, target.resolved);
    if (changed) return changed;
    return runMutation(ctx, target, PAGE_OBSERVATION_ACTIONS[name], async (actions, onTarget) => {
      const fresh = recheck(input, ctx, target);
      if (!fresh.ok) return fresh.result;
      const changed = unchangedSinceApproval(ctx, fresh.resolved);
      if (changed) return changed;
      await act(actions, { ...pageTarget(ctx, fresh), onObservationTarget: onTarget }, input);
      const outcome = await actions.settle({ tab: fresh.resolved.tab, signal: ctx.abortSignal ?? new AbortController().signal });
      return fenced({
        tabId: target.resolved.tab.handle,
        done: name,
        url: outcome.url,
        origin: browserOrigin(outcome.url),
        title: target.resolved.tab.guest?.getTitle() ?? "",
      });
    });
  };

  const executors: BrowserToolExecutors = {
    [BROWSER_TOOL.tabs]: async (input, ctx) => {
      const scope = policy.windowOf(toolSessionId(ctx));
      if (!scope) return failure(NO_WINDOW);
      if (input.scope !== undefined && input.scope !== "window" && input.scope !== "conversation") return failure("scope must be window or conversation");
      if (input.includeDirectChildren !== undefined && typeof input.includeDirectChildren !== "boolean") return failure("includeDirectChildren must be a boolean");
      if (input.includeDirectChildren !== undefined && input.scope !== "conversation") return failure("includeDirectChildren requires conversation scope");
      const actor = actorOf(ctx, deps);
      if (input.select !== undefined) {
        if (typeof input.select !== "string" || !BROWSER_TAB_ID_PATTERN.test(input.select)) {
          return failure("select must be a tab id from browser_tabs, like \"tab-2\"");
        }
        const selected = deps.tabs.liveTabInWindow(input.select, scope.windowId);
        if (!selected) return failure(`no browser tab ${JSON.stringify(input.select)}; call browser_tabs to list this window's tabs`);
        const result = await observeAgentBrowserCommand(selected, "tab-switch", async () => {
          const outcome = await deps.tabs.requestTabOp(scope.windowId, { op: "select", tabId: selected.handle, actor }, signalOptions(ctx));
          return outcome.ok ? fenced({ selected: selected.handle }) : failure(outcome.error === "no-such-tab"
            ? `no browser tab ${JSON.stringify(input.select)}; call browser_tabs to list this window's tabs`
            : `could not show the tab (${outcome.error})`);
        }, ctx.abortSignal);
        if (result.isError) return result;
      }
      const tabs = input.scope === "conversation" ? deps.tabs.listSessionTabs(scope.windowId, actor, input.includeDirectChildren === true) : deps.tabs.listTabs(scope.windowId);
      const note = noTabOpener(scope) ?? (tabs.length === 0 ? t("be_browserTools.noTabs") : undefined);
      return fenced({ tabs, ...(note !== undefined ? { note } : {}) });
    },

    [BROWSER_TOOL.snapshot]: async (input, ctx) => {
      for (const flag of ["interactive", "delta"] as const) {
        if (input[flag] !== undefined && typeof input[flag] !== "boolean") return failure(`${flag} must be a boolean`);
      }
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const changed = unchangedSinceApproval(ctx, target.resolved);
      if (changed) return changed;
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = unchangedSinceApproval(ctx, fresh.resolved);
        if (changed) return changed;
        const shot = await actions.snapshot(
          pageTarget(ctx, fresh),
          { interactive: input.interactive === true, delta: input.delta === true },
        );
        return fenced({
          tabId: target.resolved.tab.handle,
          url: shot.url,
          title: shot.title,
          refs: shot.refCount,
          ...(shot.delta ? { delta: true } : {}),
          ...(shot.truncated ? { truncated: true } : {}),
        }, shot.text);
      });
    },

    [BROWSER_TOOL.screenshot]: async (input, ctx) => {
      if (input.fullPage !== undefined && typeof input.fullPage !== "boolean") return failure("fullPage must be a boolean");
      if (input.fullPage === true) return failure("screenshot-unavailable: full page capture is unavailable; use a viewport screenshot");
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const changed = unchangedSinceApproval(ctx, target.resolved);
      if (changed) return changed;
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = unchangedSinceApproval(ctx, fresh.resolved);
        if (changed) return changed;
        const image = await actions.screenshot(pageTarget(ctx, fresh), { fullPage: input.fullPage === true });
        return {
          output: fenceBrowserContent({ tabId: target.resolved.tab.handle, url: target.resolved.tab.guest?.getURL() ?? "", fullPage: input.fullPage === true }),
          isError: false,
          image: { data: image.data, mimeType: image.mimeType, bytes: image.bytes },
        };
      });
    },

    [BROWSER_TOOL.wait]: async (input, ctx) => {
      if (input.text !== undefined && (typeof input.text !== "string" || input.text.length === 0 || input.text.length > 500)) {
        return failure("text must be a non-empty string of at most 500 characters");
      }
      if (input.timeMs !== undefined && (!Number.isInteger(input.timeMs) || (input.timeMs as number) < 1 || (input.timeMs as number) > MAX_WAIT_MS)) {
        return failure(`timeMs must be an integer from 1 to ${MAX_WAIT_MS}`);
      }
      if (input.text === undefined && input.timeMs === undefined) return failure("give text to wait for, timeMs, or both");
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const changed = unchangedSinceApproval(ctx, target.resolved);
      if (changed) return changed;
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = unchangedSinceApproval(ctx, fresh.resolved);
        if (changed) return changed;
        const waited = await actions.waitFor(
          pageTarget(ctx, fresh),
          {
            ...(typeof input.text === "string" ? { text: input.text } : {}),
            ...(typeof input.timeMs === "number" ? { timeMs: input.timeMs } : {}),
          },
        );
        const completed = recheck(input, ctx, fresh);
        if (!completed.ok) return completed.result;
        const changedAfterWait = unchangedSinceApproval(ctx, completed.resolved);
        if (changedAfterWait) return changedAfterWait;
        return fenced({ tabId: target.resolved.tab.handle, ...waited });
      });
    },

    [BROWSER_TOOL.navigate]: async (input, ctx) => {
      const url = validUrl(input.url);
      if (!url.ok) return url.result;
      const target = live(input, ctx, true);
      if (!target.ok) return target.result;
      const changed = navigationUnchangedSinceApproval(ctx, target.resolved, url.origin);
      if (changed) return changed;
      return runMutation(ctx, target, "navigate", async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = navigationUnchangedSinceApproval(ctx, fresh.resolved, url.origin);
        if (changed) return changed;
        const loaded = await actions.navigate(pageTarget(ctx, fresh), url.url, url.origin);
        return fenced({ tabId: target.resolved.tab.handle, url: loaded.url, title: target.resolved.tab.guest?.getTitle() ?? "" });
      }, url.url);
    },

    [BROWSER_TOOL.hover]: pageAction(BROWSER_TOOL.hover, validRef, (actions, target, input) => actions.hover(target, input.ref as string)),
    [BROWSER_TOOL.drag]: pageAction(BROWSER_TOOL.drag, (input) =>
      validRef({ ref: input.sourceRef }) ?? validRef({ ref: input.targetRef }),
      (actions, target, input) => actions.drag(target, input.sourceRef as string, input.targetRef as string)),
    [BROWSER_TOOL.select]: pageAction(BROWSER_TOOL.select, (input) => validRef(input)
      ?? (typeof input.value === "string" && input.value.length <= 1000 ? null : "value must be a string of at most 1000 characters"),
      (actions, target, input) => actions.select(target, input.ref as string, input.value as string)),
    [BROWSER_TOOL.scroll]: pageAction(BROWSER_TOOL.scroll, (input) => validRef(input)
      ?? (["up", "down", "left", "right"].includes(input.direction as string) && Number.isInteger(input.pixels) && (input.pixels as number) >= 1 && (input.pixels as number) <= 2000 ? null : "scroll needs a direction and 1 to 2000 pixels"),
      (actions, target, input) => actions.scroll(target, input.ref as string, input.direction as "up" | "down" | "left" | "right", input.pixels as number)),
    [BROWSER_TOOL.upload]: async (input, ctx) => {
      const invalid = validRef(input);
      if (invalid) return failure(invalid);
      const target = live(input, ctx, true);
      if (!target.ok) return target.result;
      const changed = unchangedSinceApproval(ctx, target.resolved);
      if (changed) return changed;
      return runMutation(ctx, target, "upload", async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = unchangedSinceApproval(ctx, fresh.resolved);
        if (changed) return changed;
        const result = await actions.upload(pageTarget(ctx, fresh), input.ref as string, { windowId: target.windowId, sessionId: actorOf(ctx, deps).sessionId, pickFiles: deps.pickUploadFiles });
        return fenced({ tabId: target.resolved.tab.handle, ...result });
      });
    },
    [BROWSER_TOOL.click]: pageAction(
      BROWSER_TOOL.click,
      validRef,
      (actions, target, input) => actions.click(target, input.ref as string),
    ),

    [BROWSER_TOOL.type]: pageAction(
      BROWSER_TOOL.type,
      (input) => validRef(input)
        ?? (typeof input.text !== "string" || input.text.length > MAX_TYPED_CHARS
          ? `text must be a string of at most ${MAX_TYPED_CHARS} characters`
          : input.submit !== undefined && typeof input.submit !== "boolean" ? "submit must be a boolean" : null),
      (actions, target, input) => actions.type(target, input.ref as string, input.text as string, { submit: input.submit === true }),
    ),

    [BROWSER_TOOL.pressKey]: pageAction(
      BROWSER_TOOL.pressKey,
      (input) => typeof input.key !== "string" || !(BROWSER_PRESSABLE_KEYS as readonly string[]).includes(input.key)
        ? `key must be one of ${BROWSER_PRESSABLE_KEYS.join(", ")}`
        : input.ref === undefined ? null : validRef(input),
      (actions, target, input) => actions.pressKey(target, input.key as string, input.ref as string | undefined),
    ),

    [BROWSER_TOOL.tabNew]: async (input, ctx) => {
      const url = validUrl(input.url);
      if (!url.ok) return url.result;
      const scope = policy.windowOf(toolSessionId(ctx));
      if (!scope) return failure(NO_WINDOW);
      const unopenable = noTabOpener(scope);
      if (unopenable !== undefined) return failure(unopenable);
      const authorized = authorizedApprovalMemoryScope(ctx);
      if (authorized?.kind !== "browser-origin" || authorized.origin !== url.origin) {
        return failure("this tab was not approved for that URL; nothing was done. Call it again to ask.");
      }
      const outcome = await deps.tabs.requestTabOp(
        scope.windowId,
        { op: "new", url: url.url, sessionId: scope.hostSessionId, actor: actorOf(ctx, deps), active: false },
        signalOptions(ctx),
      );
      if (!outcome.ok) return failure(`could not open the tab (${outcome.error})`);
      const tab = deps.tabs.liveTabInWindow(outcome.tabId, scope.windowId);
      if (!tab) return failure(`the tab ${outcome.tabId} closed as it opened`);
      const documentId = tab.documentId;
      const guest = tab.guest;
      const signal = AbortSignal.any([tab.actions.signal, ...(ctx.abortSignal ? [ctx.abortSignal] : [])]);
      // Install the origin guard before navigating the blank bound view or following redirects.
      const lease = deps.tabs.acquireControl(tab, actorOf(ctx, deps));
      try { return await observeAgentBrowserCommand(tab, "tab-open", () => run(async (actions) => {
        const fresh = deps.tabs.liveTabInWindow(outcome.tabId, scope.windowId);
        if (!fresh || signal.aborted || fresh.guest !== guest || fresh.documentId !== documentId || fresh.opener !== "agent") {
          return failure("the new tab changed before navigation; nothing was done. Call again.");
        }
        const loaded = await actions.navigate({ tab: fresh, signal, leaseId: lease.id, ...(ctx.abortSignal ? { callerSignal: ctx.abortSignal } : {}) }, url.url, url.origin);
        return fenced({ tabId: outcome.tabId, url: loaded.url, title: tab.guest?.getTitle() ?? "", openedBy: "agent" });
      }), ctx.abortSignal, url.url); } finally { deps.tabs.releaseControl(tab.handle, lease.id); }
    },

    [BROWSER_TOOL.tabClose]: async (input, ctx) => {
      if (input.tabId === undefined) return failure("tabId is required to close a tab");
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const authorized = authorizedApprovalMemoryScope(ctx);
      const correctKind = target.resolved.opener === "agent"
        ? authorized?.kind === "browser-agent-tabs"
        : authorized?.kind === "browser-origin" && authorized.tabOpener === target.resolved.opener && authorized.origin === target.resolved.origin;
      if (!correctKind || (authorized?.kind !== "browser-agent-tabs" && authorized?.kind !== "browser-origin")
        || authorized.tabId !== target.resolved.tab.handle || authorized.documentId !== target.resolved.tab.documentId
        || authorized.controlGeneration !== target.resolved.tab.controlGeneration) {
        return failure("the tab changed or the user took it over since approval; nothing was done. Call again to ask.");
      }
      return observeAgentBrowserCommand(target.resolved.tab, "tab-close", async () => {
        const outcome = await deps.tabs.requestTabOp(target.windowId, { op: "close", tabId: target.resolved.tab.handle, actor: actorOf(ctx, deps) }, signalOptions(ctx));
        if (!outcome.ok) return failure(`could not close the tab (${outcome.error})`);
        return fenced(outcome.retained ? { released: target.resolved.tab.handle, retained: true } : { closed: target.resolved.tab.handle });
      }, ctx.abortSignal);
    },
  };
  const allowed: Record<BrowserToolName, readonly string[]> = {
    [BROWSER_TOOL.tabs]: ["select", "scope", "includeDirectChildren"],
    [BROWSER_TOOL.snapshot]: ["tabId", "interactive", "delta"],
    [BROWSER_TOOL.screenshot]: ["tabId", "fullPage"],
    [BROWSER_TOOL.wait]: ["tabId", "text", "timeMs"],
    [BROWSER_TOOL.navigate]: ["tabId", "url"],
    [BROWSER_TOOL.click]: ["tabId", "ref"],
    [BROWSER_TOOL.hover]: ["tabId", "ref"],
    [BROWSER_TOOL.drag]: ["tabId", "sourceRef", "targetRef"],
    [BROWSER_TOOL.select]: ["tabId", "ref", "value"],
    [BROWSER_TOOL.scroll]: ["tabId", "ref", "direction", "pixels"],
    [BROWSER_TOOL.upload]: ["tabId", "ref"],
    [BROWSER_TOOL.type]: ["tabId", "ref", "text", "submit"],
    [BROWSER_TOOL.pressKey]: ["tabId", "ref", "key"],
    [BROWSER_TOOL.tabNew]: ["url"],
    [BROWSER_TOOL.tabClose]: ["tabId"],
  };
  for (const name of Object.values(BROWSER_TOOL)) {
    const execute = executors[name];
    executors[name] = (input, ctx) => Object.keys(input).some((key) => !allowed[name].includes(key))
      ? Promise.resolve(failure("unexpected browser tool input field"))
      : safely(() => execute(input, ctx));
  }
  return executors;
}
