/** The renderer's live view of the shortcut registry: the user's bindings as last broadcast by the host, and the one
 * matcher every key handler goes through. Handlers keep their own focus guards; this only answers "is this the key for
 * that command right now". */
import { useCallback, useSyncExternalStore } from "react";
import {
  formatAccelerator,
  matchesAccelerator,
  NO_SHORTCUT_OVERRIDES,
  resolveShortcut,
  type ShortcutId,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
  type ShortcutResolutionInput,
} from "../../../shared/shortcuts.js";
import { isDarwin } from "../api-client.js";
import type { AppSettings } from "../types.js";
import { type SettingsSnapshotApi, useSettingsSnapshot } from "./use-settings-snapshot.js";

let current: ShortcutResolutionInput = NO_SHORTCUT_OVERRIDES;
const listeners = new Set<() => void>();
let captureActive = false;

export function rendererShortcutPlatform(): ShortcutPlatform {
  return isDarwin() ? "darwin" : "other";
}

/** Adopt the bindings from a settings snapshot. */
export function setShortcutSettings(next: ShortcutResolutionInput): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getShortcutSettings(): ShortcutResolutionInput {
  return current;
}

/** While the settings page records a new binding, no command may fire: the press is the new key, not a request. A
 * capture-phase recorder cannot stop the app's own capture-phase listeners registered before it, so the matcher itself
 * goes quiet. */
export function setShortcutCaptureActive(active: boolean): void {
  captureActive = active;
}

export function isShortcutCaptureActive(): boolean {
  return captureActive;
}

export function shortcutAccelerator(id: ShortcutId): string | null {
  return resolveShortcut(id, current, rendererShortcutPlatform());
}

export function matchesShortcut(id: ShortcutId, event: ShortcutKeyEvent): boolean {
  if (captureActive) return false;
  const platform = rendererShortcutPlatform();
  return matchesAccelerator(resolveShortcut(id, current, platform), event, platform);
}

/** The binding as the platform writes it ("⌘K" / "Ctrl+K"), or null when the command has no key. */
export function shortcutHint(id: ShortcutId): string | null {
  const accelerator = shortcutAccelerator(id);
  return accelerator === null ? null : formatAccelerator(accelerator, rendererShortcutPlatform());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-render when the user's bindings change. */
export function useShortcutSettings(): ShortcutResolutionInput {
  return useSyncExternalStore(subscribe, getShortcutSettings, getShortcutSettings);
}

export function useShortcutHint(id: ShortcutId): string | null {
  useShortcutSettings();
  return shortcutHint(id);
}

/** "Label  ⌘K" for a palette row, or the bare label when the command has no key. */
export function withShortcutHint(label: string, id: ShortcutId, input: ShortcutResolutionInput = current): string {
  const platform = rendererShortcutPlatform();
  const accelerator = resolveShortcut(id, input, platform);
  return accelerator === null ? label : `${label}  ${formatAccelerator(accelerator, platform)}`;
}

function shortcutInputFromSettings(settings: AppSettings): ShortcutResolutionInput {
  const shortcuts = settings.shortcuts;
  return { bindings: shortcuts.bindings, toggleWindow: shortcuts.toggleWindow, enabled: shortcuts.enabled };
}

/** Keep the store on the host's settings: the first snapshot, then every broadcast. Mounted once per window. */
export function useShortcutSettingsSync(api: SettingsSnapshotApi): void {
  const apply = useCallback((settings: AppSettings) => setShortcutSettings(shortcutInputFromSettings(settings)), []);
  useSettingsSnapshot(api, apply);
}

/** @internal test-only */
export function __resetShortcutsForTest(): void {
  current = NO_SHORTCUT_OVERRIDES;
  captureActive = false;
  listeners.clear();
}
