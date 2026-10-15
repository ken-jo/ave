/**
 * Names of the agent browser tools (src/tools/browser-tools.ts).
 *
 * One list, read by the tool factory that registers them and by the rule
 * classifier that grades them, so a renamed tool cannot silently fall out of
 * its risk rule.
 */
export const BROWSER_TOOL = {
  tabs: "browser_tabs",
  snapshot: "browser_snapshot",
  screenshot: "browser_screenshot",
  wait: "browser_wait",
  navigate: "browser_navigate",
  click: "browser_click",
  type: "browser_type",
  pressKey: "browser_press_key",
  tabNew: "browser_tab_new",
  tabClose: "browser_tab_close",
} as const;

export type BrowserToolName = (typeof BROWSER_TOOL)[keyof typeof BROWSER_TOOL];

const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(BROWSER_TOOL));

/** The browser tools that send the page to a model-chosen URL. */
const BROWSER_URL_TOOL_NAMES: ReadonlySet<string> = new Set([BROWSER_TOOL.navigate, BROWSER_TOOL.tabNew]);

export function isBrowserToolName(name: string): name is BrowserToolName {
  return BROWSER_TOOL_NAMES.has(name);
}

export function isBrowserUrlToolName(name: string): boolean {
  return BROWSER_URL_TOOL_NAMES.has(name);
}
