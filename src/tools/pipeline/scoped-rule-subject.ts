import type { Tool } from "../base.js";
import { isCanonicalFileTool } from "../file-tools.js";
import { isCanonicalWebFetchTool } from "../web-fetch.js";
import { selectDeclaredPathValues } from "../../shared/dotted-field-value.js";
import type { ScopedRuleSubject } from "../../permissions/rules/scoped-rule-matcher.js";

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/** Only host-created identities may supply a privileged rule subject. */
export function scopedRuleSubjectFor(tool: Tool, input: Record<string, unknown>, cwd: string, targets?: readonly { filePath: string; canonicalPath: string }[]): ScopedRuleSubject | undefined {
  if (isCanonicalFileTool(tool) && EDIT_TOOL_NAMES.has(tool.name)) {
    const paths = (tool.pathFields ?? []).flatMap((field) => selectDeclaredPathValues(input, field))
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return { kind: "edit", paths, cwd, ...(targets === undefined ? {} : { targets }) };
  }
  if (isCanonicalWebFetchTool(tool) && typeof input.url === "string") {
    return { kind: "webfetch", url: input.url, privateNetwork: input.allowPrivateNetwork === true };
  }
  if (tool.source === "mcp" && tool.mcpServerId) {
    return { kind: "mcp", server: tool.mcpServerId, tool: tool.mcpRuleIdentity?.tool ?? tool.name, nonDestructive: tool.mcpRuleIdentity?.nonDestructive === true };
  }
  return undefined;
}
