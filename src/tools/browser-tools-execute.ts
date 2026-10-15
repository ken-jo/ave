/**
 * Execute bodies of the agent browser tools (browser-tools.ts holds their
 * schemas and policy hooks). Loaded on the first browser tool call, so none
 * of this sits in the main process's initial bundle.
 *
 * Every execute re-resolves the tab within the calling conversation's window,
 * re-checks the page against the scope the call was authorized under
 * (TOCTOU), then runs the page action. Everything read from a page is framed
 * `<browser-content trust="untrusted-web-data">`.
 */
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { authorizedApprovalMemoryScope } from "./approval-memory-context.js";
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
import { t } from "../i18n/index.js";

const MAX_TYPED_CHARS = 10_000;
const MAX_WAIT_MS = 30_000;
const REF_PATTERN = /^e\d+$/;

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

/** Preserve valid JSON while dropping entries that cannot fit the result budget. */
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

/**
 * Frame a result as untrusted web data. Every string is neutralized before
 * the JSON is built, and a page outline after it, so no page text can close
 * the frame (or open a fake second one).
 */
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

function sessionOf(ctx: ToolExecutionContext): string | undefined {
  return typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
}

function signalOptions(ctx: ToolExecutionContext): { signal?: AbortSignal } {
  return ctx.abortSignal ? { signal: ctx.abortSignal } : {};
}

export type BrowserToolExecutors = Record<BrowserToolName, (input: BrowserToolInput, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>>;

export function createBrowserToolExecutors<G extends BrowserGuest>(
  deps: BrowserToolDeps<G>,
  policy: BrowserToolPolicy<G>,
): BrowserToolExecutors {
  /** Window, tab, and the signal that cancels the action — or why not. */
  const live = (
    input: BrowserToolInput,
    ctx: ToolExecutionContext,
  ): { ok: true; windowId: number; resolved: ResolvedBrowserTab<G>; signal: AbortSignal } | { ok: false; result: ToolExecutionResult } => {
    const sessionId = sessionOf(ctx);
    const scope = policy.windowOf(sessionId);
    if (!scope) return { ok: false, result: failure(NO_WINDOW) };
    if (input.tabId !== undefined && (typeof input.tabId !== "string" || !BROWSER_TAB_ID_PATTERN.test(input.tabId))) {
      return { ok: false, result: failure("tabId must be a tab id from browser_tabs, like \"tab-2\"") };
    }
    const approved = authorizedApprovalMemoryScope(ctx);
    const approvedTabId = approved?.kind === "browser-origin" || approved?.kind === "browser-agent-tabs" ? approved.tabId : undefined;
    const handle = (input.tabId as string | undefined) ?? approvedTabId ?? deps.tabs.activeBrowserTab(scope.windowId);
    if (handle === undefined) {
      return { ok: false, result: failure("no browser tab is shown; pass a tabId from browser_tabs or open one with browser_tab_new") };
    }
    const resolved = policy.resolveTab({ ...input, tabId: handle }, sessionId);
    if (!resolved) {
      // Another window's tab answers exactly like one that does not exist.
      return { ok: false, result: failure(`no browser tab ${JSON.stringify(handle)}; call browser_tabs to list this window's tabs`) };
    }
    const signals = [resolved.tab.actions.signal, ...(ctx.abortSignal ? [ctx.abortSignal] : [])];
    return { ok: true, windowId: scope.windowId, resolved, signal: AbortSignal.any(signals) };
  };

  /**
   * TOCTOU: the page this call was approved for must still be the page the
   * tab shows, in the concrete tab and document that supplied the approval.
   */
  const unchangedSinceApproval = (
    ctx: ToolExecutionContext,
    resolved: ResolvedBrowserTab<G>,
  ): ToolExecutionResult | null => {
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "browser-origin") {
      return failure("this call was not approved for the page the tab shows; nothing was done. Call it again to ask.");
    }
    if (!Number.isSafeInteger(scope.documentId) || scope.tabId !== resolved.tab.handle || scope.documentId !== resolved.tab.documentId
      || scope.origin !== resolved.origin || scope.tabOpener !== resolved.opener) {
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
    return live({ ...input, tabId: target.resolved.tab.handle }, ctx);
  };

  const pageTarget = (ctx: ToolExecutionContext, target: Extract<ReturnType<typeof live>, { ok: true }>): BrowserActionTab<G> => {
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "browser-origin" || scope.tabId === undefined || scope.documentId === undefined) {
      throw new Error("Missing browser approval identity");
    }
    return {
      tab: target.resolved.tab,
      signal: target.signal,
      approval: { tabId: scope.tabId, origin: scope.origin, documentId: scope.documentId },
    };
  };

  const navigationUnchangedSinceApproval = (
    ctx: ToolExecutionContext,
    resolved: ResolvedBrowserTab<G>,
    origin: string,
  ): ToolExecutionResult | null => {
    const scope = authorizedApprovalMemoryScope(ctx);
    return scope?.kind === "browser-origin" && scope.origin === origin && scope.tabOpener === resolved.opener
      && scope.tabId === resolved.tab.handle && Number.isSafeInteger(scope.documentId) && scope.documentId === resolved.tab.documentId
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

  /** A model-supplied URL: http(s) only, no embedded credentials. */
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

  /** click / type / press_key: approved per page, re-checked, then acted. */
  const pageAction = (
    name: BrowserToolName,
    validate: (input: BrowserToolInput) => string | null,
    act: (actions: BrowserPageActions<G>, target: BrowserActionTab<G>, input: BrowserToolInput) => Promise<void>,
  ) => async (input: BrowserToolInput, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
    const invalid = validate(input);
    if (invalid) return failure(invalid);
    const target = live(input, ctx);
    if (!target.ok) return target.result;
    const changed = unchangedSinceApproval(ctx, target.resolved);
    if (changed) return changed;
    return run(async (actions) => {
      const fresh = recheck(input, ctx, target);
      if (!fresh.ok) return fresh.result;
      const changed = unchangedSinceApproval(ctx, fresh.resolved);
      if (changed) return changed;
      await act(actions, pageTarget(ctx, fresh), input);
      const outcome = await actions.settle({ tab: fresh.resolved.tab, signal: fresh.signal });
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
      const scope = policy.windowOf(sessionOf(ctx));
      if (!scope) return failure(NO_WINDOW);
      if (input.select !== undefined) {
        if (typeof input.select !== "string" || !BROWSER_TAB_ID_PATTERN.test(input.select)) {
          return failure("select must be a tab id from browser_tabs, like \"tab-2\"");
        }
        const outcome = await deps.tabs.requestTabOp(scope.windowId, { op: "select", tabId: input.select }, signalOptions(ctx));
        if (!outcome.ok) {
          return failure(outcome.error === "no-such-tab"
            ? `no browser tab ${JSON.stringify(input.select)}; call browser_tabs to list this window's tabs`
            : `could not show the tab (${outcome.error})`);
        }
      }
      const tabs = deps.tabs.listTabs(scope.windowId);
      return fenced({ tabs, ...(tabs.length === 0 ? { note: t("be_browserTools.noTabs") } : {}) });
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
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const changed = unchangedSinceApproval(ctx, target.resolved);
      if (changed) return changed;
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = unchangedSinceApproval(ctx, fresh.resolved);
        if (changed) return changed;
        const image = await actions.screenshot(pageTarget(ctx, fresh));
        return {
          output: fenceBrowserContent({ tabId: target.resolved.tab.handle, url: target.resolved.tab.guest?.getURL() ?? "" }),
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
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const waited = await actions.waitFor(
          { tab: fresh.resolved.tab, signal: fresh.signal },
          {
            ...(typeof input.text === "string" ? { text: input.text } : {}),
            ...(typeof input.timeMs === "number" ? { timeMs: input.timeMs } : {}),
          },
        );
        return fenced({ tabId: target.resolved.tab.handle, ...waited });
      });
    },

    [BROWSER_TOOL.navigate]: async (input, ctx) => {
      const url = validUrl(input.url);
      if (!url.ok) return url.result;
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const changed = navigationUnchangedSinceApproval(ctx, target.resolved, url.origin);
      if (changed) return changed;
      return run(async (actions) => {
        const fresh = recheck(input, ctx, target);
        if (!fresh.ok) return fresh.result;
        const changed = navigationUnchangedSinceApproval(ctx, fresh.resolved, url.origin);
        if (changed) return changed;
        const loaded = await actions.navigate(pageTarget(ctx, fresh), url.url, url.origin);
        return fenced({ tabId: target.resolved.tab.handle, url: loaded.url, title: target.resolved.tab.guest?.getTitle() ?? "" });
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
      const scope = policy.windowOf(sessionOf(ctx));
      if (!scope) return failure(NO_WINDOW);
      const authorized = authorizedApprovalMemoryScope(ctx);
      if (authorized?.kind !== "browser-origin" || authorized.origin !== url.origin) {
        return failure("this tab was not approved for that URL; nothing was done. Call it again to ask.");
      }
      const outcome = await deps.tabs.requestTabOp(
        scope.windowId,
        { op: "new", url: url.url, sessionId: scope.hostSessionId },
        signalOptions(ctx),
      );
      if (!outcome.ok) return failure(`could not open the tab (${outcome.error})`);
      const tab = deps.tabs.liveTabInWindow(outcome.tabId, scope.windowId);
      if (!tab) return failure(`the tab ${outcome.tabId} closed as it opened`);
      const documentId = tab.documentId;
      const guest = tab.guest;
      const signal = AbortSignal.any([tab.actions.signal, ...(ctx.abortSignal ? [ctx.abortSignal] : [])]);
      // The bound view starts blank. Navigation installs the origin guard before
      // allowing the approved URL or any redirect to load.
      return run(async (actions) => {
        const fresh = deps.tabs.liveTabInWindow(outcome.tabId, scope.windowId);
        if (!fresh || signal.aborted || fresh.guest !== guest || fresh.documentId !== documentId || fresh.opener !== "agent") {
          return failure("the new tab changed before navigation; nothing was done. Call again.");
        }
        const loaded = await actions.navigate({ tab: fresh, signal }, url.url, url.origin);
        return fenced({ tabId: outcome.tabId, url: loaded.url, title: tab.guest?.getTitle() ?? "", openedBy: "agent" });
      });
    },

    [BROWSER_TOOL.tabClose]: async (input, ctx) => {
      if (input.tabId === undefined) return failure("tabId is required to close a tab");
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const authorized = authorizedApprovalMemoryScope(ctx);
      if ((target.resolved.opener === "agent" || authorized?.kind === "browser-agent-tabs")
        && (authorized?.kind !== "browser-agent-tabs" || target.resolved.opener !== "agent"
          || authorized.tabId !== target.resolved.tab.handle || !Number.isSafeInteger(authorized.documentId)
          || authorized.documentId !== target.resolved.tab.documentId)) {
        return failure("the tab changed or the user took it over since approval; nothing was done. Call again to ask.");
      }
      const outcome = await deps.tabs.requestTabOp(target.windowId, { op: "close", tabId: target.resolved.tab.handle }, signalOptions(ctx));
      if (!outcome.ok) return failure(`could not close the tab (${outcome.error})`);
      return fenced({ closed: target.resolved.tab.handle });
    },
  };
  for (const name of Object.values(BROWSER_TOOL)) {
    const execute = executors[name];
    executors[name] = (input, ctx) => safely(() => execute(input, ctx));
  }
  return executors;
}
