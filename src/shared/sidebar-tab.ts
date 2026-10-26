/**
 * Legacy sidebar preference retained for persisted-settings compatibility.
 * The sidebar now shows both sections; only settings validation consumes this
 * value set.
 */
export type SidebarTab = "chats" | "projects";

const SIDEBAR_TABS: readonly SidebarTab[] = ["chats", "projects"];

export const DEFAULT_SIDEBAR_TAB: SidebarTab = "chats";

export function isSidebarTab(value: unknown): value is SidebarTab {
  return typeof value === "string" && (SIDEBAR_TABS as readonly string[]).includes(value);
}
