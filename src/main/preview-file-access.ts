import type { IpcMainInvokeEvent, WebFrameMain } from "electron";
import type { IpcDeps } from "../ipc/types.js";
import { validateAppWindowMainFrameSender } from "../ipc/app-window-sender.js";
import { findSessionMainWindowContents } from "./app-state.js";
import { assertReadableFilePath } from "../tools/file-read-core.js";
import { readPermissionSettings } from "../permissions/permission-settings-store.js";
import { buildRuntimeAllowedDirectories } from "../permissions/allowed-directories.js";
import { getProtectedReadDenyFloor, protectedReadDenyMatcher } from "../permissions/asrt-sandbox.js";
import { OBSERVATION_LIMITS } from "../shared/agent-observation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { previewSupportsExternalOpen } from "../shared/preview-external-open.js";

type WindowRegistry = Pick<IpcDeps, "getMainWindow" | "getAppWindows">;
interface PreviewFileOwner {
  event: IpcMainInvokeEvent;
  deps: WindowRegistry;
  keys: Set<string>;
  stop: () => void;
}
interface PreviewFileReceipt { owner: PreviewFileOwner; path: string; sessionId?: string }

const receipts = new Map<string, PreviewFileReceipt>();
const owners = new Map<WebFrameMain, PreviewFileOwner>();

function keyOf(event: IpcMainInvokeEvent, path: string): string {
  return JSON.stringify([event.sender.id, event.senderFrame?.processId, event.senderFrame?.routingId, path]);
}

interface ReadScope { cwd: string; allowed: string[]; floorCovering: (path: string) => string | undefined }

// One snapshot serves every receipt a check visits.
function currentReadScope(): ReadScope {
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd: process.cwd(), allowed: buildRuntimeAllowedDirectories(additional),
    floorCovering: protectedReadDenyMatcher(getProtectedReadDenyFloor()) };
}

function currentScopeCovers(path: string, scope: ReadScope): boolean {
  const verdict = assertReadableFilePath(path, scope.cwd, scope.allowed);
  return verdict.ok && verdict.resolved === path && scope.floorCovering(path) === undefined;
}

function principalIsCurrent(event: IpcMainInvokeEvent, deps: WindowRegistry, path: string, sessionId?: string,
  scope: () => ReadScope = currentReadScope): boolean {
  return validateAppWindowMainFrameSender(event, deps)
    && previewSupportsExternalOpen(path)
    && (sessionId === undefined || findSessionMainWindowContents(sessionId) === event.sender)
    && currentScopeCovers(path, scope());
}

function isCurrent(receipt: PreviewFileReceipt, deps = receipt.owner.deps, scope?: () => ReadScope): boolean {
  return principalIsCurrent(receipt.owner.event, deps, receipt.path, receipt.sessionId, scope);
}

function revoke(key: string): void {
  const receipt = receipts.get(key);
  if (!receipt) return;
  receipts.delete(key);
  const owner = receipt.owner;
  owner.keys.delete(key);
  if (owner.keys.size === 0) {
    owner.stop();
    if (owner.event.senderFrame) owners.delete(owner.event.senderFrame);
  }
}

function ownerFor(event: IpcMainInvokeEvent, deps: WindowRegistry): PreviewFileOwner {
  const frame = event.senderFrame!;
  const existing = owners.get(frame);
  if (existing) return existing;
  const release = (): void => { for (const key of [...owner.keys]) revoke(key); };
  const handleNavigation = (_event: unknown, _url: string, _status: number, _text: string,
    isMainFrame: boolean): void => { if (isMainFrame) release(); };
  const handleNavigationStart = (_event: unknown, _url: string, _inPlace: boolean,
    isMainFrame: boolean): void => { if (isMainFrame) release(); };
  const timer = setInterval(() => {
    let snapshot: ReadScope | undefined;
    const scope = (): ReadScope => snapshot ??= currentReadScope();
    for (const key of [...owner.keys]) {
      const receipt = receipts.get(key);
      if (receipt && !isCurrent(receipt, receipt.owner.deps, scope)) revoke(key);
    }
  }, PREVIEW_DOCUMENT_LIMITS.frameCheckIntervalMs);
  timer.unref();
  const owner: PreviewFileOwner = { event, deps, keys: new Set(), stop: () => {
    clearInterval(timer);
    event.sender.removeListener("destroyed", release);
    event.sender.removeListener("render-process-gone", release);
    event.sender.removeListener("did-frame-navigate", handleNavigation);
    event.sender.removeListener("did-start-navigation", handleNavigationStart);
  } };
  event.sender.on("destroyed", release);
  event.sender.on("render-process-gone", release);
  event.sender.on("did-frame-navigate", handleNavigation);
  event.sender.on("did-start-navigation", handleNavigationStart);
  owners.set(frame, owner);
  return owner;
}

/** Successful preview reads grant only this frame's bounded default-app action. */
export function recordPreviewFileAccess(event: IpcMainInvokeEvent, deps: WindowRegistry, path: string, sessionId?: unknown): void {
  if (!validateAppWindowMainFrameSender(event, deps) || !Number.isSafeInteger(event.sender.id)
    || !Number.isSafeInteger(event.senderFrame?.processId) || !Number.isSafeInteger(event.senderFrame?.routingId)
    || !previewSupportsExternalOpen(path)
    || (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256))) return;
  const session = typeof sessionId === "string" ? sessionId : undefined;
  if (!principalIsCurrent(event, deps, path, session)) return;
  const key = keyOf(event, path);
  revoke(key);
  const owner = ownerFor(event, deps);
  owner.keys.add(key);
  receipts.set(key, { owner, path, ...(session === undefined ? {} : { sessionId: session }) });
  while (receipts.size > OBSERVATION_LIMITS.maxViews) revoke(receipts.keys().next().value!);
}

export function previewFileReadAuthorizes(event: IpcMainInvokeEvent, deps: WindowRegistry, path: string): boolean {
  const key = keyOf(event, path);
  const receipt = receipts.get(key);
  if (!receipt || receipt.owner.event.sender !== event.sender || receipt.owner.event.senderFrame !== event.senderFrame) return false;
  if (!isCurrent(receipt, deps)) { revoke(key); return false; }
  return true;
}
