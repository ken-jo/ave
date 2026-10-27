/** Browser tools reach only the calling conversation's window; sub-agents inherit it, while routines and headless lanes receive no schemas.
 * Use session-only origin scopes and per-action approval for user tabs; main resolves origins and execution rechecks opener and origin after approval.
 * Refuse changed targets without acting, frame all page content as untrusted, and load main-owned actions on first use. */
import { createDynamicTool, type Tool, type ToolPolicyContext } from "./base.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { resolveSessionWindow, type SessionWindowScopeDeps } from "./session-window-scope.js";
import { BROWSER_TOOL, browserOrigin, type BrowserToolName } from "../shared/browser-tools.js";
export { browserOrigin } from "../shared/browser-tools.js";
import { validateExternalUrl } from "../shared/external-url.js";
import type { ApprovalMemoryScope, BrowserTabOpener } from "../shared/permissions-events.js";
import type { ToolCategory } from "../shared/permission-review-status.js";
import type {
  BrowserGuest,
  BrowserTabOpOutcome,
  BrowserTabRecord,
  BrowserTabView,
  DefaultBrowserTab,
} from "../main/browser/browser-tab-registry.js";
import type { BrowserToolExecutors } from "./browser-tools-execute.js";
import type { BrowserSessionActor, BrowserControlLease } from "../shared/browser-surface.js";
import type { BrowserObservationElement } from "../shared/agent-observation.js";
import type { BrowserUploadPickerRequest, BrowserUploadResult } from "../main/browser/browser-upload.js";
import { t } from "../i18n/index.js";

/** What the tools need of the main-side tab registry. */
interface BrowserTabsAccess<G extends BrowserGuest = BrowserGuest> {
  liveTab(handle: string): BrowserTabRecord<G> | undefined;
  liveTabInWindow(handle: string, windowId: number): BrowserTabRecord<G> | undefined;
  listTabs(windowId: number): BrowserTabView[];
  listSessionTabs(windowId: number, actor: BrowserSessionActor, includeDirectChildren: boolean): BrowserTabView[];
  assertActorAccess(tab: BrowserTabRecord<G>, actor: BrowserSessionActor): void;
  acquireControl(tab: BrowserTabRecord<G>, actor: BrowserSessionActor): BrowserControlLease;
  releaseControl(tabId: string, leaseId: string): void;
  /** The tab a conversation acts on when a call names none (its pane chat's tab, else the shown one). */
  defaultBrowserTab(windowId: number, sessionId: string): DefaultBrowserTab;
  requestTabOp(
    windowId: number,
    op: { op: "new"; url: string; sessionId?: string; actor: BrowserSessionActor; active?: boolean } | { op: "select" | "close"; tabId: string; actor: BrowserSessionActor },
    options?: { signal?: AbortSignal },
  ): Promise<BrowserTabOpOutcome>;
}

/** One live tab handed to a page action, with the signal that cancels it. */
export interface BrowserActionTab<G extends BrowserGuest = BrowserGuest> {
  readonly tab: BrowserTabRecord<G>;
  readonly signal: AbortSignal;
  readonly leaseId?: string;
  readonly callerSignal?: AbortSignal;
  readonly approval?: { readonly tabId: string; readonly origin: string; readonly documentId: number; readonly controlGeneration: number };
  readonly onObservationTarget?: (element: BrowserObservationElement, downloadUrl?: string) => void;
}

/** The page actions (main/browser/browser-actions.ts), loaded on first use. */
export interface BrowserPageActions<G extends BrowserGuest = BrowserGuest> {
  /** Establish document observation before approval captures its identity. */
  prepare(target: BrowserActionTab<G>): Promise<void>;
  snapshot(target: BrowserActionTab<G>, options: { interactive?: boolean; delta?: boolean }): Promise<{
    url: string;
    title: string;
    text: string;
    truncated: boolean;
    refCount: number;
    delta: boolean;
  }>;
  screenshot(target: BrowserActionTab<G>, options?: { fullPage?: boolean }): Promise<{ data: string; mimeType: string; bytes: number }>;
  waitFor(target: BrowserActionTab<G>, options: { text?: string; timeMs?: number }): Promise<{ found: boolean; waitedMs: number }>;
  click(target: BrowserActionTab<G>, ref: string): Promise<void>;
  hover(target: BrowserActionTab<G>, ref: string): Promise<void>;
  drag(target: BrowserActionTab<G>, sourceRef: string, targetRef: string): Promise<void>;
  select(target: BrowserActionTab<G>, ref: string, value: string): Promise<void>;
  scroll(target: BrowserActionTab<G>, ref: string, direction: "up" | "down" | "left" | "right", pixels: number): Promise<void>;
  upload(target: BrowserActionTab<G>, ref: string, options: {
    windowId: number; sessionId: string;
    pickFiles: (request: BrowserUploadPickerRequest) => Promise<readonly string[] | null>;
  }): Promise<BrowserUploadResult>;
  type(target: BrowserActionTab<G>, ref: string, text: string, options: { submit?: boolean }): Promise<void>;
  pressKey(target: BrowserActionTab<G>, key: string, ref?: string): Promise<void>;
  navigate(target: BrowserActionTab<G>, url: string, approvedOrigin: string): Promise<{ url: string }>;
  /** Wait (bounded) for a newly opened tab's first page to finish loading. */
  settle(target: BrowserActionTab<G>): Promise<{ url: string }>;
}

export interface BrowserToolDeps<G extends BrowserGuest = BrowserGuest> extends SessionWindowScopeDeps {
  readonly tabs: BrowserTabsAccess<G>;
  readonly pickUploadFiles: (request: BrowserUploadPickerRequest) => Promise<readonly string[] | null>;
  readonly loadActions: () => Promise<BrowserPageActions<G>>;
}

/** Keys `browser_press_key` accepts (mirrors browser-actions.ts PRESSABLE_KEYS). */
export const BROWSER_PRESSABLE_KEYS = [
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
] as const;

const MAX_WAIT_MS = 30_000;
const canonicalBrowserNavigationTools = new WeakSet<object>();

export function isCanonicalBrowserNavigationTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && canonicalBrowserNavigationTools.has(tool);
}

/** A tab handle from browser_tabs (minted by the main-side registry). */
export const BROWSER_TAB_ID_PATTERN = /^tab-\d+$/;

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
      const fallback = input.tabId === undefined ? deps.tabs.defaultBrowserTab(scope.windowId, scope.hostSessionId) : undefined;
      const handle = (input.tabId as string | undefined) ?? (fallback?.ok ? fallback.handle : undefined);
      if (handle === undefined) return undefined;
      const tab = deps.tabs.liveTabInWindow(handle, scope.windowId);
      if (!tab || !tab.guest || !sessionId) return undefined;
      try { deps.tabs.assertActorAccess(tab, { sessionId, directParentSessionId: deps.liveOriginSessionId(sessionId) }); }
      catch { return undefined; }
      return { tab, origin: browserOrigin(tab.guest.getURL()), opener: tab.opener };
    },
  };

  const observedTab = async (raw: unknown, ctx?: ToolPolicyContext): Promise<ResolvedBrowserTab<G> | undefined> => {
    const resolved = policy.resolveTab(asInput(raw), ctx?.sessionId);
    if (!resolved) return undefined;
    const guest = resolved.tab.guest;
    const actions = await deps.loadActions();
    await actions.prepare({ tab: resolved.tab, signal: new AbortController().signal });
    // Pin an omitted tab before awaiting; selecting another tab cannot retarget approval.
    const current = policy.resolveTab({ tabId: resolved.tab.handle }, ctx?.sessionId);
    if (!current || current.tab.guest !== guest || current.origin !== resolved.origin || current.opener !== resolved.opener) {
      throw new Error("Browser target changed while preparing approval");
    }
    return current;
  };
  const pageScope = async (raw: unknown, ctx?: ToolPolicyContext): Promise<ApprovalMemoryScope | undefined> => {
    const resolved = await observedTab(raw, ctx);
    return resolved?.origin ? {
      kind: "browser-origin",
      origin: resolved.origin,
      tabOpener: resolved.opener,
      tabId: resolved.tab.handle,
      documentId: resolved.tab.documentId,
      controlGeneration: resolved.tab.controlGeneration,
    } : undefined;
  };
  const onAgentTab = (raw: unknown, ctx?: ToolPolicyContext): boolean => {
    const scope = ctx?.approvalMemoryScope;
    if (scope?.kind === "browser-origin") return scope.tabOpener === "agent";
    if (scope?.kind === "browser-agent-tabs") return true;
    return policy.resolveTab(asInput(raw), ctx?.sessionId)?.opener === "agent";
  };
  /** Acting on anything but a tab the agent opened asks every time. */
  const notAgentTab = (raw: unknown, ctx?: ToolPolicyContext): boolean => !onAgentTab(raw, ctx);
  const readOnAgentTab = (raw: unknown, ctx?: ToolPolicyContext): ToolCategory =>
    onAgentTab(raw, ctx) ? "read" : "network";
  /** A URL the tools will refuse (not http/https) opens nothing, so asking the user about it would only ask them to approve a refusal: it runs as a read and execute refuses it. */
  const urlCategory = (raw: unknown): ToolCategory => {
    const input = asInput(raw);
    if (typeof input.url !== "string") return "read";
    const checked = validateExternalUrl(input.url);
    return checked.ok && browserOrigin(checked.url) !== null ? "network" : "read";
  };
  /** The origin of the URL a call opens, in a tab of `opener`. */
  const urlScope = (
    raw: unknown,
    opener: BrowserTabOpener | undefined,
    tab?: BrowserTabRecord<G>,
  ): ApprovalMemoryScope | undefined => {
    const input = asInput(raw);
    const origin = typeof input.url === "string" ? browserOrigin(input.url) : null;
    return origin && opener ? {
      kind: "browser-origin",
      origin,
      tabOpener: opener,
      ...(tab ? { tabId: tab.handle, documentId: tab.documentId, controlGeneration: tab.controlGeneration } : {}),
    } : undefined;
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
      jsonSchema: object({ select: { type: "string", description: t("be_browserTools.tabsSelectDescription") }, scope: { type: "string", enum: ["window", "conversation"] }, includeDirectChildren: { type: "boolean" } }),
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
      jsonSchema: object({ tabId: tabIdProperty, fullPage: { type: "boolean", enum: [false], description: t("be_browserTools.fullPageDescription") } }),
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
      categoryForInput: urlCategory,
      requiresPerActionApproval: notAgentTab,
      approvalMemoryScope: async (raw, ctx) => {
        const resolved = await observedTab(raw, ctx);
        return urlScope(raw, resolved?.opener, resolved?.tab);
      },
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
    ...([
      [BROWSER_TOOL.hover, "be_browserTools.hoverDescription", { ...refProperty }, ["ref"]],
      [BROWSER_TOOL.drag, "be_browserTools.dragDescription", { sourceRef: refProperty.ref, targetRef: refProperty.ref }, ["sourceRef", "targetRef"]],
      [BROWSER_TOOL.select, "be_browserTools.selectDescription", { ...refProperty, value: { type: "string", maxLength: 1000 } }, ["ref", "value"]],
      [BROWSER_TOOL.scroll, "be_browserTools.scrollDescription", { ...refProperty, direction: { type: "string", enum: ["up", "down", "left", "right"] }, pixels: { type: "integer", minimum: 1, maximum: 2000 } }, ["ref", "direction", "pixels"]],
      [BROWSER_TOOL.upload, "be_browserTools.uploadDescription", { ...refProperty }, ["ref"]],
    ] as const).map(([name, description, properties, required]) => createDynamicTool({
      ...common,
      ...pageAction,
      name,
      description: t(description),
      ...(name === BROWSER_TOOL.upload ? { requiresPerActionApproval: () => true } : {}),
      jsonSchema: object({ tabId: tabIdProperty, ...properties }, [...required]),
      execute: execute(name),
    })),
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
        ref: { type: "string", description: t("be_browserTools.pressKeyRefDescription") },
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
      categoryForInput: urlCategory,
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
      approvalMemoryScope: (raw, ctx) => {
        const resolved = policy.resolveTab(asInput(raw), ctx?.sessionId);
        if (!resolved) return undefined;
        const identity = { tabId: resolved.tab.handle, documentId: resolved.tab.documentId, controlGeneration: resolved.tab.controlGeneration };
        return resolved.opener === "agent"
          ? { kind: "browser-agent-tabs", ...identity }
          : resolved.origin === null ? undefined
            : { kind: "browser-origin", origin: resolved.origin, tabOpener: resolved.opener, ...identity };
      },
      jsonSchema: object({ tabId: tabIdProperty }, ["tabId"]),
      execute: execute(BROWSER_TOOL.tabClose),
    }),
  ].map((tool) => {
    if (tool.name === BROWSER_TOOL.navigate || tool.name === BROWSER_TOOL.tabNew) canonicalBrowserNavigationTools.add(tool);
    return tool;
  });
}
