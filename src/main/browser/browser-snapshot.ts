/**
 * Accessibility snapshot of a browser tab, with element refs the action tools
 * address — the Playwright-MCP / Claude-in-Chrome shape.
 *
 * Pure: it turns the nodes of CDP `Accessibility.getFullAXTree` into text and
 * keeps each tab's ref table. No CDP calls here (browser-actions.ts does them),
 * so the ref rules are testable on plain data.
 *
 * REFS. An element gets a ref (`e<n>`, unique across tabs) the first time a
 * snapshot shows it, and keeps it for as long as the same DOM node is there,
 * so a re-snapshot does not renumber what the model already knows. A ref is
 * bound to the tab and the page (URL without fragment) it was minted on, and
 * remembers the element's role and accessible name: that fingerprint is how
 * an action re-finds the element when the page re-rendered it (same role and
 * name, new node), and how it notices the node now being something else.
 */

interface AXValue {
  readonly type?: string;
  readonly value?: unknown;
}

interface AXProperty {
  readonly name: string;
  readonly value: AXValue;
}

/** The fields of a CDP `Accessibility.AXNode` this module reads. */
export interface AXNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly description?: AXValue;
  readonly properties?: readonly AXProperty[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

/** Roles a person acts on: they get refs, and they are what `interactive` keeps. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);

/** Wrapper roles that add nothing to the outline when they carry no name. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "LineBreak",
]);

/** Properties worth showing next to a role. */
const SHOWN_PROPERTIES: ReadonlySet<string> = new Set([
  "level",
  "checked",
  "pressed",
  "expanded",
  "selected",
  "disabled",
  "required",
  "readonly",
  "invalid",
]);

/** Snapshot character ceiling (Claude in Chrome's `read_page` bound). */
export const SNAPSHOT_MAX_CHARS = 50_000;

export interface RefTarget {
  readonly ref: string;
  readonly tabId: string;
  /** The page (URL without fragment) the ref was minted on. */
  readonly pageUrl: string;
  backendNodeId: number;
  readonly role: string;
  readonly name: string;
}

interface TabRefState {
  pageUrl: string;
  readonly byNode: Map<number, string>;
  /** The last snapshot's lines per mode, for `delta`. */
  readonly lastLines: Map<"full" | "interactive", readonly string[]>;
}

export function pageKey(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

function text(value: AXValue | undefined): string {
  const raw = value?.value;
  if (typeof raw === "string") return raw.replace(/\s+/g, " ").trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function quote(value: string): string {
  return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
}

/**
 * The refs of every tab: minted here, resolved by the action tools. One
 * instance per process (see {@link browserRefs}); tests make their own.
 */
export class BrowserRefTable {
  private nextRef = 1;
  private readonly refs = new Map<string, RefTarget>();
  private readonly tabs = new Map<string, TabRefState>();

  private tabState(tabId: string, pageUrl: string): TabRefState {
    let state = this.tabs.get(tabId);
    if (!state || state.pageUrl !== pageUrl) {
      // A new page: its elements are new elements. Old refs stay resolvable
      // only to be reported stale (their pageUrl no longer matches).
      state = { pageUrl, byNode: new Map(), lastLines: new Map() };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  private refFor(state: TabRefState, tabId: string, node: AXNode, role: string, name: string): string | undefined {
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined) return undefined;
    const existing = state.byNode.get(backendNodeId);
    if (existing) {
      const target = this.refs.get(existing);
      if (target && target.role === role && target.name === name) return existing;
    }
    const ref = `e${this.nextRef++}`;
    state.byNode.set(backendNodeId, ref);
    this.refs.set(ref, { ref, tabId, pageUrl: state.pageUrl, backendNodeId, role, name });
    return ref;
  }

  /**
   * Render a snapshot of `nodes` (one tab, one page). `interactive` keeps only
   * the elements a person acts on, as a flat list. `delta` returns only the
   * lines added or removed since this tab's previous snapshot in the same mode.
   */
  render(
    tabId: string,
    pageUrl: string,
    nodes: readonly AXNode[],
    options: { interactive?: boolean; delta?: boolean; maxChars?: number } = {},
  ): { text: string; truncated: boolean; refCount: number; delta: boolean } {
    const state = this.tabState(tabId, pageKey(pageUrl));
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes.find((node) => node.parentId === undefined || !byId.has(node.parentId));
    const lines: string[] = [];
    const seenRefs = new Set<string>();
    const interactive = options.interactive === true;
    const visit = (node: AXNode, depth: number, visited: Set<string>): void => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      const role = text(node.role);
      const name = text(node.name);
      // InlineTextBox only repeats its StaticText parent's text, line by line.
      const shown = !node.ignored && role !== "" && role !== "InlineTextBox" && !(TRANSPARENT_ROLES.has(role) && name === "")
        && !(role === "StaticText" && name === "");
      let childDepth = depth;
      if (shown) {
        const acts = INTERACTIVE_ROLES.has(role);
        if (!interactive || acts) {
          const ref = acts ? this.refFor(state, tabId, node, role, name) : undefined;
          if (ref) seenRefs.add(ref);
          lines.push(formatLine(interactive ? 0 : depth, role, name, node, ref));
          childDepth = interactive ? depth : depth + 1;
        }
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, childDepth, visited);
      }
    };
    if (root) visit(root, 0, new Set());

    const mode = interactive ? "interactive" : "full";
    const previous = state.lastLines.get(mode);
    state.lastLines.set(mode, lines);
    let body = lines;
    let isDelta = false;
    if (options.delta === true && previous !== undefined) {
      isDelta = true;
      const before = new Set(previous);
      const after = new Set(lines);
      body = [
        ...previous.filter((line) => !after.has(line)).map((line) => `- ${line.trimStart()}`),
        ...lines.filter((line) => !before.has(line)).map((line) => `+ ${line.trimStart()}`),
      ];
      if (body.length === 0) body = ["(no changes since the previous snapshot)"];
    }
    const capped = capLines(body, options.maxChars ?? SNAPSHOT_MAX_CHARS);
    return { text: capped.text, truncated: capped.truncated, refCount: seenRefs.size, delta: isDelta };
  }

  get(ref: string): RefTarget | undefined {
    return this.refs.get(ref);
  }

  /** The page re-rendered the ref's element as a new node: point the ref at it. */
  rebind(ref: string, backendNodeId: number): void {
    const target = this.refs.get(ref);
    if (!target) return;
    const state = this.tabs.get(target.tabId);
    if (state && state.pageUrl === target.pageUrl) {
      state.byNode.delete(target.backendNodeId);
      state.byNode.set(backendNodeId, ref);
    }
    target.backendNodeId = backendNodeId;
  }

  /** Forget a closed tab's refs. */
  dropTab(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [ref, target] of this.refs) if (target.tabId === tabId) this.refs.delete(ref);
  }
}

function formatLine(depth: number, role: string, name: string, node: AXNode, ref: string | undefined): string {
  const parts = [`${"  ".repeat(depth)}- ${role}`];
  if (name) parts.push(quote(name));
  for (const property of node.properties ?? []) {
    if (!SHOWN_PROPERTIES.has(property.name)) continue;
    const value = property.value?.value;
    if (value === false || value === undefined || value === null || value === "false") continue;
    parts.push(value === true || value === "true" ? `[${property.name}]` : `[${property.name}=${String(value)}]`);
  }
  if (ref) parts.push(`[ref=${ref}]`);
  const value = text(node.value);
  return value && value !== name ? `${parts.join(" ")}: ${quote(value)}` : parts.join(" ");
}

/** Cut at a line boundary under `maxChars`, saying how much was left out. */
function capLines(lines: readonly string[], maxChars: number): { text: string; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (used + line.length + 1 > maxChars) {
      kept.push(`[truncated: ${lines.length - index} more lines over the ${maxChars}-character limit; use interactive:true or delta:true]`);
      return { text: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join("\n"), truncated: false };
}

/** Find the single node with this role and name (the re-render fingerprint), else undefined. */
export function findByFingerprint(nodes: readonly AXNode[], role: string, name: string): number | undefined {
  const matches = nodes.filter((node) =>
    !node.ignored && node.backendDOMNodeId !== undefined && text(node.role) === role && text(node.name) === name);
  return matches.length === 1 ? matches[0]!.backendDOMNodeId : undefined;
}

/** Role and name of one node, for checking a ref still points at what it named. */
export function roleAndName(node: AXNode | undefined): { role: string; name: string } | undefined {
  return node ? { role: text(node.role), name: text(node.name) } : undefined;
}

export const browserRefs = new BrowserRefTable();
