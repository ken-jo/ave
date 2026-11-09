import type { AXNode } from "./browser-snapshot.js";
import { BROWSER_OUTPUT_MAX_CHARS } from "../../shared/browser-tools.js";

/** Read exposed main-document text; ignored nodes and child frames remain outside the read. */
export function readablePageText(nodes: readonly AXNode[]): { text: string; truncated: boolean } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => node.parentId === undefined || !byId.has(node.parentId));
  const exposed: AXNode[] = [];
  const visited = new Set<string>();
  const collect = (node: AXNode): void => {
    if (visited.has(node.nodeId)) return;
    const role = String(node.role?.value ?? "");
    if (role.toLowerCase() === "iframe" || node !== root && role === "RootWebArea") return;
    visited.add(node.nodeId);
    if (!node.ignored) exposed.push(node);
    for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) collect(child); }
  };
  if (root) collect(root);
  const main = exposed.filter(node => node.role?.value === "main");
  const articles = exposed.filter(node => node.role?.value === "article");
  const starts = main.length ? main : articles.length ? articles : root ? [root] : [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const read = (node: AXNode): void => {
    if (seen.has(node.nodeId) || !visited.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const children = (node.childIds ?? []).map(id => byId.get(id)).filter((child): child is AXNode => child !== undefined && visited.has(child.nodeId));
    const role = String(node.role?.value ?? "");
    const name = node.name?.value;
    if (!node.ignored && typeof name === "string" && (role === "StaticText" || ["heading", "paragraph", "link"].includes(role) && children.length === 0)) {
      const text = name.replace(/\s+/g, " ").trim();
      if (text && lines.at(-1) !== text) lines.push(text);
    }
    for (const child of children) read(child);
  };
  for (const start of starts) read(start);
  const text = lines.join("\n");
  let end = Math.min(text.length, BROWSER_OUTPUT_MAX_CHARS);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] as string)) end--;
  return { text: text.slice(0, end), truncated: end < text.length };
}
