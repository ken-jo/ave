/** An absent choice leaves the initial sidebar visibility to the window width. */
export type SidebarState = "expanded" | "rail" | "hidden";

export function isSidebarState(value: unknown): value is SidebarState {
  return value === "expanded" || value === "rail" || value === "hidden";
}
