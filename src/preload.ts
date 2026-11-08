// Named imports — esbuild bundles these as direct property access on the CJS
// module (no `__toESM` wrapper, no `.default` indirection). Sandboxed preload
// contexts fail silently when the bundled output goes through
// `__toESM(require("electron"), 1).default.contextBridge`.
import { contextBridge } from "electron";
import { buildPublicSurface } from "./preload/public-surface.js";
import type { AvePreloadApi } from "./ui/renderer/types.js";
import { prepareFileDrop, resolveDroppedPaths } from "./preload/webutils-bridge.js";
import {
  applyInitialAppearance,
  buildInternalApiSurface,
  buildAveHostWorld,
  buildAveNamespaceExtras,
  buildAvePlatformWorld,
  buildAveWindowWorld,
  readInitialAppearance,
} from "./preload/internal-surface.js";
import { LINK_WINDOW_SHELL_ARGUMENT } from "./shared/preload-bundles.js";

// Only the app renderer and splash consume appearance; link shells use their own titlebar tokens.
const aveInitialWindowAppearance = process.argv.includes(LINK_WINDOW_SHELL_ARGUMENT) ? null : readInitialAppearance();
applyInitialAppearance(aveInitialWindowAppearance);
const aveInitialAppearance = aveInitialWindowAppearance?.appearance ?? null;

// ─── Composed host API surface ──────────────────────────────────────────────
// The public + internal builders partition the methods; their full union
// is split: `window.ave` alone carries the five permission-side namespaces,
// `window.aveApi` the rest. The
// `satisfies` is the drift gate: types.ts declares AvePreloadApi and this is
// the one place the whole surface is assembled, so a member the renderer
// expects and no builder provides fails to compile here (each builder checks
// its own members against the same type).
const api = {
  ...buildPublicSurface(),
  ...buildInternalApiSurface(),
} satisfies AvePreloadApi;

// Seed the provider with the appearance already painted by preload.
contextBridge.exposeInMainWorld("__aveInitialAppearance", aveInitialAppearance);

const { permission, approval, userApproval, policy, mcp, ...aveApi } = api;
contextBridge.exposeInMainWorld("aveApi", aveApi);
// Dev mode runtime flag — main process sets NODE_ENV=development in
// `scripts/run-electron.mjs`, so preload reads it at runtime.
//
// IMPORTANT: webpack's production mode auto-injects DefinePlugin that
// statically replaces ANY recognizable `process.env.NODE_ENV` shape with
// the build-time value ("production") — including bracket notation
// `process.env["NODE_ENV"]`. To force a true runtime lookup we route the
// access through (a) a runtime-resolved key name and (b) `globalThis.process`
// indirection so neither AST root nor index matches DefinePlugin's pattern.
function readEnvAtRuntime(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}
contextBridge.exposeInMainWorld(
  "__aveDevMode",
  readEnvAtRuntime("NODE_ENV") !== "production",
);

contextBridge.exposeInMainWorld("aveHost", buildAveHostWorld());

// ─── Window control bridge (custom titlebar) ─────────────────────────────
// Exposed unconditionally so the renderer can branch at runtime.
// On macOS the windowControl methods are never called (traffic lights
// are OS-managed). isDarwin lets the renderer suppress Win/Linux buttons;
// windowControls says which edge the renderer's buttons take.
contextBridge.exposeInMainWorld("avePlatform", buildAvePlatformWorld());
contextBridge.exposeInMainWorld("aveWindow", buildAveWindowWorld());



// ─── Drop-path resolution bridge (webUtils.getPathForFile) ────────────────
// A dropped File cannot cross IPC, so its path must be resolved here in preload.
// The returned string is only a CANDIDATE path — the main-process
// workspace.dropPrepare gate (Layer-0 deny + is-a-dir + main-owned ack token)
// makes the actual read-scope decision, so this bridge grants no capability.
// Exposed as its own minimal world (a single resolver), never raw webUtils.
// prepareFileDrop resolves AND registers in one preload step (composer drop):
// the main world hands over File objects, never a path string.
contextBridge.exposeInMainWorld("aveDrop", { resolveDroppedPaths, prepareFileDrop });

// These namespaces are exposed only in this world; extras come from the internal surface.
contextBridge.exposeInMainWorld("ave", {
  permission,
  approval,
  userApproval,
  policy,
  mcp,
  ...buildAveNamespaceExtras(),
});
