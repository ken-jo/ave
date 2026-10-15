import { t } from "../../../i18n/runtime.js";

/** Human-readable display name keys for LLM tool identifiers. */
const TOOL_DISPLAY_KEYS: Record<string, string> = {
  // Tasks
  task_add: "toolDisplay.taskAdd",
  task_list: "toolDisplay.taskList",
  task_update: "toolDisplay.taskUpdate",
  task_delete: "toolDisplay.taskDelete",
  task_today: "toolDisplay.taskToday",
  task_overdue: "toolDisplay.taskOverdue",
  session_tasks: "toolDisplay.sessionTasks",
  routine_schedule: "toolDisplay.routineSchedule",

  agent_spawn: "toolDisplay.agentSpawn",

  // Web / Search
  web_search: "toolDisplay.webSearch",
  web_fetch: "toolDisplay.webFetch",

  // System
  bash: "toolDisplay.bash",
  powershell: "toolDisplay.powershell",
  read_file: "toolDisplay.readFile",
  list_files: "toolDisplay.listFiles",
  glob_files: "toolDisplay.globFiles",
  grep_files: "toolDisplay.grepFiles",
  write_file: "toolDisplay.writeFile",
  edit_file: "toolDisplay.editFile",
  multi_edit: "toolDisplay.editFile",
  apply_patch: "toolDisplay.applyPatch",
  move_file: "toolDisplay.moveFile",
  delete_file: "toolDisplay.deleteFile",
  request_plugin: "toolDisplay.requestPlugin",
  read_tool_result_chunk: "toolDisplay.readToolResultChunk",

  // Misc
  skill_load: "toolDisplay.skillLoad",
  skill_read: "toolDisplay.skillRead",
  skill_list: "toolDisplay.skillList",
  ask_user_question: "toolDisplay.askUserQuestion",
  noop: "toolDisplay.noop",
};

export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_KEYS[toolName]) return t(TOOL_DISPLAY_KEYS[toolName]);
  // Unknown tool names render as readable text (underscores -> spaces).
  return toolName.replace(/_/g, " ");
}

/**
 * Label for ONE tool call row: the display name, plus the call's subject where
 * the subject is what the user needs to see. Reading a skill is the visible
 * progressive-disclosure step, so the row names the skill ("Read skill ·
 * email-polish") instead of a bare "Read skill".
 */
export function getToolCallLabel(toolName: string, input: unknown): string {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const skillName = typeof args.skillName === "string" ? args.skillName.trim() : "";
  if (toolName === "skill_load" && skillName) {
    return t("toolDisplay.skillLoadNamed", { name: skillName });
  }
  const resourcePath = typeof args.resourcePath === "string" ? args.resourcePath.trim() : "";
  if (toolName === "skill_read" && skillName && resourcePath) {
    return t("toolDisplay.skillReadNamed", { name: skillName, path: resourcePath });
  }
  return getToolDisplayName(toolName);
}

/**
 * Replace tool code-names (e.g. `web_search`) with their Korean display names
 * inside free-form LLM response text.  Code spans and fenced code blocks are
 * left untouched so code examples are never mangled.
 * Only underscore-containing names are replaced — single-word names like
 * `bash` are excluded to avoid false positives in normal prose.
 */
export function replaceToolNamesInText(text: string): string {
  // Split into alternating [prose, code-block, prose, …] segments.
  // Regex captures both fenced blocks (``` … ```) and inline backtick spans.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg; // code segment — leave as-is
      let out = seg;
      for (const [code, key] of Object.entries(TOOL_DISPLAY_KEYS)) {
        if (!code.includes("_")) continue; // single-word names → skip (unsafe to replace in prose)
        out = out.replace(new RegExp(`\\b${code}\\b`, "g"), t(key));
      }
      return out;
    })
    .join("");
}
