/**
 * Readable Markdown from fetched HTML, for `web_fetch`.
 *
 * Reference behavior: opencode's webfetch converts HTML to Markdown by default
 * (headings, links, lists, code and tables survive), Claude Code's WebFetch
 * also hands the model Markdown. The main-process bundle is under a growth
 * ratchet and no HTML parser ships in the runtime dependencies, so this is a
 * small tolerant tokenizer + tree builder rather than a DOM library. It never
 * executes anything and only ever produces text.
 *
 * Bounded by its input: `web_fetch` caps the body at 2 MiB before calling it.
 */

interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
}
interface TextNode {
  readonly kind: "text";
  readonly text: string;
}
type HtmlNode = ElementNode | TextNode;

export interface HtmlMarkdown {
  readonly title?: string;
  readonly markdown: string;
}

/** Elements whose content is never page text. */
const OMITTED = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "embed",
  "head", "meta", "link", "button", "select", "option", "input", "textarea", "dialog", "nav",
]);
/** Content is raw text up to the matching close tag (not parsed as markup). */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "xmp"]);
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const BLOCK = new Set([
  "address", "article", "aside", "body", "center", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "header", "hgroup", "html", "main", "p", "section", "summary",
]);
/** Opening one of these implicitly closes an open <p>. */
const CLOSES_P = new Set([
  ...BLOCK, "nav", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "ol", "ul", "pre", "table", "li", "dd", "dt",
]);

const HEAD_CONTENT = new Set(["title", "meta", "link", "style", "script", "base", "noscript", "template"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  middot: "·", bull: "•", times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", le: "≤", ge: "≥", ne: "≠",
  plusmn: "±", shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// ─── Parsing ────────────────────────────────────────────────────────

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (attrs.has(name)) continue;
    attrs.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attrs;
}

function parseHtml(html: string): ElementNode {
  const root: ElementNode = { kind: "element", name: "#root", attrs: new Map(), children: [] };
  const stack: ElementNode[] = [root];
  const current = (): ElementNode => stack[stack.length - 1];
  const hasOpen = (name: string, boundary: ReadonlySet<string>): number => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (stack[index].name === name) return index;
      if (boundary.has(stack[index].name)) return -1;
    }
    return -1;
  };
  const popTo = (index: number): void => {
    if (index > 0) stack.length = index;
  };
  const LIST_BOUNDARY = new Set(["ul", "ol", "table"]);
  const ROW_BOUNDARY = new Set(["table"]);
  const CELL_BOUNDARY = new Set(["tr", "table"]);
  const P_BOUNDARY = new Set(["table", "li", "blockquote", "td", "th"]);
  const NO_BOUNDARY = new Set<string>();

  const lower = html.toLowerCase();
  let index = 0;
  const pushText = (text: string): void => {
    if (text.length > 0) current().children.push({ kind: "text", text: decodeHtmlEntities(text) });
  };

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      pushText(html.slice(index));
      break;
    }
    pushText(html.slice(index, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt, lt + 16_384));
    if (!tag) {
      pushText("<");
      index = lt + 1;
      continue;
    }
    index = lt + tag[0].length;
    const closing = tag[1] === "/";
    const name = tag[2].toLowerCase();

    if (closing) {
      for (let open = stack.length - 1; open > 0; open -= 1) {
        if (stack[open].name === name) {
          popTo(open);
          break;
        }
      }
      continue;
    }

    // Flow content ends an unclosed <head> (the end tag is optional).
    if (!HEAD_CONTENT.has(name)) popTo(hasOpen("head", NO_BOUNDARY));
    if (CLOSES_P.has(name)) popTo(hasOpen("p", P_BOUNDARY));
    if (name === "li") popTo(hasOpen("li", LIST_BOUNDARY));
    if (name === "dt" || name === "dd") {
      popTo(hasOpen("dt", new Set(["dl"])));
      popTo(hasOpen("dd", new Set(["dl"])));
    }
    if (name === "tr") popTo(hasOpen("tr", ROW_BOUNDARY));
    if (name === "td" || name === "th") {
      popTo(hasOpen("td", CELL_BOUNDARY));
      popTo(hasOpen("th", CELL_BOUNDARY));
    }

    const element: ElementNode = { kind: "element", name, attrs: parseAttributes(tag[3]), children: [] };
    current().children.push(element);
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, index);
      const end = close === -1 ? html.length : close;
      element.children.push({ kind: "text", text: name === "title" ? decodeHtmlEntities(html.slice(index, end)) : html.slice(index, end) });
      const closeEnd = close === -1 ? html.length : html.indexOf(">", close);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (VOID.has(name) || tag[3].trimEnd().endsWith("/")) continue;
    stack.push(element);
  }
  return root;
}

// ─── Rendering ──────────────────────────────────────────────────────

// Layout markers survive whitespace normalization and become text at the end.
const INDENT = "\u0001";
const QUOTE = "\u0002";
const CODE = "\u0003";

interface RenderContext {
  readonly baseUrl: URL | undefined;
  readonly codeBlocks: string[];
}

function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  if (OMITTED.has(node.name)) return "";
  if (node.name === "br") return "\n";
  return node.children.map(textContent).join("");
}

function resolveHref(raw: string | undefined, ctx: RenderContext): string | undefined {
  const value = raw?.trim();
  if (!value || value.startsWith("#")) return undefined;
  try {
    const url = ctx.baseUrl ? new URL(value, ctx.baseUrl) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function block(content: string): string {
  const trimmed = content.trim();
  return trimmed ? `\n\n${trimmed}\n\n` : "";
}

function inlineText(content: string): string {
  return content.replace(/\s*\n\s*/g, " ").trim();
}

function wrapInline(content: string, marker: string): string {
  const inner = content.trim();
  if (!inner) return content;
  const lead = /^\s/.test(content) ? " " : "";
  const trail = /\s$/.test(content) ? " " : "";
  return `${lead}${marker}${inner}${marker}${trail}`;
}

function codeSpan(text: string): string {
  const clean = text.replace(/\s+/g, " ");
  if (!clean.trim()) return clean;
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

function codeLanguage(element: ElementNode): string {
  const candidates = [element, ...element.children.filter((child): child is ElementNode => child.kind === "element")];
  for (const candidate of candidates) {
    const match = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(candidate.attrs.get("class") ?? "");
    if (match) return match[1];
  }
  return "";
}

function renderList(element: ElementNode, ctx: RenderContext): string {
  const ordered = element.name === "ol";
  let number = Number.parseInt(element.attrs.get("start") ?? "1", 10);
  if (!Number.isFinite(number)) number = 1;
  const items: string[] = [];
  for (const child of element.children) {
    if (child.kind !== "element") continue;
    const content = child.name === "li" ? renderChildren(child.children, ctx) : renderNode(child, ctx);
    const body = normalizeMarkdown(content);
    if (!body && child.name !== "li") continue;
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    const indent = INDENT.repeat(marker.length);
    const lines = body.split("\n");
    items.push([`${marker}${lines[0] ?? ""}`, ...lines.slice(1).map((line) => (line ? `${indent}${line}` : line))].join("\n"));
  }
  return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
}

function renderTable(element: ElementNode, ctx: RenderContext): string {
  const rows: string[][] = [];
  let caption = "";
  const visit = (node: ElementNode): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (child.name === "caption") caption = inlineText(renderChildren(child.children, ctx));
      else if (child.name === "tr") {
        rows.push(child.children
          .filter((cell): cell is ElementNode => cell.kind === "element" && (cell.name === "td" || cell.name === "th"))
          .map((cell) => inlineText(normalizeMarkdown(renderChildren(cell.children, ctx)).replace(/\n+/g, " ")).replace(/\|/g, "\\|")));
      } else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") visit(child);
    }
  };
  visit(element);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const pad = (row: string[]): string => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const lines = [pad(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(pad)];
  return block([caption, lines.join("\n")].filter(Boolean).join("\n\n"));
}

function renderNode(node: HtmlNode, ctx: RenderContext): string {
  if (node.kind === "text") return node.text.replace(/\s+/g, " ");
  const { name } = node;
  if (OMITTED.has(name) || name === "title") return "";
  const children = (): string => renderChildren(node.children, ctx);
  switch (name) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const text = inlineText(children());
      return text ? `\n\n${"#".repeat(Number(name[1]))} ${text}\n\n` : "";
    }
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "strong": case "b":
      return wrapInline(children(), "**");
    case "em": case "i":
      return wrapInline(children(), "_");
    case "s": case "del": case "strike":
      return wrapInline(children(), "~~");
    case "code": case "kbd": case "samp": case "tt":
      return codeSpan(textContent(node));
    case "pre": {
      const code = textContent(node).replace(/^\n/, "").replace(/\s+$/, "");
      if (!code) return "";
      const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
      const fence = "`".repeat(longest + 1);
      ctx.codeBlocks.push(`${fence}${codeLanguage(node)}\n${code}\n${fence}`);
      return `\n\n${CODE}${ctx.codeBlocks.length - 1}${CODE}\n\n`;
    }
    case "a": {
      const text = inlineText(children());
      const href = resolveHref(node.attrs.get("href"), ctx);
      if (!href) return text;
      if (!text) return "";
      const title = node.attrs.get("title")?.replace(/"/g, "'").trim();
      // Link text is already-rendered Markdown (it may hold an image), so it is not escaped.
      return `[${text}](${linkDestination(href)}${title ? ` "${title}"` : ""})`;
    }
    case "img": {
      const alt = inlineText(node.attrs.get("alt") ?? "");
      const src = resolveHref(node.attrs.get("src"), ctx);
      return src && alt ? `![${alt.replace(/([[\]])/g, "\\$1")}](${linkDestination(src)})` : alt;
    }
    case "ul": case "ol":
      return renderList(node, ctx);
    case "li":
      return block(`- ${normalizeMarkdown(children())}`);
    case "blockquote": {
      const body = normalizeMarkdown(children());
      if (!body) return "";
      return `\n\n${body.split("\n").map((line) => `${QUOTE}${line}`).join("\n")}\n\n`;
    }
    case "table":
      return renderTable(node, ctx);
    case "dt":
      return `\n\n**${inlineText(children())}**\n`;
    case "dd":
      return `\n${INDENT}${INDENT}${inlineText(children())}\n`;
    default:
      return BLOCK.has(name) ? block(children()) : children();
  }
}

function renderChildren(nodes: readonly HtmlNode[], ctx: RenderContext): string {
  let output = "";
  for (const node of nodes) output += renderNode(node, ctx);
  return output;
}

/**
 * Strip layout whitespace (leading spaces inside a line, trailing spaces,
 * runs of blank lines) while keeping the INDENT/QUOTE markers.
 */
function normalizeMarkdown(markdown: string): string {
  const lines = markdown.split("\n").map((line) => line.replace(/^([\u0001\u0002]*)[ \t]+/, "$1").replace(/[ \t]+$/, ""));
  const kept: string[] = [];
  for (const line of lines) {
    // An indent-only line is blank; a quote-only line is a blank line *inside* a quote.
    const blank = line.replace(/\u0001/g, "") === "";
    if (blank && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(blank ? "" : line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/** Parentheses and whitespace would end a Markdown link destination early. */
function linkDestination(url: string): string {
  return url.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export function htmlToMarkdown(html: string, baseUrl?: string): HtmlMarkdown {
  // The layout markers must not occur in page text.
  const tree = parseHtml(html.replace(/[\u0001-\u0003]/g, ""));
  let base: URL | undefined;
  try {
    base = baseUrl ? new URL(baseUrl) : undefined;
  } catch {
    base = undefined;
  }
  let title: string | undefined;
  const findHeadData = (node: ElementNode): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (child.name === "title" && title === undefined) title = inlineText(textContent({ ...child, name: "span" }));
      if (child.name === "base" && child.attrs.get("href")) {
        try {
          base = new URL(child.attrs.get("href")!, base);
        } catch {
          // A malformed <base href> leaves the response URL as the base.
        }
      }
      findHeadData(child);
    }
  };
  findHeadData(tree);
  const ctx: RenderContext = { baseUrl: base, codeBlocks: [] };
  const markdown = normalizeMarkdown(renderChildren(tree.children, ctx))
    .replace(/\u0002/g, "> ")
    .replace(/\u0001/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(new RegExp(`${CODE}(\\d+)${CODE}`, "g"), (_match, index: string) => ctx.codeBlocks[Number(index)] ?? "");
  return { ...(title ? { title } : {}), markdown };
}
