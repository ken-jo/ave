/** Share prompt limits across discovery, main handlers, and forms without process-specific imports. */

/** Prompt names enter audit rows and chrome. */
export const MCP_PROMPT_NAME_MAX_CHARS = 128;
/** Argument names must match handler filtering and form fields. */
export const MCP_PROMPT_ARG_NAME_MAX_CHARS = 64;
/** Bound argument values in both form and main. */
export const MCP_PROMPT_ARG_VALUE_MAX_CHARS = 4 * 1024;
/** Bound rendered text so one prompt cannot flood a turn. */
export const MCP_PROMPT_MAX_CHARS = 16 * 1024;
export const MCP_PROMPT_MAX_BLOCKS = 64;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Reject invalid, control-bearing, and prototype-key names before rendering or indexing objects. */
export function isUsablePromptName(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !CONTROL_CHARS_RE.test(value)
  );
}
