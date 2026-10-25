// Share one markdown configuration across chat surfaces; singleTilde:false preserves literal ranges such as 7~12℃.

import remarkGfm from "remark-gfm";
import type { Options } from "react-markdown";

type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
};

export function remarkKoreanAdjacentStrong() {
  return (tree: MarkdownNode) => {
    transformChildren(tree);
  };
}

function transformChildren(node: MarkdownNode): void {
  if (!node.children) return;
  const next: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitLiteralStrong(child.value));
      continue;
    }
    transformChildren(child);
    next.push(child);
  }
  node.children = next;
}

function splitLiteralStrong(value: string): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let cursor = 0;
  let changed = false;

  const appendText = (text: string) => {
    if (text.length > 0) out.push({ type: "text", value: text });
  };

  while (cursor < value.length) {
    const start = value.indexOf("**", cursor);
    if (start < 0) break;
    const end = value.indexOf("**", start + 2);
    if (end < 0) break;

    const inner = value.slice(start + 2, end);
    if (!inner.trim() || inner.trim() !== inner) {
      appendText(value.slice(cursor, start + 2));
      cursor = start + 2;
      continue;
    }

    appendText(value.slice(cursor, start));
    out.push({
      type: "strong",
      children: [{ type: "text", value: inner }],
    });
    cursor = end + 2;
    changed = true;
  }

  if (!changed) return [{ type: "text", value }];
  appendText(value.slice(cursor));
  return out;
}

// Use the type from `react-markdown` (a direct dependency) rather than `unified` (a transitive one) so the package
// boundary stays clean.
export const MARKDOWN_REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  remarkKoreanAdjacentStrong,
];
