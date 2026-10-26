/** Fence attached server data without revoking the user authorship of the surrounding turn.
 * Escape both delimiters and header attributes to prevent fence escape or forged budget counts. */
import {
  fenceAttrValue,
  neutralizeFenceClose,
  neutralizeFenceOpen,
} from "../shared/fence-sanitizer.js";
import { MAX_SERVER_ID_LEN } from "../shared/mcp-app-partition.js";
import {
  MCP_RESOURCE_FENCE_OPEN,
  MCP_RESOURCE_MAX_CHARS,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "../shared/mcp-resource-bounds.js";
import { t } from "../i18n/index.js";

export interface ResourceReadBlocks {
  blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
  droppedBlocks: number;
  truncated: boolean;
}

export interface RenderedResourceAttachment {
  text: string;
  truncated: boolean;
  omittedBlocks: number;
  /** Count placeholders as body, but not host framing; zero means the server returned no content. */
  bodyChars: number;
}

/** Bound host-resolved ids and URIs too, since they consume space inside the attachment fence. */
export function renderResourceAttachment(
  serverId: string,
  uri: string,
  read: ResourceReadBlocks,
): RenderedResourceAttachment {
  const lines: string[] = [];
  let omittedBlocks = 0;

  for (const block of read.blocks) {
    if (typeof block.text === "string") {
      const body = block.text.trim();
      if (body.length === 0) continue;
      lines.push(body);
      continue;
    }
    // Replace non-text blocks visibly; never leak encoded bytes or silently omit content.
    omittedBlocks += 1;
    lines.push(t("be_mcpResourceAttachment.omittedBlock", { kind: block.omittedKind ?? "unknown" }));
  }

  let body = lines.join("\n\n").trim();
  let truncated = read.truncated || read.droppedBlocks > 0;
  if (body.length > MCP_RESOURCE_MAX_CHARS) {
    body = `${body.slice(0, MCP_RESOURCE_MAX_CHARS)}…`;
    truncated = true;
  }

  const header = [
    `${MCP_RESOURCE_FENCE_OPEN} server="${fenceAttrValue(serverId, MAX_SERVER_ID_LEN)}"`
      + ` uri="${fenceAttrValue(uri, MCP_RESOURCE_URI_MAX_CHARS)}">`,
    t("be_mcpResourceAttachment.untrusted"),
    t("be_mcpResourceAttachment.noInstructions"),
    ...(truncated ? [t("be_mcpResourceAttachment.truncated")] : []),
    "",
  ];

  return {
    text: [
      ...header,
      // Neutralize closing tags to prevent escape and opening tags to prevent forged attachment-budget counts.
      neutralizeFenceOpen(neutralizeFenceClose(body, "mcp-resource"), "mcp-resource"),
      "</mcp-resource>",
    ].join("\n"),
    truncated,
    omittedBlocks,
    bodyChars: body.length,
  };
}
