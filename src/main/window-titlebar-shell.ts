// Auth and link shells share this HTML/CSS titlebar contract because they do not mount the app’s component tree. Use OS light/dark preference to avoid a
// bright flash while keeping shell rendering independent of theme IPC.

import { t } from "../i18n/index.js";
import { WINDOW_CONTROL_BUTTON_WIDTH, windowControlsPlacement } from "../shared/shell-geometry.js";

export const TITLEBAR_COLORS = {
  light: { background: "#f3f2ed", foreground: "#1c1917" },
  dark: { background: "#312d2b", foreground: "#f5f2ea" },
} as const;

export interface TitlebarShellOptions {
  // Process platform — drives macOS hidden-inset vs Win/Linux full titlebar.
  platform: NodeJS.Platform;
  // Window title — shown next to controls on Win/Linux, hidden on macOS.
  title: string;
}

// Render the titlebar root <div>. macOS gets a 36px drag-only strip (matches Win/Linux height so chrome looks consistent and OS traffic lights center
// cleanly); Windows gets a full bar with title + min/max/close trailing; Linux puts close/min/max first, as the main window's band does
// (`windowControlsPlacement` in shared/shell-geometry.ts).
export function buildTitlebarHtml({ platform }: TitlebarShellOptions): string {
  const placement = windowControlsPlacement(platform);
  if (placement === "native") {
    return `<div class="titlebar titlebar-mac" id="titlebar"></div>`;
  }
  const minimize = `<button class="titlebar-btn" id="minimize" title="${t("be_windowTitlebarShell.minimize")}" aria-label="${t("be_windowTitlebarShell.minimize")}">
        <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>
      </button>`;
  const maximize = `<button class="titlebar-btn" id="maximize" title="${t("be_windowTitlebarShell.maximize")}" aria-label="${t("be_windowTitlebarShell.maximize")}">
        <svg id="max-icon" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>`;
  const close = `<button class="titlebar-btn titlebar-btn-close" id="close" title="${t("be_windowTitlebarShell.close")}" aria-label="${t("be_windowTitlebarShell.close")}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`;
  const title = `<div class="title" id="title"></div>`;
  if (placement === "leading") {
    return `<div class="titlebar titlebar-leading" id="titlebar">
    <div class="controls">${close}${minimize}${maximize}</div>
    ${title}
  </div>`;
  }
  return `<div class="titlebar" id="titlebar">
    ${title}
    <div class="controls">${minimize}${maximize}${close}</div>
  </div>`;
}

// Emit shared shell tokens and layout primitives. Native overlay controls use the same background and foreground values.
export function buildTitlebarCss(): string {
  return `
    :root {
      --ts-bg:              ${TITLEBAR_COLORS.light.background};
      --ts-fg:              ${TITLEBAR_COLORS.light.foreground};
      --ts-btn:             hsl(24 8% 32%);
      --ts-btn-hover-bg:    hsl(35 14% 84% / 0.8);
      --ts-btn-close-hover: hsl(0 72% 51%);
      --ts-webview-bg:      white;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ts-bg:              ${TITLEBAR_COLORS.dark.background};
        --ts-fg:              ${TITLEBAR_COLORS.dark.foreground};
        --ts-btn:             hsl(40 8% 68%);
        --ts-btn-hover-bg:    hsl(20 6% 24%);
        --ts-btn-close-hover: hsl(0 72% 56%);
        --ts-webview-bg:      hsl(0 0% 15%);
      }
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      display: flex;
      flex-direction: column;
      background: var(--ts-bg);
      color: var(--ts-fg);
      /* Mirrors HOST_FONT_STACK (src/shared/host-font-stack.ts) — issue #556 */
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
    }
    .titlebar {
      height: 36px;
      flex: 0 0 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      /* No bottom rule, as on the main window's band. */
      background: var(--ts-bg);
      color: var(--ts-fg);
      user-select: none;
      -webkit-app-region: drag;
    }
    .titlebar-leading { justify-content: flex-start; }
    .titlebar-leading .title { padding-right: 12px; }
    .titlebar-mac {
      height: 36px;
      flex: 0 0 36px;
      background: transparent;
    }
    .title {
      min-width: 0;
      padding-left: 12px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 600;
      opacity: .82;
    }
    .controls {
      height: 100%;
      display: flex;
      align-items: stretch;
      -webkit-app-region: no-drag;
    }
    .titlebar-btn {
      width: ${WINDOW_CONTROL_BUTTON_WIDTH}px;
      height: 36px;
      border: 0;
      border-radius: 0;
      display: grid;
      place-items: center;
      background: transparent;
      color: var(--ts-btn);
      cursor: default;
    }
    .titlebar-btn:hover { background: var(--ts-btn-hover-bg); color: var(--ts-fg); }
    .titlebar-btn-close:hover { background: var(--ts-btn-close-hover); color: white; }
    .titlebar-btn svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    webview {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      border: 0;
      background: var(--ts-webview-bg);
    }
  `;
}

// JS string that wires the titlebar buttons (minimize/maximize/close) to `window.aveWindow.*` preload bridge. Caller is responsible for loading this
// inside its own `<script>` tag along with any window- specific JS. macOS skips this (no buttons rendered).
export function buildTitlebarButtonScript({ platform }: TitlebarShellOptions): string {
  const isMac = platform === "darwin";
  if (isMac) {
    return `
      document.getElementById("titlebar")?.addEventListener("dblclick", (event) => {
        if (event.target.closest && event.target.closest("button")) return;
        window.aveWindow?.toggleMaximize();
      });
    `;
  }
  return `
    document.getElementById("minimize").addEventListener("click", () => window.aveWindow?.minimize());
    document.getElementById("maximize").addEventListener("click", () => window.aveWindow?.toggleMaximize());
    document.getElementById("close").addEventListener("click", () => window.aveWindow?.close());
    window.aveWindow?.onMaximizedChanged?.((maximized) => {
      const btn = document.getElementById("maximize");
      btn.title = maximized ? "${t("be_windowTitlebarShell.restore")}" : "${t("be_windowTitlebarShell.maximize")}";
      btn.setAttribute("aria-label", btn.title);
    });
    document.getElementById("titlebar").addEventListener("dblclick", (event) => {
      if (event.target.closest && event.target.closest("button")) return;
      window.aveWindow?.toggleMaximize();
    });
  `;
}
