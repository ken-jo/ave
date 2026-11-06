/** Host-owned dock chrome renders each panel through the standard app view. */
import { useEffect, useState } from "react";
import { parsePluginAuthStatus, usePluginAuthRevision, type PluginAuthState } from "./ui/renderer/hooks/use-plugin-auth-status.js";
import { createRoot, type Root } from "react-dom/client";
import { HostAppearanceProvider, type HostAppearance } from "./ui/renderer/theme/HostAppearanceProvider.js";
import { McpAppView } from "./ui/renderer/components/McpAppView.js";
import type { AveDockBridge } from "./floating-dock-preload.js";
import type { McpUiPayload } from "./mcp/types.js";
import type { DockActivity } from "./main/floating-dock.js";

const dock = (window as unknown as { aveDock: AveDockBridge }).aveDock;
function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dock element: ${id}`);
  return node;
}
const roots = new Map<string, Root>();
const panels = new Map<string, { panelId: string; payload: McpUiPayload; authStatusTool?: string }>();
let appearance: HostAppearance | undefined;

function renderPanels(): void {
  if (!appearance) return;
  for (const [id, root] of roots) root.render(<DockAppContent {...panels.get(id)!} appearance={appearance} />);
}

const slots = element("slots");
dock.onActivity((value) => {
  const activity = value as DockActivity | null;
  element("activity").hidden = activity === null;
  element("bar").hidden = typeof activity?.progress !== "number";
  if (!activity) return;
  element("conversation").textContent = activity.conversation;
  element("summary").textContent = activity.summary;
  element("detail").textContent = activity.detail ?? "";
  const fill = document.querySelector<HTMLElement>("#bar > i");
  if (fill && typeof activity.progress === "number") fill.style.width = `${Math.max(0, Math.min(1, activity.progress)) * 100}%`;
});
element("close").addEventListener("click", () => dock.requestClose());
dock.onTheme((value) => {
  const { theme, terminalFontFamily } = value;
  appearance = { ...theme, terminalFontFamily };
  renderPanels();
  const pick = { "--dock-fg": "--ave-fg", "--dock-bg": "--ave-bg-elevated", "--dock-border": "--ave-border", "--dock-accent": "--ave-accent" };
  for (const [name, key] of Object.entries(pick)) {
    const token = theme.tokens[key] ?? (key === "--ave-bg-elevated" ? theme.tokens["--ave-bg"] : undefined);
    if (token) document.documentElement.style.setProperty(name, token);
  }
});
dock.onMount((value) => {
  const slot = value as { panelId: string; title: string; payload: McpUiPayload; authStatusTool?: string; height: number };
  if (roots.has(slot.panelId)) return;
  const container = document.createElement("div");
  container.id = `slot-${slot.panelId}`;
  container.className = "slot";
  container.style.height = `${slot.height}px`;
  const header = document.createElement("div");
  header.className = "slot-head";
  const title = document.createElement("span");
  title.className = "slot-title";
  title.textContent = slot.title;
  header.appendChild(title);
  container.appendChild(header);
  const body = document.createElement("div");
  container.appendChild(body);
  slots.appendChild(container);
  const root = createRoot(body);
  roots.set(slot.panelId, root);
  panels.set(slot.panelId, { panelId: slot.panelId, payload: slot.payload, authStatusTool: slot.authStatusTool });
  renderPanels();
});
dock.onUnmount((value) => {
  const { panelId } = value as { panelId: string };
  roots.get(panelId)?.unmount();
  roots.delete(panelId);
  panels.delete(panelId);
  document.getElementById(`slot-${panelId}`)?.remove();
});
dock.onResize((value) => {
  const { panelId, height } = value as { panelId: string; height: number };
  const container = document.getElementById(`slot-${panelId}`);
  if (container) container.style.height = `${height}px`;
});
dock.onRetitle((value) => {
  const { panelId, title } = value as { panelId: string; title: string };
  const header = document.getElementById(`slot-${panelId}`)?.querySelector(".slot-title");
  if (header) header.textContent = title;
});

const AUTH_STATUS_REFRESH_INTERVAL_MS = 5_000;

/** Host chrome observes its trusted-panel auth source; changed identity retires the app bridge. */
function DockAppContent({ panelId, payload, authStatusTool, appearance }: {
  panelId: string;
  payload: McpUiPayload;
  authStatusTool?: string;
  appearance: HostAppearance;
}) {
  const [authStatus, setAuthStatus] = useState<PluginAuthState | undefined>();
  const authRevision = usePluginAuthRevision(authStatus);
  useEffect(() => {
    if (!authStatusTool) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await dock.readAuthStatus(panelId);
        if (cancelled) return;
        setAuthStatus(parsePluginAuthStatus(status));
      } catch {
        if (!cancelled) setAuthStatus({ kind: "error", message: "Auth status unavailable" });
      } finally { pending = false; }
    };
    const handleRefresh = () => { void refresh(); };
    handleRefresh();
    const timer = window.setInterval(handleRefresh, AUTH_STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", handleRefresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", handleRefresh); };
  }, [panelId, authStatusTool]);
  return <HostAppearanceProvider value={appearance}><McpAppView key={authRevision} payload={payload} /></HostAppearanceProvider>;
}
