/** Render bounded server-authored prompt data with placeholders for non-text blocks and dedicated provenance. */

import {
  MCP_PROMPT_MAX_BLOCKS,
  MCP_PROMPT_MAX_CHARS,
} from "../shared/mcp-prompt-bounds.js";

export interface McpPromptBlock {
  role: string;
  type: string;
  text?: string;
}

export interface RenderedMcpPrompt {
  text: string;
  truncated: boolean;
  omittedBlocks: number;
}

function safeRole(role: string): string {
  // Role labels are inert annotations, never trust signals; the outer envelope carries provenance.
  const cleaned = role.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function renderMcpPrompt(
  blocks: readonly McpPromptBlock[],
  description?: string,
): RenderedMcpPrompt {
  const lines: string[] = [];
  let truncated = false;
  let omittedBlocks = 0;

  if (typeof description === "string" && description.trim().length > 0) {
    lines.push(`prompt: ${description.trim()}`);
    lines.push("");
  }

  const considered = blocks.slice(0, MCP_PROMPT_MAX_BLOCKS);
  if (considered.length < blocks.length) truncated = true;

  for (const block of considered) {
    const role = safeRole(block.role);
    if (block.type === "text" && typeof block.text === "string") {
      const body = block.text.trim();
      if (body.length === 0) continue;
      lines.push(`[${role}] ${body}`);
      continue;
    }
    omittedBlocks += 1;
    lines.push(`[${role}] (omitted ${safeRole(block.type)} content — not rendered as text)`);
  }

  let text = lines.join("\n").trim();
  if (text.length > MCP_PROMPT_MAX_CHARS) {
    text = `${text.slice(0, MCP_PROMPT_MAX_CHARS)}…`;
    truncated = true;
  }
  return { text, truncated, omittedBlocks };
}
