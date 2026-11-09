// Refs persist for the same DOM node and bind to a tab, fragment-free URL, role, and accessible name. The fingerprint allows re-render recovery while
// detecting stale or repurposed nodes.

import { BROWSER_PAGE_STRING_MAX_CHARS } from "../../shared/browser-tools.js";

interface AXValue {
  readonly type?: string;
  readonly value?: unknown;
}

interface AXProperty {
  readonly name: string;
  readonly value: AXValue;
}

// The fields of a CDP `Accessibility.AXNode` this module reads.
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

// Roles a person acts on: they get refs, and they are what `interactive` keeps.
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

// Wrapper roles that add nothing to the outline when they carry no name.
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "LineBreak",
]);

// Properties worth showing next to a role.
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

// Leave room for the untrusted-content fence and bounded page header under the inline result limit.
export const SNAPSHOT_MAX_CHARS = 3_000;
const SNAPSHOT_LINE_MAX_CHARS = SNAPSHOT_MAX_CHARS;
const SELECT_OPTIONS_MAX_CHARS = 600;

export interface RefTarget {
  readonly ref: string;
  readonly tabId: string;
  // The page (URL without fragment) the ref was minted on.
  readonly pageUrl: string;
  readonly loaderId?: string;
  readonly documentId?: number;
  backendNodeId: number;
  readonly role: string;
  readonly name: string;
}

export interface BrowserSelectOption { readonly value: string; readonly label: string; readonly disabled: boolean }

interface SnapshotLine {
  readonly text: string;
  readonly priority: number;
  readonly ref?: string;
}

interface TabRefState {
  pageUrl: string;
  loaderId?: string;
  documentId?: number;
  readonly byNode: Map<number, string>;
  // The last snapshot's lines per mode, for `delta`.
  readonly lastLines: Map<"full" | "interactive", readonly SnapshotLine[]>;
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

function pageText(value: string): string {
  return value.length > BROWSER_PAGE_STRING_MAX_CHARS ? `${value.slice(0, BROWSER_PAGE_STRING_MAX_CHARS - 1)}…` : value;
}

function quote(value: string): string {
  return JSON.stringify(pageText(value));
}

// The refs of every tab: minted here, resolved by the action tools. One instance per process (see {@link browserRefs}); tests make their own.
export class BrowserRefTable {
  private nextRef = 1;
  private readonly refs = new Map<string, RefTarget>();
  private readonly tabs = new Map<string, TabRefState>();

  private tabState(tabId: string, pageUrl: string, loaderId?: string, documentId?: number): TabRefState {
    let state = this.tabs.get(tabId);
    if (!state || state.pageUrl !== pageUrl || state.loaderId !== loaderId || state.documentId !== documentId) {
      // A new page: its elements are new elements. Old refs stay resolvable only to be reported stale (their pageUrl no longer matches).
      state = { pageUrl, loaderId, documentId, byNode: new Map(), lastLines: new Map() };
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
    this.refs.set(ref, { ref, tabId, pageUrl: state.pageUrl, loaderId: state.loaderId, documentId: state.documentId, backendNodeId, role, name });
    return ref;
  }

  // Render a snapshot of `nodes` (one tab, one page). `interactive` keeps only the elements a person acts on, as a flat list. `delta` returns only the
  // lines added or removed in the first bounded view since its previous snapshot in the same mode, or the full bounded view if the delta would overflow.
  // Continuation offsets address the current DOM, not a cached document.
  render(
    tabId: string,
    pageUrl: string,
    nodes: readonly AXNode[],
    options: { interactive?: boolean; delta?: boolean; offset?: number; maxChars?: number; iframeOrigins?: readonly string[]; loaderId?: string; documentId?: number; nativeSelectOptions?: ReadonlyMap<number, readonly BrowserSelectOption[]> } = {},
  ): { text: string; truncated: boolean; refCount: number; delta: boolean; offset: number; nextOffset?: number; totalLines: number } {
    const state = this.tabState(tabId, pageKey(pageUrl), options.loaderId, options.documentId);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodes.find((node) => node.parentId === undefined || !byId.has(node.parentId));
    const lines: SnapshotLine[] = [];
    const maxChars = Math.max(0, Math.floor(options.maxChars ?? SNAPSHOT_MAX_CHARS));
    const lineBudget = Math.max(0, Math.min(SNAPSHOT_LINE_MAX_CHARS, maxChars - 2));
    const interactive = options.interactive === true;
    const visit = (node: AXNode, depth: number, visited: Set<string>): void => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      const role = text(node.role);
      if (role.toLowerCase() === "iframe" || (role === "RootWebArea" && node !== root)) return;
      const name = text(node.name);
      // InlineTextBox only repeats its StaticText parent's text, line by line.
      const shown = !node.ignored && role !== "" && role !== "InlineTextBox" && !(TRANSPARENT_ROLES.has(role) && name === "")
        && !(role === "StaticText" && name === "");
      let childDepth = depth;
      if (shown) {
        const acts = INTERACTIVE_ROLES.has(role);
        if (!interactive || acts) {
          const ref = acts ? this.refFor(state, tabId, node, role, name) : undefined;
          const formatted = formatLine(interactive ? 0 : depth, role, name, node, ref);
          const baseLine = fitLine(formatted, role, ref, lineBudget);
          const nativeOptions = node.backendDOMNodeId === undefined ? undefined : options.nativeSelectOptions?.get(node.backendDOMNodeId);
          const selection = nativeOptions ? formatOptions(nativeOptions, Math.min(SELECT_OPTIONS_MAX_CHARS, Math.max(0, lineBudget - baseLine.length - 1))) : undefined;
          const line = selection?.text ? `${baseLine} ${selection.text}` : baseLine;
          lines.push({ text: line, priority: role === "heading" ? 0 : acts ? 1 : 2, ...(ref && line.includes(`[ref=${ref}]`) ? { ref } : {}) });
          if (nativeOptions && selection && ref) {
            for (const option of nativeOptions.slice(selection.keptCount)) {
              const detail = formatOptionLine(option, ref, lineBudget);
              lines.push({ text: detail, priority: 2, ...(detail.includes(`[parent-ref=${ref}]`) ? { ref } : {}) });
            }
          }
          childDepth = interactive ? depth : depth + 1;
        }
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, childDepth, visited);
      }
    };
    if (root) visit(root, 0, new Set());
    for (const origin of options.iframeOrigins ?? []) lines.push({ text: fitLine(`- iframe ${quote(origin)} [contents omitted; no refs]`, "iframe", undefined, lineBudget), priority: 2 });

    const ordered = prioritizeLines(lines, maxChars);
    const offset = Math.min(options.offset ?? 0, ordered.length);
    const page = capLines(ordered, maxChars, offset);
    const mode = interactive ? "interactive" : "full";
    const previous = state.lastLines.get(mode);
    // Paging does not replace the delta baseline, and only the bounded first view is retained.
    if (offset === 0) state.lastLines.set(mode, page.lines);
    let body = page.lines;
    let isDelta = false;
    const truncated = page.nextOffset !== undefined;
    if (options.delta === true && previous !== undefined) {
      isDelta = true;
      const before = new Set(previous.map((line) => line.text));
      const after = new Set(page.lines.map((line) => line.text));
      body = [
        ...previous.filter((line) => !after.has(line.text)).map((line) => ({ ...line, text: `- ${line.text.trimStart()}` })),
        ...page.lines.filter((line) => !before.has(line.text)).map((line) => ({ ...line, text: `+ ${line.text.trimStart()}` })),
      ];
      if (body.length === 0) body = [{ text: "(no changes since the previous snapshot)", priority: 2 }];
      const deltaPage = capLines(body, maxChars, 0);
      if (deltaPage.nextOffset !== undefined) {
        // A partial delta cannot advance its baseline safely. Return the current bounded view instead.
        body = page.lines;
        isDelta = false;
      } else {
        body = deltaPage.lines;
      }
    }
    const returnedRefs = new Set(body.flatMap((line) => line.ref ? [line.ref] : []));
    return {
      text: body.map((line) => line.text).join("\n"), truncated, refCount: returnedRefs.size, delta: isDelta,
      offset, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }), totalLines: ordered.length,
    };
  }

  get(ref: string): RefTarget | undefined {
    return this.refs.get(ref);
  }

  // The page re-rendered the ref's element as a new node: point the ref at it.
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

  // Forget a closed tab's refs.
  dropTab(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [ref, target] of this.refs) if (target.tabId === tabId) this.refs.delete(ref);
  }
}

function formatLine(depth: number, role: string, name: string, node: AXNode, ref: string | undefined): string {
  const parts = [`${"  ".repeat(Math.min(depth, 12))}- ${role.slice(0, BROWSER_PAGE_STRING_MAX_CHARS)}`];
  if (name) parts.push(quote(name));
  const shown = new Set<string>();
  for (const property of node.properties ?? []) {
    if (!SHOWN_PROPERTIES.has(property.name) || shown.has(property.name)) continue;
    shown.add(property.name);
    const value = property.value?.value;
    if (value === false || value === undefined || value === null || value === "false") continue;
    parts.push(value === true || value === "true" ? `[${property.name}]` : `[${property.name}=${String(value).replace(/\s+/g, " ").slice(0, BROWSER_PAGE_STRING_MAX_CHARS)}]`);
  }
  if (ref) parts.push(`[ref=${ref}]`);
  const value = text(node.value);
  return value && value !== name ? `${parts.join(" ")}: ${quote(value)}` : parts.join(" ");
}

function encodedOption(option: BrowserSelectOption, budget: number): string | undefined {
  // Machine values are passed back to selection unchanged; a shortened value would name a different option.
  if (option.value.length > budget) return undefined;
  const encoded = JSON.stringify({ value: option.value, label: pageText(option.label), disabled: option.disabled }).replace(/</g, "\\u003c");
  return encoded.length <= budget ? encoded : undefined;
}

function formatOptions(options: readonly BrowserSelectOption[], budget: number): { text: string; keptCount: number } {
  const kept: string[] = [];
  let used = "options=[]".length;
  for (const option of options) {
    const encoded = encodedOption(option, budget);
    const remaining = options.length - kept.length - 1;
    const suffix = remaining > 0 ? ` [${remaining} more options]` : "";
    if (!encoded || used + encoded.length + (kept.length > 0 ? 1 : 0) + suffix.length > budget) break;
    kept.push(encoded);
    used += encoded.length + (kept.length > 1 ? 1 : 0);
  }
  const suffix = kept.length < options.length ? ` [${options.length - kept.length} more options]` : "";
  const text = `options=[${kept.join(",")}]${suffix}`;
  return { text: text.length <= budget ? text : "", keptCount: kept.length };
}

function formatOptionLine(option: BrowserSelectOption, ref: string, budget: number): string {
  const prefix = `- option [parent-ref=${ref}] `;
  const encoded = encodedOption(option, Math.max(0, budget - prefix.length));
  if (encoded !== undefined) return `${prefix}${encoded}`;
  const omitted = `${prefix}[value omitted: exceeds line budget]`;
  if (omitted.length <= budget) return omitted;
  const minimal = `[parent-ref=${ref}] [value omitted]`;
  if (minimal.length <= budget) return minimal;
  const marker = `[parent-ref=${ref}]`;
  return marker.length <= budget ? marker : "";
}

// Pathological fields or indentation cannot block the next offset; keep any actionable ref whole.
function fitLine(line: string, role: string, ref: string | undefined, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const compact = `- ${role.slice(0, 30)}${ref ? ` [ref=${ref}]` : ""} [details omitted]`;
  if (compact.length <= maxChars) return compact;
  const minimal = ref ? `[ref=${ref}]` : "…";
  return minimal.length <= maxChars ? minimal : "";
}

// Keep small outlines in document order. Large outlines start with headings, reserving room for an actionable ref before the remaining headings.
function prioritizeLines(lines: readonly SnapshotLine[], maxChars: number): readonly SnapshotLine[] {
  if (lines.reduce((size, line) => size + line.text.length + 1, -1) <= maxChars) return lines;
  const ordered = [...lines].sort((left, right) => left.priority - right.priority);
  const actionIndex = ordered.findIndex((line) => line.ref !== undefined);
  if (actionIndex < 1) return ordered;
  const action = ordered[actionIndex];
  if (!action || action.text.length > maxChars) return ordered;
  let used = action.text.length;
  let prefixLength = 0;
  for (const line of ordered) {
    if (prefixLength === actionIndex || used + line.text.length + 1 > maxChars) break;
    used += line.text.length + 1;
    prefixLength++;
  }
  if (prefixLength === actionIndex) return ordered;
  return [...ordered.slice(0, prefixLength), action, ...ordered.slice(prefixLength, actionIndex), ...ordered.slice(actionIndex + 1)];
}

// Whole-line pages have no marker line: continuation lives in the result metadata.
function capLines(lines: readonly SnapshotLine[], maxChars: number, offset: number): { lines: SnapshotLine[]; nextOffset?: number } {
  const kept: SnapshotLine[] = [];
  let used = 0;
  for (let index = offset; index < lines.length; index++) {
    const line = lines[index]!;
    const needed = line.text.length + (kept.length === 0 ? 0 : 1);
    if (used + needed > maxChars) return { lines: kept, nextOffset: index };
    kept.push(line);
    used += needed;
  }
  return { lines: kept };
}

// Find the single node with this role and name (the re-render fingerprint), else undefined.
export function findByFingerprint(nodes: readonly AXNode[], role: string, name: string): number | undefined {
  const matches = nodes.filter((node) =>
    !node.ignored && node.backendDOMNodeId !== undefined && text(node.role) === role && text(node.name) === name);
  return matches.length === 1 ? matches[0]!.backendDOMNodeId : undefined;
}

// Role and name of one node, for checking a ref still points at what it named.
export function roleAndName(node: AXNode | undefined): { role: string; name: string } | undefined {
  return node ? { role: text(node.role), name: text(node.name) } : undefined;
}

export const browserRefs = new BrowserRefTable();
