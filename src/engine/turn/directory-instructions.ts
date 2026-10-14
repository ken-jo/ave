/**
 * Directory instructions attached on first touch.
 *
 * The launch prompt carries the project's instruction chain down to the
 * project root. A subdirectory can hold its own `AGENTS.md` (or `CLAUDE.md`)
 * for work inside it; loading every one at launch would spend context on
 * directories the session never visits. Instead, when a builtin tool succeeds
 * on a `path` below the project root, the instruction files between the root
 * and that path are appended to the tool's result — once per file per
 * session — framed as project-provided text, like the launch layer.
 */
import { t } from "../../i18n/index.js";
import { discoverDirectoryInstructions } from "../../memory/project-agents-md.js";
import { escapeHtml } from "../../shared/escape-html.js";
import type { ToolSource } from "../../tools/types.js";

/**
 * The instruction block to append to one tool result, or `undefined` when
 * nothing new applies. Records each attached file in `attached`.
 */
export function directoryInstructionsForToolResult(input: {
  projectRoot: string | undefined;
  source: ToolSource | undefined;
  toolInput: unknown;
  isError: boolean;
  attached: Set<string>;
}): string | undefined {
  const { projectRoot, source, toolInput, isError, attached } = input;
  if (!projectRoot || source !== "builtin" || isError) return undefined;
  const path = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>).path
    : undefined;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const layers = discoverDirectoryInstructions(projectRoot, path, attached);
  if (layers.length === 0) return undefined;
  return layers.map((layer) => {
    attached.add(layer.relativePath);
    return [
      `<ave-project-agents-context source="${escapeHtml(layer.relativePath)}" trust="project-provided">`,
      t("be_systemPromptBuilder.directoryAgentsContextIntro", { path: layer.relativePath }),
      t("be_systemPromptBuilder.projectAgentsContextProvenance"),
      "",
      layer.content,
      ...(layer.truncated ? ["", t("be_systemPromptBuilder.projectAgentsContextTruncated")] : []),
      "</ave-project-agents-context>",
    ].join("\n");
  }).join("\n\n");
}
