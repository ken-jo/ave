import { hasOnlyKeys, isRecord } from "./is-record.js";

export const BROWSER_NATIVE_HOLE_ATTRIBUTE = "data-ave-native-page";
export const BROWSER_NATIVE_CURSOR_MAX_BYTES = 262144;
export const BROWSER_NATIVE_CURSOR_MAX_SIZE = 128;
export const BROWSER_NATIVE_CURSOR_MAX_SOURCE_SIZE = 1024;
export type BrowserNativeInputModifier = "shift" | "control" | "alt" | "meta" | "leftbuttondown" | "middlebuttondown" | "rightbuttondown";
export const BROWSER_NATIVE_CURSORS = ["auto", "default", "crosshair", "pointer", "text", "wait", "help", "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize", "ns-resize", "ew-resize", "nesw-resize", "nwse-resize", "col-resize", "row-resize", "move", "vertical-text", "cell", "context-menu", "alias", "progress", "no-drop", "copy", "none", "not-allowed", "zoom-in", "zoom-out", "grab", "grabbing", "all-scroll"] as const;
export type BrowserNativeCursor = typeof BROWSER_NATIVE_CURSORS[number];

export interface BrowserNativeInput {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseWheel" | "mouseLeave";
  readonly x: number;
  readonly y: number;
  readonly button: "left" | "middle" | "right";
  readonly clickCount: number;
  readonly modifiers: BrowserNativeInputModifier[];
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export type BrowserNativeInputState = Pick<BrowserNativeInput, "tabId" | "webContentsId" | "epoch"> & (
  | { readonly type: "cancel"; readonly sequence: number }
  | { readonly type: "cursor"; readonly cursor: BrowserNativeCursor }
  | { readonly type: "custom-cursor"; readonly dataUrl: string; readonly width: number; readonly height: number; readonly hotspot: { readonly x: number; readonly y: number } }
);

const INPUT_TYPES = ["mouseDown", "mouseUp", "mouseMove", "mouseWheel", "mouseLeave"];
const INPUT_MODIFIERS: readonly BrowserNativeInputModifier[] = ["shift", "control", "alt", "meta", "leftbuttondown", "middlebuttondown", "rightbuttondown"];

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cursorPngMatches(dataUrl: string, width: number, height: number): boolean {
  try {
    const encoded = dataUrl.slice(22);
    const bytes = atob(encoded);
    if (bytes.length < 45 || bytes.length > BROWSER_NATIVE_CURSOR_MAX_BYTES || btoa(bytes) !== encoded) return false;
    if (![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((byte, index) => bytes.charCodeAt(index) === byte)) return false;
    const dimension = (offset: number) => ((bytes.charCodeAt(offset) << 24) | (bytes.charCodeAt(offset + 1) << 16)
      | (bytes.charCodeAt(offset + 2) << 8) | bytes.charCodeAt(offset + 3)) >>> 0;
    return dimension(16) === width && dimension(20) === height;
  } catch { return false; }
}

/** Validate the private preload's pointer envelope independently of its DOM hit test. */
export function parseBrowserNativeInput(value: unknown): BrowserNativeInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tabId", "webContentsId", "epoch", "sequence", "type", "x", "y", "button", "clickCount", "modifiers", "deltaX", "deltaY"])
    || typeof value.tabId !== "string" || value.tabId.length === 0 || value.tabId.length > 200
    || !isPositiveInteger(value.webContentsId) || !isPositiveInteger(value.epoch) || !isPositiveInteger(value.sequence)
    || !INPUT_TYPES.includes(String(value.type)) || !isCoordinate(value.x) || !isCoordinate(value.y)
    || !["left", "middle", "right"].includes(String(value.button))
    || !Number.isSafeInteger(value.clickCount) || (value.clickCount as number) < 0 || (value.clickCount as number) > 3
    || !Array.isArray(value.modifiers) || value.modifiers.length > INPUT_MODIFIERS.length
    || !value.modifiers.every(modifier => typeof modifier === "string" && INPUT_MODIFIERS.some(allowed => allowed === modifier))
    || new Set(value.modifiers).size !== value.modifiers.length) return null;
  if (value.type === "mouseWheel") {
    if (!isCoordinate(value.deltaX) || !isCoordinate(value.deltaY)) return null;
  } else if (value.deltaX !== undefined || value.deltaY !== undefined) return null;
  return {
    tabId: value.tabId, webContentsId: value.webContentsId, epoch: value.epoch, sequence: value.sequence,
    type: value.type as BrowserNativeInput["type"], x: value.x, y: value.y,
    button: value.button as BrowserNativeInput["button"], clickCount: value.clickCount as number,
    modifiers: [...value.modifiers] as BrowserNativeInputModifier[],
    ...(value.type === "mouseWheel" ? { deltaX: value.deltaX as number, deltaY: value.deltaY as number } : {}),
  };
}

export function parseBrowserNativeInputState(value: unknown): BrowserNativeInputState | null {
  if (!isRecord(value) || typeof value.tabId !== "string" || value.tabId.length === 0 || value.tabId.length > 200
    || !isPositiveInteger(value.webContentsId) || !isPositiveInteger(value.epoch)) return null;
  const identity = { tabId: value.tabId, webContentsId: value.webContentsId, epoch: value.epoch };
  if (value.type === "cancel" && hasOnlyKeys(value, ["type", "tabId", "webContentsId", "epoch", "sequence"]) && isPositiveInteger(value.sequence)) {
    return { ...identity, type: "cancel", sequence: value.sequence };
  }
  if (value.type === "cursor" && hasOnlyKeys(value, ["type", "tabId", "webContentsId", "epoch", "cursor"])) {
    const cursor = BROWSER_NATIVE_CURSORS.find(cursor => cursor === value.cursor);
    if (cursor) return { ...identity, type: "cursor", cursor };
  }
  if (value.type === "custom-cursor" && hasOnlyKeys(value, ["type", "tabId", "webContentsId", "epoch", "dataUrl", "width", "height", "hotspot"])
    && typeof value.dataUrl === "string" && value.dataUrl.length <= Math.ceil(BROWSER_NATIVE_CURSOR_MAX_BYTES / 3) * 4 + 22
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl)
    && (value.dataUrl.length - 22) % 4 === 0
    && (value.dataUrl.length - 22) / 4 * 3 - (value.dataUrl.endsWith("==") ? 2 : value.dataUrl.endsWith("=") ? 1 : 0) <= BROWSER_NATIVE_CURSOR_MAX_BYTES
    && isPositiveInteger(value.width) && value.width <= BROWSER_NATIVE_CURSOR_MAX_SIZE
    && isPositiveInteger(value.height) && value.height <= BROWSER_NATIVE_CURSOR_MAX_SIZE
    && isRecord(value.hotspot) && hasOnlyKeys(value.hotspot, ["x", "y"])
    && Number.isSafeInteger(value.hotspot.x) && (value.hotspot.x as number) >= 0 && (value.hotspot.x as number) < value.width
    && Number.isSafeInteger(value.hotspot.y) && (value.hotspot.y as number) >= 0 && (value.hotspot.y as number) < value.height
    && cursorPngMatches(value.dataUrl, value.width, value.height)) {
    return { ...identity, type: "custom-cursor", dataUrl: value.dataUrl, width: value.width, height: value.height,
      hotspot: { x: value.hotspot.x as number, y: value.hotspot.y as number } };
  }
  return null;
}
