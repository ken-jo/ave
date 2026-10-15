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
import { BROWSER_TOOL, type BrowserToolName } from "../shared/browser-tools.js";
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
  return { output: JSON.stringify({ error }), isError: true };
}

const FENCE_OPEN = '<browser-content trust="untrusted-web-data">';

function neutralize(value: string): string {
  return neutralizeFenceOpen(neutralizeFenceClose(value, "browser-content"), "browser-content");
}

function neutralizeStrings(value: unknown): unknown {
  if (typeof value === "string") return neutralize(value);
  if (Array.isArray(value)) return value.map(neutralizeStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, neutralizeStrings(entry)]));
  }
  return value;
}

/**
 * Frame a result as untrusted web data. Every string is neutralized before
 * the JSON is built, and a page outline after it, so no page text can close
 * the frame (or open a fake second one).
 */
export function fenceBrowserContent(header: unknown, body?: string): string {
  return [
    FENCE_OPEN,
    t("be_browserTools.untrusted"),
    JSON.stringify(neutralizeStrings(header)),
    ...(body === undefined ? [] : [neutralize(body)]),
    "</browser-content>",
  ].join("\n");
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
    const handle = (input.tabId as string | undefined) ?? deps.tabs.activeBrowserTab(scope.windowId);
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
   * tab shows, in a tab with the same opener. A read on an agent tab carries
   * no approval and only needs the tab to still be the agent's.
   */
  const unchangedSinceApproval = (
    ctx: ToolExecutionContext,
    resolved: ResolvedBrowserTab<G>,
    options: { readOnAgentTab?: boolean } = {},
  ): ToolExecutionResult | null => {
    const scope = authorizedApprovalMemoryScope(ctx);
    if (options.readOnAgentTab && scope?.kind === "browser-origin" && scope.tabOpener === "agent" && resolved.opener === "agent") {
      return null;
    }
    if (scope?.kind !== "browser-origin") {
      return failure("this call was not approved for the page the tab shows; nothing was done. Call it again to ask.");
    }
    if (scope.origin !== resolved.origin || scope.tabOpener !== resolved.opener) {
      const now = resolved.origin ?? "a page that is not an http(s) site";
      const who = scope.tabOpener !== resolved.opener ? " and the user has taken over the tab" : "";
      return failure(
        `the tab changed after approval (approved for ${scope.origin}; it now shows ${now}${who}); nothing was done. Call again to ask about the page it shows now.`,
      );
    }
    return null;
  };

  const run = async (work: (actions: BrowserPageActions<G>) => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    try {
      return await work(await deps.loadActions());
    } catch (err) {
      const error = err as { name?: string; message?: string };
      if (error?.name === "BrowserActionError") return failure(error.message ?? "the browser action failed");
      return failure(`the browser action failed: ${error?.message ?? String(err)}`);
    }
  };

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
      await act(actions, { tab: target.resolved.tab, signal: target.signal }, input);
      return fenced({
        tabId: target.resolved.tab.handle,
        done: name,
        url: target.resolved.tab.guest?.getURL() ?? "",
        title: target.resolved.tab.guest?.getTitle() ?? "",
      });
    });
  };

  return {
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
      const changed = unchangedSinceApproval(ctx, target.resolved, { readOnAgentTab: true });
      if (changed) return changed;
      return run(async (actions) => {
        const shot = await actions.snapshot(
          { tab: target.resolved.tab, signal: target.signal },
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
      const changed = unchangedSinceApproval(ctx, target.resolved, { readOnAgentTab: true });
      if (changed) return changed;
      return run(async (actions) => {
        const image = await actions.screenshot({ tab: target.resolved.tab, signal: target.signal });
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
        const waited = await actions.waitFor(
          { tab: target.resolved.tab, signal: target.signal },
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
      const scope = authorizedApprovalMemoryScope(ctx);
      if (scope?.kind !== "browser-origin" || scope.origin !== url.origin || scope.tabOpener !== target.resolved.opener) {
        return failure("this navigation was not approved for this tab as it is now; nothing was done. Call it again to ask.");
      }
      return run(async (actions) => {
        const loaded = await actions.navigate({ tab: target.resolved.tab, signal: target.signal }, url.url, url.origin);
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
      (input) => typeof input.key === "string" && (BROWSER_PRESSABLE_KEYS as readonly string[]).includes(input.key)
        ? null
        : `key must be one of ${BROWSER_PRESSABLE_KEYS.join(", ")}`,
      (actions, target, input) => actions.pressKey(target, input.key as string),
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
      return fenced({ tabId: outcome.tabId, url: tab?.guest?.getURL() ?? url.url, openedBy: "agent" });
    },

    [BROWSER_TOOL.tabClose]: async (input, ctx) => {
      if (input.tabId === undefined) return failure("tabId is required to close a tab");
      const target = live(input, ctx);
      if (!target.ok) return target.result;
      const authorized = authorizedApprovalMemoryScope(ctx);
      if (authorized?.kind === "browser-agent-tabs" && target.resolved.opener !== "agent") {
        return failure("the user has taken over this tab since approval; nothing was done. Call again to ask.");
      }
      const outcome = await deps.tabs.requestTabOp(target.windowId, { op: "close", tabId: target.resolved.tab.handle }, signalOptions(ctx));
      if (!outcome.ok) return failure(`could not close the tab (${outcome.error})`);
      return { output: JSON.stringify({ closed: target.resolved.tab.handle }), isError: false };
    },
  };
}
