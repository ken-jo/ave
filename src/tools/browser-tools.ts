/**
 * The agent browser tools: drive the browser tabs of the app window that
 * hosts the conversation.
 *
 *   browser_tabs        read     list this window's tabs; `select` shows one
 *   browser_snapshot    read on an agent tab; ask per origin (session) on a user tab
 *   browser_screenshot  same as browser_snapshot
 *   browser_wait        read     text to appear, or a time
 *   browser_navigate    ask      origin of the URL, session only (http/https only)
 *   browser_click       ask      origin of the tab, session only
 *   browser_type        ask      origin of the tab, session only
 *   browser_press_key   ask      origin of the tab, session only
 *   browser_tab_new     ask      origin of the URL, session only
 *   browser_tab_close   ask      agent tabs, session only
 *
 * POLICY lives in the ordinary pipeline, not here: each tool declares its
 * category, a remembered scope (`browser-origin` / `browser-agent-tabs`, both
 * session-only — no "always allow" for browser actions) and, for a tab the
 * user opened, `requiresPerActionApproval` (an explicit allow-once every
 * time). The hooks resolve the tab through the main-side registry using the
 * session the call belongs to; the model never supplies the origin.
 *
 * TOCTOU. A tab can navigate (or be released by the user's Stop) while the
 * approval card is open. Execute re-reads the tab's origin and opener and
 * compares them with the scope the call was authorized under; on a mismatch
 * it does nothing and says so, and calling again asks about the page the tab
 * shows now.
 *
 * SCOPE. Only the tabs of the window that hosts the calling conversation are
 * reachable (a sub-agent inherits its parent's); another window's tab answers
 * exactly like one that does not exist. Routines and headless runs get no
 * browser: no window hosts them, and every tool here is `arbitraryEgress`, so
 * unattended lanes never see the schemas at all.
 *
 * Everything read from a page (outline, title, URL) is framed
 * `<browser-content trust="untrusted-web-data">`. Page actions run in main
 * over the guest's DevTools session (main/browser/browser-actions.ts); those
 * and the execute bodies (browser-tools-execute.ts) load on first use.
 */
import { createDynamicTool, type Tool, type ToolPolicyContext } from "./base.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { resolveSessionWindow, type SessionWindowScopeDeps } from "./session-window-scope.js";
import { BROWSER_TOOL, type BrowserToolName } from "../shared/browser-tools.js";
import type { ApprovalMemoryScope, BrowserTabOpener } from "../shared/permissions-events.js";
import type { ToolCategory } from "../shared/permission-review-status.js";
import type {
  BrowserGuest,
  BrowserTabOpOutcome,
  BrowserTabRecord,
  BrowserTabView,
} from "../main/browser/browser-tab-registry.js";
import type { BrowserToolExecutors } from "./browser-tools-execute.js";
import { t } from "../i18n/index.js";

/** What the tools need of the main-side tab registry. */
interface BrowserTabsAccess<G extends BrowserGuest = BrowserGuest> {
  liveTab(handle: string): BrowserTabRecord<G> | undefined;
  liveTabInWindow(handle: string, windowId: number): BrowserTabRecord<G> | undefined;
  listTabs(windowId: number): BrowserTabView[];
  activeBrowserTab(windowId: number): string | undefined;
  requestTabOp(
    windowId: number,
    op: { op: "new"; url: string; sessionId?: string } | { op: "select" | "close"; tabId: string },
    options?: { signal?: AbortSignal },
  ): Promise<BrowserTabOpOutcome>;
}

/** One live tab handed to a page action, with the signal that cancels it. */
export interface BrowserActionTab<G extends BrowserGuest = BrowserGuest> {
  readonly tab: BrowserTabRecord<G>;
  readonly signal: AbortSignal;
}

/** The page actions (main/browser/browser-actions.ts), loaded on first use. */
export interface BrowserPageActions<G extends BrowserGuest = BrowserGuest> {
  snapshot(target: BrowserActionTab<G>, options: { interactive?: boolean; delta?: boolean }): Promise<{
    url: string;
    title: string;
    text: string;
    truncated: boolean;
    refCount: number;
    delta: boolean;
  }>;
  screenshot(target: BrowserActionTab<G>): Promise<{ data: string; mimeType: string; bytes: number }>;
  waitFor(target: BrowserActionTab<G>, options: { text?: string; timeMs?: number }): Promise<{ found: boolean; waitedMs: number }>;
  click(target: BrowserActionTab<G>, ref: string): Promise<void>;
  type(target: BrowserActionTab<G>, ref: string, text: string, options: { submit?: boolean }): Promise<void>;
  pressKey(target: BrowserActionTab<G>, key: string): Promise<void>;
  navigate(target: BrowserActionTab<G>, url: string, approvedOrigin: string): Promise<{ url: string }>;
}

export interface BrowserToolDeps<G extends BrowserGuest = BrowserGuest> extends SessionWindowScopeDeps {
  readonly tabs: BrowserTabsAccess<G>;
  readonly loadActions: () => Promise<BrowserPageActions<G>>;
}

/** Keys `browser_press_key` accepts (mirrors browser-actions.ts PRESSABLE_KEYS). */
export const BROWSER_PRESSABLE_KEYS = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
] as const;

const MAX_WAIT_MS = 30_000;
/** A tab handle from browser_tabs (minted by the main-side registry). */
export const BROWSER_TAB_ID_PATTERN = /^tab-\d+$/;

/** `scheme://host:port` of an http(s) URL, or null for anything else. */
export function browserOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
}

export type BrowserToolInput = Record<string, unknown>;

function asInput(raw: unknown): BrowserToolInput {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as BrowserToolInput : {};
}

export interface ResolvedBrowserTab<G extends BrowserGuest> {
  readonly tab: BrowserTabRecord<G>;
  readonly origin: string | null;
  readonly opener: BrowserTabOpener;
}

/** Scope resolution shared by the policy hooks and the execute bodies. */
export interface BrowserToolPolicy<G extends BrowserGuest> {
  windowOf(sessionId: string | undefined): { windowId: number; hostSessionId: string } | null;
  /** The tab an input names (or the window's shown tab), within the session's window. */
  resolveTab(input: BrowserToolInput, sessionId: string | undefined): ResolvedBrowserTab<G> | undefined;
}

export function createBrowserTools<G extends BrowserGuest>(deps: BrowserToolDeps<G>): Tool[] {
  const policy: BrowserToolPolicy<G> = {
    windowOf: (sessionId) => resolveSessionWindow(sessionId, deps),
    resolveTab: (input, sessionId) => {
      const scope = resolveSessionWindow(sessionId, deps);
      if (!scope) return undefined;
      if (input.tabId !== undefined && (typeof input.tabId !== "string" || !BROWSER_TAB_ID_PATTERN.test(input.tabId))) return undefined;
      const handle = (input.tabId as string | undefined) ?? deps.tabs.activeBrowserTab(scope.windowId);
      if (handle === undefined) return undefined;
      const tab = deps.tabs.liveTabInWindow(handle, scope.windowId);
      if (!tab || !tab.guest) return undefined;
      return { tab, origin: browserOrigin(tab.guest.getURL()), opener: tab.opener };
    },
  };

  const pageScope = (raw: unknown, ctx?: ToolPolicyContext): ApprovalMemoryScope | undefined => {
    const resolved = policy.resolveTab(asInput(raw), ctx?.sessionId);
    return resolved?.origin ? { kind: "browser-origin", origin: resolved.origin, tabOpener: resolved.opener } : undefined;
  };
  const onAgentTab = (raw: unknown, ctx?: ToolPolicyContext): boolean =>
    policy.resolveTab(asInput(raw), ctx?.sessionId)?.opener === "agent";
  /** Acting on anything but a tab the agent opened asks every time. */
  const notAgentTab = (raw: unknown, ctx?: ToolPolicyContext): boolean => !onAgentTab(raw, ctx);
  const readOnAgentTab = (raw: unknown, ctx?: ToolPolicyContext): ToolCategory =>
    onAgentTab(raw, ctx) ? "read" : "network";
  /** The origin of the URL a call opens, in a tab of `opener`. */
  const urlScope = (raw: unknown, opener: BrowserTabOpener | undefined): ApprovalMemoryScope | undefined => {
    const input = asInput(raw);
    const origin = typeof input.url === "string" ? browserOrigin(input.url) : null;
    return origin && opener ? { kind: "browser-origin", origin, tabOpener: opener } : undefined;
  };

  // The execute bodies load on the first browser call, outside the initial bundle.
  let executors: Promise<BrowserToolExecutors> | undefined;
  const execute = (name: BrowserToolName) => async (raw: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
    executors ??= import("./browser-tools-execute.js").then((module) => module.createBrowserToolExecutors(deps, policy));
    return (await executors)[name](asInput(raw), ctx);
  };

  const tabIdProperty = { type: "string", description: t("be_browserTools.tabIdDescription") };
  const refProperty = { ref: { type: "string", description: t("be_browserTools.refDescription") } };
  const common = { source: "builtin" as const, arbitraryEgress: true } as const;
  const pageAction = {
    category: "write" as const,
    requiresPerActionApproval: notAgentTab,
    approvalMemoryScope: pageScope,
  };
  const object = (properties: Record<string, unknown>, required?: string[]) => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  });

  return [
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.tabs,
      description: t("be_browserTools.tabsDescription"),
      category: "read",
      isReadOnly: () => true,
      jsonSchema: object({ select: { type: "string", description: t("be_browserTools.tabsSelectDescription") } }),
      execute: execute(BROWSER_TOOL.tabs),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.snapshot,
      description: t("be_browserTools.snapshotDescription"),
      category: "network",
      categoryForInput: readOnAgentTab,
      isReadOnly: (raw) => readOnAgentTab(raw) === "read",
      approvalMemoryScope: pageScope,
      jsonSchema: object({
        tabId: tabIdProperty,
        interactive: { type: "boolean", description: t("be_browserTools.snapshotInteractiveDescription") },
        delta: { type: "boolean", description: t("be_browserTools.snapshotDeltaDescription") },
      }),
      execute: execute(BROWSER_TOOL.snapshot),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.screenshot,
      description: t("be_browserTools.screenshotDescription"),
      category: "network",
      categoryForInput: readOnAgentTab,
      isReadOnly: (raw) => readOnAgentTab(raw) === "read",
      approvalMemoryScope: pageScope,
      jsonSchema: object({ tabId: tabIdProperty }),
      execute: execute(BROWSER_TOOL.screenshot),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.wait,
      description: t("be_browserTools.waitDescription"),
      category: "read",
      isReadOnly: () => true,
      resolveHostCeilingMs: () => MAX_WAIT_MS + 15_000,
      jsonSchema: object({
        tabId: tabIdProperty,
        text: { type: "string", description: t("be_browserTools.waitTextDescription") },
        timeMs: { type: "integer", minimum: 1, maximum: MAX_WAIT_MS, description: t("be_browserTools.waitTimeDescription") },
      }),
      execute: execute(BROWSER_TOOL.wait),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.navigate,
      description: t("be_browserTools.navigateDescription"),
      category: "network",
      requiresPerActionApproval: notAgentTab,
      approvalMemoryScope: (raw, ctx) => urlScope(raw, policy.resolveTab(asInput(raw), ctx?.sessionId)?.opener),
      jsonSchema: object({ tabId: tabIdProperty, url: { type: "string", description: t("be_browserTools.urlDescription") } }, ["url"]),
      execute: execute(BROWSER_TOOL.navigate),
    }),
    createDynamicTool({
      ...common,
      ...pageAction,
      name: BROWSER_TOOL.click,
      description: t("be_browserTools.clickDescription"),
      jsonSchema: object({ tabId: tabIdProperty, ...refProperty }, ["ref"]),
      execute: execute(BROWSER_TOOL.click),
    }),
    createDynamicTool({
      ...common,
      ...pageAction,
      name: BROWSER_TOOL.type,
      description: t("be_browserTools.typeDescription"),
      jsonSchema: object({
        tabId: tabIdProperty,
        ...refProperty,
        text: { type: "string", description: t("be_browserTools.typeTextDescription") },
        submit: { type: "boolean", description: t("be_browserTools.typeSubmitDescription") },
      }, ["ref", "text"]),
      execute: execute(BROWSER_TOOL.type),
    }),
    createDynamicTool({
      ...common,
      ...pageAction,
      name: BROWSER_TOOL.pressKey,
      description: t("be_browserTools.pressKeyDescription"),
      jsonSchema: object({
        tabId: tabIdProperty,
        key: {
          type: "string",
          enum: [...BROWSER_PRESSABLE_KEYS],
          description: t("be_browserTools.keyDescription", { keys: BROWSER_PRESSABLE_KEYS.join(", ") }),
        },
      }, ["key"]),
      execute: execute(BROWSER_TOOL.pressKey),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.tabNew,
      description: t("be_browserTools.tabNewDescription"),
      category: "network",
      approvalMemoryScope: (raw) => urlScope(raw, "agent"),
      jsonSchema: object({ url: { type: "string", description: t("be_browserTools.urlDescription") } }, ["url"]),
      execute: execute(BROWSER_TOOL.tabNew),
    }),
    createDynamicTool({
      ...common,
      name: BROWSER_TOOL.tabClose,
      description: t("be_browserTools.tabCloseDescription"),
      category: "write",
      requiresPerActionApproval: notAgentTab,
      approvalMemoryScope: (raw, ctx) => onAgentTab(raw, ctx) ? { kind: "browser-agent-tabs" } : undefined,
      jsonSchema: object({ tabId: tabIdProperty }, ["tabId"]),
      execute: execute(BROWSER_TOOL.tabClose),
    }),
  ];
}
